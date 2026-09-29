import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncClient } from "../src/client/SyncClient.js";
import { recoverRoom } from "../src/cli/recovery.js";
import { CrdtStore } from "../src/persistence/crdtStore.js";
import { createAgentSyncRuntime, type AgentSyncRuntime } from "../src/server/bootstrap.js";
import { RecoveryConflictError, SyncServer } from "../src/server/syncServer.js";
import { SyncFileOps } from "../src/sync/syncFileOps.js";

const roots: string[] = [];

function fixture(): { repo: string; persistence: string } {
  const repo = mkdtempSync(join(tmpdir(), "agent-sync-durable-repo-"));
  const persistence = mkdtempSync(join(tmpdir(), "agent-sync-durable-state-"));
  roots.push(repo, persistence);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Persistence Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "persistence@example.test"]);
  writeFileSync(join(repo, "file.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "file.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  return { repo, persistence };
}

function runtime(repo: string, persistence: string): AgentSyncRuntime {
  return createAgentSyncRuntime({
    port: 0,
    repoRoot: repo,
    persistenceDir: persistence,
    flushDebounceMs: 60_000,
    log: () => undefined,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("durable CRDT persistence", () => {
  it("locks the store against concurrent writers and fails closed on snapshot corruption", async () => {
    const { persistence } = fixture();
    const store = new CrdtStore(persistence);
    await store.save("file.txt", new Uint8Array([0, 0]), { exists: true, content: "base\n" });
    expect(() => new CrdtStore(persistence)).toThrow(/already in use/);
    store.close();

    const snapshot = readdirSync(persistence).find((name) => name.endsWith(".json"))!;
    writeFileSync(join(persistence, snapshot), "{corrupt", "utf8");
    expect(() => new CrdtStore(persistence)).toThrow(/cannot read CRDT snapshot/);
    // Constructor failure releases its lock, so a recovery command can be
    // retried after the corrupt artifact is repaired or restored.
    expect(readdirSync(persistence)).not.toContain("lock");
  });

  it("recovers an acknowledged write that never reached the disk/Git flush layer", async () => {
    const { repo, persistence } = fixture();
    const first = runtime(repo, persistence);
    const ops = new SyncFileOps({ serverUrl: `ws://localhost:${first.server.port}` });
    await ops.writeFileFromSnapshot("file.txt", "base\n", "durable but unflushed\n");
    await ops.close();
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("base\n");
    expect((await first.close({ flush: false })).pending).toEqual(["file.txt"]);

    const second = runtime(repo, persistence);
    expect(second.server.getDocContent("file.txt")).toBe("durable but unflushed\n");
    expect((await second.flushAll()).pending).toEqual([]);
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("durable but unflushed\n");
    await second.close({ flush: false });
  });

  it("recovers an unflushed tombstone", async () => {
    const { repo, persistence } = fixture();
    const first = runtime(repo, persistence);
    const ops = new SyncFileOps({ serverUrl: `ws://localhost:${first.server.port}` });
    await ops.deleteFileFromSnapshot("file.txt", "base\n");
    await ops.close();
    await first.close({ flush: false });

    const second = runtime(repo, persistence);
    expect(second.server.getDocState("file.txt")).toEqual({ exists: false, content: "" });
    expect((await second.close({ flush: false })).pending).toEqual(["file.txt"]);
  });

  it("does not acknowledge or broadcast a mutation until its snapshot is durable", async () => {
    const { repo, persistence } = fixture();
    const store = new CrdtStore(persistence);
    const server = new SyncServer(0, { hydrate: () => ({ exists: true, content: "base\n" }), persistence: store });
    const writer = new SyncFileOps({ serverUrl: `ws://localhost:${server.port}` });
    const observer = new SyncClient({ serverUrl: `ws://localhost:${server.port}`, docName: "file.txt" });
    await writer.readFile("file.txt");
    await server.whenDocPersisted("file.txt");
    await observer.connect();
    await observer.whenSynced();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    let resolved = false;
    const write = writer.writeFileFromSnapshot("file.txt", "base\n", "later\n").then(() => { resolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolved).toBe(false);
    expect(observer.getText().toString()).toBe("base\n");

    release();
    await write;
    await vi.waitFor(() => expect(observer.getText().toString()).toBe("later\n"));
    await writer.close();
    observer.close();
    await server.close();
    void repo;
  });

  it("rejects the writer and withholds broadcast when durable storage fails", async () => {
    const { persistence } = fixture();
    const store = new CrdtStore(persistence);
    const server = new SyncServer(0, { hydrate: () => ({ exists: true, content: "base\n" }), persistence: store });
    const writer = new SyncFileOps({ serverUrl: `ws://localhost:${server.port}` });
    const observer = new SyncClient({ serverUrl: `ws://localhost:${server.port}`, docName: "file.txt" });
    await writer.readFile("file.txt");
    await server.whenDocPersisted("file.txt");
    await observer.connect();
    await observer.whenSynced();
    vi.spyOn(store, "save").mockRejectedValueOnce(new Error("disk full"));

    await expect(writer.writeFileFromSnapshot("file.txt", "base\n", "volatile\n")).rejects.toThrow(/disk full/);
    expect(observer.getText().toString()).toBe("base\n");
    await writer.close();
    observer.close();
    await expect(server.close()).rejects.toThrow(/disk full/);
  });

  it("refuses startup when disk and durable state both diverged from the flush checkpoint", async () => {
    const { repo, persistence } = fixture();
    const first = runtime(repo, persistence);
    const ops = new SyncFileOps({ serverUrl: `ws://localhost:${first.server.port}` });
    await ops.writeFileFromSnapshot("file.txt", "base\n", "pending\n");
    await ops.close();
    await first.close({ flush: false });
    writeFileSync(join(repo, "file.txt"), "external\n");

    expect(() => runtime(repo, persistence)).toThrow(RecoveryConflictError);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("preserves Yjs causal identity when a live client reconnects after restart", async () => {
    const { persistence } = fixture();
    const firstStore = new CrdtStore(persistence);
    const first = new SyncServer(0, { hydrate: () => ({ exists: true, content: "base\n" }), persistence: firstStore });
    const port = first.port;
    const client = new SyncClient({
      serverUrl: `ws://localhost:${port}`,
      docName: "file.txt",
      reconnect: { baseDelayMs: 20, maxDelayMs: 50 },
    });
    await client.connect();
    await client.whenSynced();
    client.getText().insert(5, "once ");
    await client.whenDurable();
    expect(client.getText().toString()).toBe("base\nonce ");
    await first.close();

    const secondStore = new CrdtStore(persistence);
    const second = new SyncServer(port, { hydrate: () => ({ exists: true, content: "base\n" }), persistence: secondStore });
    await second.whenListening();
    await vi.waitFor(() => expect(client.getText().toString()).toBe("base\nonce "), { timeout: 2000 });
    await vi.waitFor(() => expect(second.getDocContent("file.txt")).toBe("base\nonce "), { timeout: 2000 });
    client.close();
    await second.close();
  });

  it("restores a validation rejection without automatically retrying the invalid state", async () => {
    const { repo, persistence } = fixture();
    const first = createAgentSyncRuntime({
      port: 0,
      repoRoot: repo,
      persistenceDir: persistence,
      flushDebounceMs: 60_000,
      validation: { command: `${JSON.stringify(process.execPath)} -e "process.exit(1)"`, onFail: "reject_merge" },
      log: () => undefined,
    });
    const writer = new SyncFileOps({ serverUrl: `ws://localhost:${first.server.port}` });
    await writer.writeFileFromSnapshot("file.txt", "base\n", "invalid\n");
    await first.flushAll();
    await vi.waitFor(async () => expect(await writer.hasPendingRejection("file.txt")).toBe(true));
    await writer.close();
    await first.close({ flush: false });

    const second = runtime(repo, persistence);
    const reader = new SyncFileOps({ serverUrl: `ws://localhost:${second.server.port}` });
    expect(await reader.hasPendingRejection("file.txt")).toBe(true);
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("base\n");
    await reader.close();
    await second.close({ flush: false });
  });

  it.each(["crdt", "disk"] as const)("resolves a three-way conflict explicitly using %s state", async (choice) => {
    const { repo, persistence } = fixture();
    const stateDir = mkdtempSync(join(tmpdir(), "agent-sync-recovery-command-"));
    roots.push(stateDir);
    const first = runtime(repo, persistence);
    const writer = new SyncFileOps({ serverUrl: `ws://localhost:${first.server.port}` });
    await writer.writeFileFromSnapshot("file.txt", "base\n", "pending\n");
    await writer.close();
    await first.close({ flush: false });
    writeFileSync(join(repo, "file.txt"), "external\n");

    await recoverRoom(stateDir, repo, "file.txt", choice, persistence);
    const second = runtime(repo, persistence);
    expect(second.server.getDocContent("file.txt")).toBe(choice === "crdt" ? "pending\n" : "external\n");
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe(choice === "crdt" ? "pending\n" : "external\n");
    await second.close({ flush: false });
  });
});
