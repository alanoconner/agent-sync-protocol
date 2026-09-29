import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDiskHydrator } from "../src/flush/diskHydration.js";
import { SyncServer } from "../src/server/syncServer.js";

const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const CLI = join(process.cwd(), "src", "cli", "index.ts");
const ORIGINAL = "const A = 1;\nconst HEADER = 34;\nconst B = 2;\n";

function runHook(mode: "pre" | "post", workspace: string, serverUrl: string, toolUseId: string, session: string, cwd = workspace) {
  return new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [TSX_CLI, CLI, "_hook", "claude", mode],
      { cwd, env: { ...process.env, AGENT_SYNC_SERVER: serverUrl, CLAUDE_PROJECT_DIR: "" } },
      (err, _stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stderr }),
    );
    child.stdin?.end(JSON.stringify({ session_id: session, tool_use_id: toolUseId, cwd, tool_name: "Bash", tool_input: { command: "opaque" } }));
  });
}

describe("Claude Code hook bridge — Bash calls (command-agnostic workspace diff)", () => {
  let server: SyncServer;
  let canonical: string;
  let a: string;
  let b: string;
  let url: string;

  const makeWorkspace = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "asp-hook-ws-")));
    execFileSync("git", ["init", "-q", dir]);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.js"), ORIGINAL);
    return dir;
  };

  beforeEach(async () => {
    canonical = makeWorkspace();
    a = makeWorkspace();
    b = makeWorkspace();
    server = new SyncServer(0, { hydrate: createDiskHydrator(canonical) });
    url = `ws://localhost:${server.port}`;
  });
  afterEach(async () => {
    await server.close();
    for (const dir of [canonical, a, b]) rmSync(dir, { recursive: true, force: true });
  });

  it("syncs a script-driven edit made from a subdirectory, then rejects a stale conflicting one", async () => {
    // Agent A: a Bash call whose command names no file at all (like `python3 fix.py`), run from a subdirectory.
    const sub = join(a, "src");
    expect((await runHook("pre", a, url, "a1", "sa", sub)).code).toBe(0);
    writeFileSync(join(a, "src", "app.js"), ORIGINAL.replace("HEADER = 34", "HEADER = 20"));
    expect((await runHook("post", a, url, "a1", "sa", sub)).code).toBe(0);
    expect(server.getDocContent("src/app.js")).toContain("HEADER = 20");

    // Agent B's next Bash call starts by pulling shared truth onto its disk...
    expect((await runHook("pre", b, url, "b1", "sb")).code).toBe(0);
    expect(readFileSync(join(b, "src", "app.js"), "utf8")).toContain("HEADER = 20");

    // ...but A lands another change to the same line while B's command is still running.
    expect((await runHook("pre", a, url, "a2", "sa", sub)).code).toBe(0);
    writeFileSync(join(a, "src", "app.js"), readFileSync(join(a, "src", "app.js"), "utf8").replace("HEADER = 20", "HEADER = 21"));
    expect((await runHook("post", a, url, "a2", "sa", sub)).code).toBe(0);

    writeFileSync(join(b, "src", "app.js"), readFileSync(join(b, "src", "app.js"), "utf8").replace("HEADER = 20", "HEADER = 15"));
    const rejected = await runHook("post", b, url, "b1", "sb");
    expect(rejected.code).toBe(2);
    expect(rejected.stderr).toContain("src/app.js");
    expect(server.getDocContent("src/app.js")).toContain("HEADER = 21");
    // B's disk is reverted to shared truth so its next read starts from reality
    expect(readFileSync(join(b, "src", "app.js"), "utf8")).toContain("HEADER = 21");
  }, 90_000);

  it("syncs a file created by a command, and does not touch gitignored or .claude files", async () => {
    writeFileSync(join(a, ".gitignore"), "out/\n");
    mkdirSync(join(a, ".claude"), { recursive: true });
    expect((await runHook("pre", a, url, "a1", "sa")).code).toBe(0);
    writeFileSync(join(a, "src", "made.js"), "made();\n");
    mkdirSync(join(a, "out"), { recursive: true });
    writeFileSync(join(a, "out", "bundle.js"), "x");
    writeFileSync(join(a, ".claude", "settings.json"), "{}");
    expect((await runHook("post", a, url, "a1", "sa")).code).toBe(0);
    expect(server.getDocNames()).toEqual(["src/made.js"]);
    expect(server.getDocContent("src/made.js")).toBe("made();\n");
  }, 60_000);
});
