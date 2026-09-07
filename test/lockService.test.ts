import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncServer } from "../src/server/syncServer.js";
import { SyncClient } from "../src/client/SyncClient.js";
import { LockDeniedError, SyncFileOps } from "../src/sync/syncFileOps.js";

describe("Phase 6: lock service — raw protocol (Section 4/12)", () => {
  let server: SyncServer;
  let serverUrl: string;
  const clients: SyncClient[] = [];

  beforeEach(() => {
    server = new SyncServer(0);
    serverUrl = `ws://localhost:${server.port}`;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await server.close();
  });

  function makeClient(docName: string): SyncClient {
    const client = new SyncClient({ serverUrl, docName });
    clients.push(client);
    return client;
  }

  it("grants a lock to the first requester and denies a second requester while it's held", async () => {
    const a = makeClient("schema.ts");
    const b = makeClient("schema.ts");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);

    const granted = await a.acquireLock("agent-a", 5000);
    expect(granted.kind).toBe("granted");
    expect(server.getLockState("schema.ts")?.ownerId).toBe("agent-a");

    const denied = await b.acquireLock("agent-b", 5000);
    expect(denied.kind).toBe("denied");
    if (denied.kind === "denied") {
      expect(denied.message).toMatch(/locked by another process/i);
      expect(denied.message).toMatch(/retry/i);
    }
  });

  it("releases a lock so the next requester can acquire it", async () => {
    const a = makeClient("schema.ts");
    const b = makeClient("schema.ts");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);

    await a.acquireLock("agent-a", 5000);
    await a.releaseLock("agent-a");
    expect(server.getLockState("schema.ts")).toBeNull();

    const granted = await b.acquireLock("agent-b", 5000);
    expect(granted.kind).toBe("granted");
  });

  it("is idempotent for the same owner: re-acquiring (renewing) never self-denies", async () => {
    const a = makeClient("schema.ts");
    await a.connect();
    await a.whenSynced();

    const first = await a.acquireLock("agent-a", 200);
    const renewed = await a.acquireLock("agent-a", 5000);
    expect(first.kind).toBe("granted");
    expect(renewed.kind).toBe("granted");
    if (renewed.kind === "granted" && first.kind === "granted") {
      expect(renewed.expiresAt).toBeGreaterThan(first.expiresAt);
    }
  });

  it("expires the lease after its TTL, even though the original holder is still connected (Section 2: always TTL-based expiry)", async () => {
    const a = makeClient("schema.ts");
    const b = makeClient("schema.ts");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);

    await a.acquireLock("agent-a", 100);
    const tooSoon = await b.acquireLock("agent-b", 5000);
    expect(tooSoon.kind).toBe("denied");

    await vi.waitFor(async () => {
      const result = await b.acquireLock("agent-b", 5000);
      expect(result.kind).toBe("granted");
    });
    expect(server.getLockState("schema.ts")?.ownerId).toBe("agent-b");
  });

  it("frees the lease immediately on the holder's disconnect, without waiting out the TTL (the crash case)", async () => {
    const a = makeClient("schema.ts");
    const b = makeClient("schema.ts");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);

    await a.acquireLock("agent-a", 30_000); // a long lease — only disconnect should free it this fast
    a.close();

    await vi.waitFor(() => {
      expect(server.getLockState("schema.ts")).toBeNull();
    });
    const granted = await b.acquireLock("agent-b", 5000);
    expect(granted.kind).toBe("granted");
  });

  it("rejects any pending lock request rather than hanging if the connection drops mid-request", async () => {
    const a = makeClient("schema.ts");
    await a.connect();
    await a.whenSynced();

    const pending = a.acquireLock("agent-a", 5000);
    a.simulateNetworkDrop();
    const result = await pending;
    expect(result.kind).toBe("denied");
  });
});

describe("Phase 6: lock service via SyncFileOps (exclusive paths)", () => {
  let server: SyncServer;
  let serverUrl: string;
  let opsA: SyncFileOps | null;
  let opsB: SyncFileOps | null;
  const clients: SyncClient[] = [];

  beforeEach(() => {
    server = new SyncServer(0);
    serverUrl = `ws://localhost:${server.port}`;
    opsA = null;
    opsB = null;
  });

  afterEach(async () => {
    await opsA?.close();
    await opsB?.close();
    for (const client of clients.splice(0)) client.close();
    await server.close();
  });

  function makeClient(docName: string): SyncClient {
    const client = new SyncClient({ serverUrl, docName });
    clients.push(client);
    return client;
  }

  it("writes to a non-exclusive path never touch the lock service at all", async () => {
    opsA = new SyncFileOps({ serverUrl });
    await opsA.writeFileFull("plain.ts", "hello");
    expect(server.getLockState("plain.ts")).toBeNull();
    expect(await opsA.readFile("plain.ts")).toBe("hello");
  });

  it("a write to an exclusive path acquires and releases the lease around just that write", async () => {
    opsA = new SyncFileOps({ serverUrl, exclusivePaths: ["schema.ts"], ownerId: "agent-a" });
    await opsA.writeFileFull("schema.ts", "export type X = 1;");
    // The write completed, so per the transaction-scoped design the lease
    // should already be released again — not held indefinitely.
    expect(server.getLockState("schema.ts")).toBeNull();
    expect(await opsA.readFile("schema.ts")).toBe("export type X = 1;");
  });

  it("rejects a write to an exclusive path currently locked by another owner, with an EBUSY-coded error, and applies no edit", async () => {
    opsA = new SyncFileOps({ serverUrl, exclusivePaths: ["schema.ts"], ownerId: "agent-a" });
    opsB = new SyncFileOps({ serverUrl, exclusivePaths: ["schema.ts"], ownerId: "agent-b" });
    await opsA.writeFileFull("schema.ts", "original");

    // Hold the lease with a separate raw client standing in for "agent-a
    // still mid-edit", so agent-b's write genuinely contends with a live lock.
    const holder = makeClient("schema.ts");
    await holder.connect();
    await holder.whenSynced();
    await holder.acquireLock("agent-a", 5000);

    let caught: unknown;
    try {
      await opsB.writeFileFull("schema.ts", "agent-b's change");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockDeniedError);
    expect((caught as LockDeniedError).code).toBe("EBUSY");
    expect((caught as LockDeniedError).message).toMatch(/schema\.ts/);
    expect((caught as LockDeniedError).message).toMatch(/retry/i);
    expect(await opsA.readFile("schema.ts")).toBe("original");

    await holder.releaseLock("agent-a");
    await opsB.writeFileFull("schema.ts", "agent-b's change");
    expect(await opsA.readFile("schema.ts")).toBe("agent-b's change");
  });

  it("releases the lease even when the write itself fails (e.g. a rejected range_replace), so the lock isn't held until TTL expiry", async () => {
    opsA = new SyncFileOps({ serverUrl, exclusivePaths: ["schema.ts"], ownerId: "agent-a" });
    await opsA.writeFileFull("schema.ts", "AAAA BBBB");

    await expect(opsA.writeFileRange("schema.ts", "not there", "x")).rejects.toThrow();
    expect(server.getLockState("schema.ts")).toBeNull();

    // The lease was released despite the failure, so a second owner isn't blocked by it.
    opsB = new SyncFileOps({ serverUrl, exclusivePaths: ["schema.ts"], ownerId: "agent-b" });
    await opsB.writeFileRange("schema.ts", "BBBB", "ZZZZ");
    expect(await opsA.readFile("schema.ts")).toBe("AAAA ZZZZ");
  });
});
