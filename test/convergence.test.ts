import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncServer } from "../src/server/syncServer.js";
import { SyncClient } from "../src/client/SyncClient.js";

describe("Phase 1: CRDT convergence", () => {
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

  it("merges concurrent, non-conflicting edits from two clients with no lost writes", async () => {
    const a = makeClient("shared.ts");
    const b = makeClient("shared.ts");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);

    // Both start from the same empty doc and edit concurrently, before
    // either has seen the other's change — the scenario Section 1 promises
    // "no lost writes" for.
    a.getText().insert(0, "hello ");
    b.getText().insert(0, "world ");

    await vi.waitFor(() => {
      expect(a.getText().toString()).toBe(b.getText().toString());
    });

    const merged = a.getText().toString();
    expect(merged).toContain("hello");
    expect(merged).toContain("world");
    expect(merged.length).toBe("hello ".length + "world ".length);
  });

  it("converges to the same state regardless of the order updates arrive (commutativity)", async () => {
    const a = makeClient("order.ts");
    const b = makeClient("order.ts");
    const c = makeClient("order.ts");
    await Promise.all([a.connect(), b.connect(), c.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced(), c.whenSynced()]);

    a.getText().insert(0, "AAA");
    b.getText().insert(0, "BBB");
    c.getText().insert(0, "CCC");

    await vi.waitFor(() => {
      const [sa, sb, sc] = [a, b, c].map((client) => client.getText().toString());
      expect(sa).toBe(sb);
      expect(sb).toBe(sc);
    });
  });

  it("brings a late-joining client to the fully merged state, not just what it missed", async () => {
    const a = makeClient("late-join.ts");
    const b = makeClient("late-join.ts");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);

    a.getText().insert(0, "from-a ");
    b.getText().insert(0, "from-b ");
    await vi.waitFor(() => {
      expect(a.getText().toString()).toBe(b.getText().toString());
    });
    const mergedBeforeJoin = a.getText().toString();

    const c = makeClient("late-join.ts");
    await c.connect();
    await c.whenSynced();

    expect(c.getText().toString()).toBe(mergedBeforeJoin);
  });

  it("keeps documents under different names fully independent", async () => {
    const a = makeClient("file-a.ts");
    const b = makeClient("file-b.ts");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);

    a.getText().insert(0, "only in a");
    b.getText().insert(0, "only in b");

    await vi.waitFor(() => {
      expect(a.getText().toString()).toBe("only in a");
    });
    expect(b.getText().toString()).toBe("only in b");
  });
});
