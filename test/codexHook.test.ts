import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDiskHydrator } from "../src/flush/diskHydration.js";
import { SyncServer } from "../src/server/syncServer.js";

const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const CLI = join(process.cwd(), "src", "cli", "index.ts");
const ORIGINAL = "const A = 1;\nconst HEADER = 34;\nconst B = 2;\n";

function runHook(
  mode: "pre" | "post",
  workspace: string,
  serverUrl: string,
  toolUseId: string,
  session: string,
  toolName = "apply_patch",
  command = "*** Begin Patch\n*** Update File: src/app.js\n*** End Patch",
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [TSX_CLI, CLI, "_hook", "codex", mode],
      { cwd: workspace, env: { ...process.env, AGENT_SYNC_SERVER: serverUrl } },
      (error, stdout, stderr) =>
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin?.end(
      JSON.stringify({
        session_id: session,
        tool_use_id: toolUseId,
        cwd: workspace,
        tool_name: toolName,
        tool_input: { command },
      }),
    );
  });
}

async function statusServer(statusCode: number, body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json");
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe("Codex hook bridge", () => {
  let server: SyncServer;
  let canonical: string;
  let a: string;
  let b: string;
  let url: string;

  const makeWorkspace = () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "asp-codex-hook-")));
    execFileSync("git", ["init", "-q", directory]);
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "src", "app.js"), ORIGINAL);
    return directory;
  };

  beforeEach(() => {
    canonical = makeWorkspace();
    a = makeWorkspace();
    b = makeWorkspace();
    server = new SyncServer(0, { hydrate: createDiskHydrator(canonical) });
    url = `ws://localhost:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    for (const directory of [canonical, a, b]) rmSync(directory, { recursive: true, force: true });
  });

  it("syncs apply_patch changes and rejects a stale conflicting patch", async () => {
    expect((await runHook("pre", a, url, "a1", "sa")).code).toBe(0);
    writeFileSync(join(a, "src", "app.js"), ORIGINAL.replace("HEADER = 34", "HEADER = 20"));
    expect((await runHook("post", a, url, "a1", "sa")).code).toBe(0);
    expect(server.getDocContent("src/app.js")).toContain("HEADER = 20");

    expect((await runHook("pre", b, url, "b1", "sb")).code).toBe(0);
    expect(readFileSync(join(b, "src", "app.js"), "utf8")).toContain("HEADER = 20");

    expect((await runHook("pre", a, url, "a2", "sa")).code).toBe(0);
    writeFileSync(
      join(a, "src", "app.js"),
      readFileSync(join(a, "src", "app.js"), "utf8").replace("HEADER = 20", "HEADER = 21"),
    );
    expect((await runHook("post", a, url, "a2", "sa")).code).toBe(0);

    writeFileSync(
      join(b, "src", "app.js"),
      readFileSync(join(b, "src", "app.js"), "utf8").replace("HEADER = 20", "HEADER = 15"),
    );
    const rejected = await runHook("post", b, url, "b1", "sb");
    expect(rejected.code).toBe(2);
    expect(rejected.stderr).toContain("src/app.js");
    expect(rejected.stderr).toContain("agent-sync codex PostToolUse failed for apply_patch");
    expect(server.getDocContent("src/app.js")).toContain("HEADER = 21");
    expect(readFileSync(join(b, "src", "app.js"), "utf8")).toContain("HEADER = 21");
  }, 90_000);

  it("refreshes shared files before any Codex local read tool without requiring a post snapshot", async () => {
    expect((await runHook("pre", a, url, "write-1", "sa")).code).toBe(0);
    writeFileSync(join(a, "src", "app.js"), ORIGINAL.replace("HEADER = 34", "HEADER = 73"));
    expect((await runHook("post", a, url, "write-1", "sa")).code).toBe(0);

    const toolName = "mcp__filesystem__read_file";
    const refreshed = await runHook("pre", b, url, "read-1", "sb", toolName);
    expect(refreshed.code).toBe(0);
    expect(readFileSync(join(b, "src", "app.js"), "utf8")).toContain("HEADER = 73");
    expect((await runHook("post", b, url, "read-1", "sb", toolName)).code).toBe(0);
  }, 60_000);

  it("fails closed with actionable Codex feedback when status discovery is unavailable or invalid", async () => {
    const unavailable = await statusServer(200, JSON.stringify({ rooms: [] }));
    const unavailableUrl = unavailable.url;
    await unavailable.close();

    const fixtures = [
      { label: "unreachable", url: unavailableUrl, expected: "cannot query sync status", close: async () => undefined },
      { label: "non-2xx", expected: "HTTP 503", ...(await statusServer(503, JSON.stringify({ error: "unavailable" }))) },
      { label: "invalid JSON", expected: "not valid JSON", ...(await statusServer(200, "not-json")) },
      { label: "malformed rooms", expected: "does not contain a rooms array", ...(await statusServer(200, JSON.stringify({ rooms: "invalid" }))) },
    ];

    try {
      for (const fixture of fixtures) {
        const result = await runHook("pre", a, fixture.url, `read-${fixture.label}`, "sa", "mcp__filesystem__read_file");
        expect(result.code, fixture.label).toBe(2);
        expect(result.stderr, fixture.label).toContain("agent-sync codex PreToolUse failed for mcp__filesystem__read_file");
        expect(result.stderr, fixture.label).toContain(fixture.expected);
        expect(result.stderr, fixture.label).not.toContain("hook warning");
      }
    } finally {
      await Promise.all(fixtures.map((fixture) => fixture.close()));
    }
  }, 60_000);

  it("syncs an edit whose initial snapshot anchor appears repeatedly", async () => {
    const repeated = "12345678VALUE87654321";
    const before = `first block\n${repeated}\nsecond block\n${repeated}\n`;
    const target = before.lastIndexOf("VALUE");
    const after = `${before.slice(0, target)}CHANGED${before.slice(target + "VALUE".length)}`;
    writeFileSync(join(canonical, "src", "app.js"), before);
    writeFileSync(join(a, "src", "app.js"), before);

    expect((await runHook("pre", a, url, "repeated-1", "sa")).code).toBe(0);
    writeFileSync(join(a, "src", "app.js"), after);
    const published = await runHook("post", a, url, "repeated-1", "sa");

    expect(published.code).toBe(0);
    expect(published.stderr).toBe("");
    expect(server.getDocContent("src/app.js")).toBe(after);
    expect(readFileSync(join(a, "src", "app.js"), "utf8")).toBe(after);
  }, 60_000);

  it("syncs new files but excludes Codex hook configuration", async () => {
    mkdirSync(join(a, ".codex"), { recursive: true });
    writeFileSync(join(a, ".codex", "hooks.json"), "{}");
    expect((await runHook("pre", a, url, "a1", "sa")).code).toBe(0);
    writeFileSync(join(a, "src", "made.js"), "made();\n");
    writeFileSync(join(a, ".codex", "hooks.json"), "{\"changed\":true}");
    expect((await runHook("post", a, url, "a1", "sa")).code).toBe(0);
    expect(server.getDocNames()).toEqual(["src/made.js"]);
    expect(server.getDocContent("src/made.js")).toBe("made();\n");
  }, 60_000);

  it("materializes shared LF content with the configured CRLF disk style", async () => {
    writeFileSync(join(a, ".agent-sync.yml"), "line_endings: crlf\n");
    server.preloadDocNames(["src/app.js"]);

    expect((await runHook("pre", a, url, "crlf-1", "sa")).code).toBe(0);
    expect(readFileSync(join(a, "src", "app.js"), "utf8")).toBe(ORIGINAL.replace(/\n/g, "\r\n"));

    writeFileSync(join(a, "src", "app.js"), ORIGINAL.replace("HEADER = 34", "HEADER = 55").replace(/\n/g, "\r\n"));
    expect((await runHook("post", a, url, "crlf-1", "sa")).code).toBe(0);
    expect(server.getDocContent("src/app.js")).toContain("HEADER = 55");
    expect(server.getDocContent("src/app.js")).not.toContain("\r");
  }, 60_000);

  it("synchronizes apply_patch deletion and removes the file from another worktree", async () => {
    const pre = await runHook(
      "pre",
      a,
      url,
      "a1",
      "sa",
      "apply_patch",
      "*** Begin Patch\n*** Delete File: src/app.js\n*** End Patch",
    );
    expect(pre.code).toBe(0);
    unlinkSync(join(a, "src", "app.js"));
    expect((await runHook("post", a, url, "a1", "sa")).code).toBe(0);
    expect(server.getDocState("src/app.js")).toEqual({ exists: false, content: "" });

    expect((await runHook("pre", b, url, "b1", "sb")).code).toBe(0);
    expect(existsSync(join(b, "src", "app.js"))).toBe(false);
  }, 60_000);

  it("rejects a stale deletion and restores the latest shared content", async () => {
    expect((await runHook("pre", b, url, "stale-delete", "sb")).code).toBe(0);

    expect((await runHook("pre", a, url, "newer-edit", "sa")).code).toBe(0);
    writeFileSync(join(a, "src", "app.js"), ORIGINAL.replace("HEADER = 34", "HEADER = 99"));
    expect((await runHook("post", a, url, "newer-edit", "sa")).code).toBe(0);

    unlinkSync(join(b, "src", "app.js"));
    const rejected = await runHook("post", b, url, "stale-delete", "sb");
    expect(rejected.code).toBe(2);
    expect(rejected.stderr).toContain("modified concurrently");
    expect(readFileSync(join(b, "src", "app.js"), "utf8")).toContain("HEADER = 99");
    expect(server.getDocState("src/app.js")?.exists).toBe(true);
  }, 90_000);
});
