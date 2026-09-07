import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simpleGit, type SimpleGit } from "simple-git";
import { SyncServer } from "../src/server/syncServer.js";
import { SyncClient } from "../src/client/SyncClient.js";
import { DiskFlushService } from "../src/flush/diskFlushService.js";

async function makeRepo(): Promise<{ dir: string; git: SimpleGit }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-sync-flush-"));
  const git = simpleGit(dir);
  await git.init();
  // Local, repo-scoped identity so this doesn't depend on (or pollute) any
  // global git config on the machine running the tests.
  await git.addConfig("user.name", "agent-sync-test");
  await git.addConfig("user.email", "agent-sync-test@example.com");
  return { dir, git };
}

describe("Phase 4: disk flush + git commit (Section 6)", () => {
  let server: SyncServer;
  let serverUrl: string;
  let repoDir: string;
  let git: SimpleGit;
  let flush: DiskFlushService | null;
  const clients: SyncClient[] = [];

  beforeEach(async () => {
    server = new SyncServer(0);
    serverUrl = `ws://localhost:${server.port}`;
    const repo = await makeRepo();
    repoDir = repo.dir;
    git = repo.git;
    flush = null;
  });

  afterEach(async () => {
    flush?.close();
    for (const client of clients.splice(0)) client.close();
    await server.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  function makeClient(docName: string): SyncClient {
    const client = new SyncClient({ serverUrl, docName });
    clients.push(client);
    return client;
  }

  /** A client's local edit is applied to its own Y.Doc synchronously but only reaches the server (and so `server.getDocContent()`) after a network round trip — wait for that before driving a manual flush directly off server state. */
  async function waitForServerContent(docName: string, expected: string): Promise<void> {
    await vi.waitFor(() => expect(server.getDocContent(docName)).toBe(expected));
  }

  it("auto-flushes a doc to disk and commits it after the debounce window", async () => {
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 30 });

    const client = makeClient("notes.txt");
    await client.connect();
    await client.whenSynced();
    client.getText().insert(0, "hello from an agent");

    await vi.waitFor(async () => {
      const content = await readFile(join(repoDir, "notes.txt"), "utf8");
      expect(content).toBe("hello from an agent");
    });

    await vi.waitFor(async () => {
      const log = await git.log();
      expect(log.total).toBe(1);
      expect(log.latest?.message).toContain("notes.txt");
    });
  });

  it("resets the debounce timer on further edits instead of flushing mid-burst", async () => {
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 80 });

    const client = makeClient("burst.txt");
    await client.connect();
    await client.whenSynced();

    client.getText().insert(0, "a");
    await new Promise((resolve) => setTimeout(resolve, 40));
    client.getText().insert(1, "b");
    await new Promise((resolve) => setTimeout(resolve, 40));
    client.getText().insert(2, "c");

    // Only ~80ms have elapsed since the last edit at this point (< debounceMs
    // was reset each time) — nothing should be on disk yet.
    await expect(readFile(join(repoDir, "burst.txt"), "utf8")).rejects.toThrow();

    await vi.waitFor(async () => {
      const content = await readFile(join(repoDir, "burst.txt"), "utf8");
      expect(content).toBe("abc");
    });
  });

  it("flushPath() flushes immediately and cancels any pending debounce timer", async () => {
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 5000 });

    const client = makeClient("immediate.txt");
    await client.connect();
    await client.whenSynced();
    client.getText().insert(0, "flush me now");
    await waitForServerContent("immediate.txt", "flush me now");

    await flush.flushPath("immediate.txt");

    const content = await readFile(join(repoDir, "immediate.txt"), "utf8");
    expect(content).toBe("flush me now");
  });

  it("flushAll() flushes every active doc, for manual/CLI-style flush", async () => {
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 5000, autoFlush: false });

    const a = makeClient("a.txt");
    const b = makeClient("nested/b.txt");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);
    a.getText().insert(0, "content a");
    b.getText().insert(0, "content b");
    await waitForServerContent("a.txt", "content a");
    await waitForServerContent("nested/b.txt", "content b");

    await flush.flushAll();

    expect(await readFile(join(repoDir, "a.txt"), "utf8")).toBe("content a");
    expect(await readFile(join(repoDir, "nested", "b.txt"), "utf8")).toBe("content b");
  });

  it("does not create an empty commit when flushing a doc whose content hasn't changed", async () => {
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 5000, autoFlush: false });

    const client = makeClient("stable.txt");
    await client.connect();
    await client.whenSynced();
    client.getText().insert(0, "unchanging");
    await waitForServerContent("stable.txt", "unchanging");

    await flush.flushAll();
    const afterFirst = await git.log();
    expect(afterFirst.total).toBe(1);

    await flush.flushAll();
    const afterSecond = await git.log();
    expect(afterSecond.total).toBe(1);
  });

  it("converts LF to CRLF on disk when configured, without affecting the CRDT's internal content", async () => {
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 5000, autoFlush: false, lineEndings: "crlf" });

    const client = makeClient("crlf.txt");
    await client.connect();
    await client.whenSynced();
    client.getText().insert(0, "line1\nline2\n");
    await waitForServerContent("crlf.txt", "line1\nline2\n");

    await flush.flushAll();

    const raw = await readFile(join(repoDir, "crlf.txt"), "utf8");
    expect(raw).toBe("line1\r\nline2\r\n");
    // The CRDT itself is untouched — still canonical LF.
    expect(client.getText().toString()).toBe("line1\nline2\n");
  });
});
