import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncServer } from "../src/server/syncServer.js";
import { SyncClient } from "../src/client/SyncClient.js";

describe("Phase 2: presence awareness", () => {
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

  function otherStates(client: SyncClient): unknown[] {
    return Array.from(client.awareness.getStates().entries())
      .filter(([id]) => id !== client.awareness.clientID)
      .map(([, state]) => state);
  }

  it("propagates presence state to other clients editing the same file in real time", async () => {
    const a = makeClient("shared.ts");
    const b = makeClient("shared.ts");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);

    a.setPresence({ agentId: "agent-A", status: "editing" });

    await vi.waitFor(() => {
      expect(otherStates(b)).toEqual([{ agentId: "agent-A", status: "editing" }]);
    });

    // b never reported itself, so a should see nothing from b.
    expect(otherStates(a)).toEqual([]);
  });

  it("brings a late-joining observer up to date on everyone already present", async () => {
    const a = makeClient("dashboard.ts");
    const b = makeClient("dashboard.ts");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);

    a.setPresence({ agentId: "agent-A" });
    b.setPresence({ agentId: "agent-B" });

    await vi.waitFor(() => {
      expect(otherStates(a)).toHaveLength(1);
    });

    // A dashboard-like observer connecting after both are already present.
    const observer = makeClient("dashboard.ts");
    await observer.connect();
    await observer.whenSynced();

    await vi.waitFor(() => {
      const seen = new Set(otherStates(observer).map((s) => (s as { agentId: string }).agentId));
      expect(seen).toEqual(new Set(["agent-A", "agent-B"]));
    });
  });

  it("removes a peer's presence when it disconnects, not just when it goes idle", async () => {
    const a = makeClient("shared.ts");
    const b = makeClient("shared.ts");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);

    b.setPresence({ agentId: "agent-B" });
    await vi.waitFor(() => {
      expect(otherStates(a)).toHaveLength(1);
    });

    b.close();

    await vi.waitFor(() => {
      expect(otherStates(a)).toEqual([]);
    });
  });

  it("keeps presence scoped per file — a peer on a different file is invisible", async () => {
    const a = makeClient("file-a.ts");
    const b = makeClient("file-b.ts");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);

    b.setPresence({ agentId: "agent-B" });

    // Give any (incorrect) cross-room leak a chance to arrive before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(otherStates(a)).toEqual([]);
  });
});
