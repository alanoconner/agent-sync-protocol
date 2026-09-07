import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simpleGit, type SimpleGit } from "simple-git";
import { SyncServer } from "../src/server/syncServer.js";
import { SyncClient } from "../src/client/SyncClient.js";
import { DiskFlushService } from "../src/flush/diskFlushService.js";
import { SyncFileOps, ValidationRejectedError } from "../src/sync/syncFileOps.js";
import { ValidationGateService } from "../src/validation/validationGateService.js";

describe("Phase 5: ValidationGateService (Section 6)", () => {
  it("reports passed with captured output for a command that exits 0", async () => {
    const gate = new ValidationGateService({ command: "node -e \"console.log('all good')\"", onFail: "reject_merge", cwd: process.cwd() });
    const result = await gate.run();
    expect(result.passed).toBe(true);
    expect(result.output).toContain("all good");
  });

  it("reports failed with captured output for a command that exits non-zero", async () => {
    const gate = new ValidationGateService({
      command: "node -e \"console.error('lint: 3 problems'); process.exit(1)\"",
      onFail: "reject_merge",
      cwd: process.cwd(),
    });
    const result = await gate.run();
    expect(result.passed).toBe(false);
    expect(result.output).toContain("lint: 3 problems");
  });
});

describe("Phase 5: validation gate wired into DiskFlushService (Section 6)", () => {
  let server: SyncServer;
  let serverUrl: string;
  let repoDir: string;
  let git: SimpleGit;
  let flush: DiskFlushService | null;
  let ops: SyncFileOps | null;
  const clients: SyncClient[] = [];

  async function makeRepo(): Promise<{ dir: string; git: SimpleGit }> {
    const dir = await mkdtemp(join(tmpdir(), "agent-sync-validate-"));
    const git = simpleGit(dir);
    await git.init();
    await git.addConfig("user.name", "agent-sync-test");
    await git.addConfig("user.email", "agent-sync-test@example.com");
    return { dir, git };
  }

  beforeEach(async () => {
    server = new SyncServer(0);
    serverUrl = `ws://localhost:${server.port}`;
    const repo = await makeRepo();
    repoDir = repo.dir;
    git = repo.git;
    flush = null;
    ops = null;
  });

  afterEach(async () => {
    flush?.close();
    await ops?.close();
    for (const client of clients.splice(0)) client.close();
    await server.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  function makeClient(docName: string): SyncClient {
    const client = new SyncClient({ serverUrl, docName });
    clients.push(client);
    return client;
  }

  async function waitForServerContent(docName: string, expected: string): Promise<void> {
    await vi.waitFor(() => expect(server.getDocContent(docName)).toBe(expected));
  }

  it("commits normally when the validation command passes", async () => {
    const validation = new ValidationGateService({ command: "node -e \"process.exit(0)\"", onFail: "reject_merge", cwd: repoDir });
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 5000, autoFlush: false, validation });

    const client = makeClient("ok.txt");
    await client.connect();
    await client.whenSynced();
    client.getText().insert(0, "passes validation");
    await waitForServerContent("ok.txt", "passes validation");

    await flush.flushAll();

    expect(await readFile(join(repoDir, "ok.txt"), "utf8")).toBe("passes validation");
    const log = await git.log();
    expect(log.total).toBe(1);
  });

  it("reject_merge: reverts a never-before-committed file to absent and skips the commit on validation failure", async () => {
    const validation = new ValidationGateService({
      command: "node -e \"console.error('typecheck failed'); process.exit(1)\"",
      onFail: "reject_merge",
      cwd: repoDir,
    });
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 5000, autoFlush: false, validation });

    let rejected: { docName: string; command: string; output: string } | undefined;
    server.on("validationRejected", (event: { docName: string; command: string; output: string }) => {
      rejected = event;
    });

    const client = makeClient("broken.txt");
    await client.connect();
    await client.whenSynced();
    client.getText().insert(0, "content that fails validation");
    await waitForServerContent("broken.txt", "content that fails validation");

    await flush.flushAll();

    await expect(readFile(join(repoDir, "broken.txt"), "utf8")).rejects.toThrow();
    // `git log` on a repo with zero commits ever throws rather than
    // returning an empty log — that's what "never committed" looks like here.
    await expect(git.log()).rejects.toThrow(/does not have any commits/);
    expect(rejected?.docName).toBe("broken.txt");
    expect(rejected?.output).toContain("typecheck failed");
  });

  it("reject_merge: reverts an already-committed file back to its last good content", async () => {
    const passing = new ValidationGateService({ command: "node -e \"process.exit(0)\"", onFail: "reject_merge", cwd: repoDir });
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 5000, autoFlush: false, validation: passing });

    const client = makeClient("evolving.txt");
    await client.connect();
    await client.whenSynced();
    client.getText().insert(0, "v1 good content");
    await waitForServerContent("evolving.txt", "v1 good content");
    await flush.flushAll();
    expect(await readFile(join(repoDir, "evolving.txt"), "utf8")).toBe("v1 good content");

    // Swap in a failing validation command and make a second edit that "breaks" it.
    flush.close();
    const failing = new ValidationGateService({
      command: "node -e \"console.error('now it fails'); process.exit(1)\"",
      onFail: "reject_merge",
      cwd: repoDir,
    });
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 5000, autoFlush: false, validation: failing });
    client.getText().insert(0, "v2 BROKEN ");
    await waitForServerContent("evolving.txt", "v2 BROKEN v1 good content");

    await flush.flushAll();

    expect(await readFile(join(repoDir, "evolving.txt"), "utf8")).toBe("v1 good content");
    const log = await git.log();
    expect(log.total).toBe(1);
  });

  it("warn_only: commits the failing content anyway and emits a validationWarning event", async () => {
    const validation = new ValidationGateService({
      command: "node -e \"console.error('warn: style issues'); process.exit(1)\"",
      onFail: "warn_only",
      cwd: repoDir,
    });
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 5000, autoFlush: false, validation });

    let warned: { docName: string; command: string; output: string } | undefined;
    server.on("validationWarning", (event: { docName: string; command: string; output: string }) => {
      warned = event;
    });

    const client = makeClient("warned.txt");
    await client.connect();
    await client.whenSynced();
    client.getText().insert(0, "content with style issues");
    await waitForServerContent("warned.txt", "content with style issues");

    await flush.flushAll();

    expect(await readFile(join(repoDir, "warned.txt"), "utf8")).toBe("content with style issues");
    const log = await git.log();
    expect(log.total).toBe(1);
    expect(warned?.output).toContain("warn: style issues");
  });

  it("surfaces the rejection to the agent's next write via SyncFileOps, per Section 3.5/3.6, then clears it", async () => {
    const validation = new ValidationGateService({
      command: "node -e \"console.error('validation failed'); process.exit(1)\"",
      onFail: "reject_merge",
      cwd: repoDir,
    });
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 5000, autoFlush: false, validation });
    ops = new SyncFileOps({ serverUrl });

    await ops.writeFileFull("rejected.txt", "bad content");
    await waitForServerContent("rejected.txt", "bad content");
    await flush.flushAll();

    // The rejection is set on the server's copy of the doc and reaches this
    // client asynchronously over the same Yjs sync channel content itself
    // uses — wait for it to actually arrive before exercising the write path,
    // rather than racing the WebSocket round trip.
    await vi.waitFor(async () => {
      expect(await ops!.hasPendingRejection("rejected.txt")).toBe(true);
    });

    // The next write attempt against this doc — from any SyncFileOps instance,
    // not just the one whose flush was rejected — must fail with EVALIDATE and
    // the spec's exact recommended message shape.
    let caught: unknown;
    try {
      await ops.writeFileFull("rejected.txt", "still bad");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationRejectedError);
    expect((caught as ValidationRejectedError).code).toBe("EVALIDATE");
    expect((caught as ValidationRejectedError).message).toMatch(/^Write rejected: the combined change failed validation/);
    expect((caught as ValidationRejectedError).message).toContain("Re-read the current file state before retrying.");

    // Consumed once: content is unchanged by the rejected attempt, and the very next write succeeds normally.
    expect(server.getDocContent("rejected.txt")).toBe("bad content");
    await ops.writeFileFull("rejected.txt", "fixed content");
    expect(await ops.readFile("rejected.txt")).toBe("fixed content");
  });

  it("does not re-trigger auto-flush/validation from its own rejection-notice write (no infinite loop)", async () => {
    let runCount = 0;
    const validation = new ValidationGateService({
      command: `node -e "require('fs').appendFileSync('run.log','x'); process.exit(1)"`,
      onFail: "reject_merge",
      cwd: repoDir,
    });
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 30, validation });

    const client = makeClient("loop.txt");
    await client.connect();
    await client.whenSynced();
    client.getText().insert(0, "one edit");

    await vi.waitFor(async () => {
      const log = await readFile(join(repoDir, "run.log"), "utf8");
      runCount = log.length;
      expect(runCount).toBeGreaterThan(0);
    });

    // Give any runaway auto-flush loop a real chance to fire several more
    // times before asserting it didn't — well beyond the 30ms debounce.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const finalLog = await readFile(join(repoDir, "run.log"), "utf8");
    expect(finalLog.length).toBe(runCount);
  });

  it("serializes concurrent flushes of different docs instead of racing their validation runs and git commits", async () => {
    const logPath = join(repoDir, "concurrency.log");
    const command = [
      "node",
      "-e",
      `"const fs=require('fs');const start=Date.now();fs.appendFileSync('concurrency.log','start:'+start+'\\n');setTimeout(()=>{fs.appendFileSync('concurrency.log','end:'+Date.now()+'\\n');},150);"`,
    ].join(" ");
    const validation = new ValidationGateService({ command, onFail: "reject_merge", cwd: repoDir });
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 5000, autoFlush: false, validation });

    const a = makeClient("a.txt");
    const b = makeClient("b.txt");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);
    a.getText().insert(0, "content a");
    b.getText().insert(0, "content b");
    await waitForServerContent("a.txt", "content a");
    await waitForServerContent("b.txt", "content b");

    await Promise.all([flush.flushPath("a.txt"), flush.flushPath("b.txt")]);

    expect(await readFile(join(repoDir, "a.txt"), "utf8")).toBe("content a");
    expect(await readFile(join(repoDir, "b.txt"), "utf8")).toBe("content b");
    const log = await git.log();
    expect(log.total).toBe(2);

    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(4);
    const starts = lines.filter((l) => l.startsWith("start:")).map((l) => Number(l.split(":")[1]));
    const ends = lines.filter((l) => l.startsWith("end:")).map((l) => Number(l.split(":")[1]));
    // Serialized (not concurrent): the later run's start must not precede the earlier run's end.
    const [firstEnd, secondEnd] = ends.sort((x, y) => x - y);
    const [, secondStart] = starts.sort((x, y) => x - y);
    expect(secondStart).toBeGreaterThanOrEqual(Math.min(firstEnd, secondEnd) - 5);
  });
});
