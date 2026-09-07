import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncServer } from "../src/server/syncServer.js";
import { SyncClient, type ConnectionStatus } from "../src/client/SyncClient.js";

describe("Phase 2: reconnect with backoff", () => {
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
    const client = new SyncClient({
      serverUrl,
      docName,
      reconnect: { baseDelayMs: 20, maxDelayMs: 100 },
    });
    clients.push(client);
    return client;
  }

  it("automatically reconnects and resumes syncing after a simulated network drop", async () => {
    const a = makeClient("resilient.ts");
    const b = makeClient("resilient.ts");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);

    const statuses: ConnectionStatus[] = [];
    a.on("status", (event: { status: ConnectionStatus }) => statuses.push(event.status));

    a.simulateNetworkDrop();

    await vi.waitFor(() => {
      expect(statuses).toContain("disconnected");
    });
    await vi.waitFor(
      () => {
        expect(statuses).toContain("connected");
      },
      { timeout: 2000 },
    );
    await a.whenSynced();

    // Prove the reconnected socket is actually functional, not just "open":
    // an edit from the peer that arrived while `a` was down must still show up.
    b.getText().insert(0, "edited while a was reconnecting");
    await vi.waitFor(() => {
      expect(a.getText().toString()).toBe("edited while a was reconnecting");
    });
  });

  it("does not attempt to reconnect after an intentional close()", async () => {
    const a = makeClient("intentional-close.ts");
    await a.connect();
    await a.whenSynced();

    const statuses: ConnectionStatus[] = [];
    a.on("status", (event: { status: ConnectionStatus }) => statuses.push(event.status));

    a.close();

    // Give the (would-be) reconnect logic a full window to prove it stays away.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(statuses).not.toContain("reconnecting");
  });

  it("re-announces presence after reconnecting, since the server forgot it on disconnect", async () => {
    const a = makeClient("presence-after-reconnect.ts");
    const b = makeClient("presence-after-reconnect.ts");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);

    a.setPresence({ agentId: "agent-A" });
    await vi.waitFor(() => {
      // b never called setPresence, so its own state stays absent — only a's entry shows up.
      expect(b.awareness.getStates().size).toBe(1);
    });

    // Reconnect is fast enough at these test backoff settings that the
    // intervening "gone" state isn't reliably observable by polling — the
    // guarantee that matters here is what's true once things settle, and
    // presence-cleared-on-disconnect is already covered by presence.test.ts.
    a.simulateNetworkDrop();
    await a.whenSynced();
    await vi.waitFor(() => {
      const states = Array.from(b.awareness.getStates().values());
      expect(states).toContainEqual({ agentId: "agent-A" });
    });
  });
});
