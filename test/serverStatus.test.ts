import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncServer, type ServerStatus } from "../src/server/syncServer.js";
import { SyncClient } from "../src/client/SyncClient.js";
import { TOMBSTONE_MAP_NAME } from "../src/sync/fileState.js";

describe("Phase 7: GET /status (dashboard data, Section 10)", () => {
  let server: SyncServer;
  let serverUrl: string;
  let statusUrl: string;
  const clients: SyncClient[] = [];

  beforeEach(() => {
    server = new SyncServer(0);
    serverUrl = `ws://localhost:${server.port}`;
    statusUrl = `http://localhost:${server.port}/status`;
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

  async function fetchStatus(): Promise<ServerStatus> {
    const res = await fetch(statusUrl);
    expect(res.status).toBe(200);
    return (await res.json()) as ServerStatus;
  }

  it("reports no rooms before any client connects", async () => {
    expect(await fetchStatus()).toEqual({ rooms: [] });
  });

  it("reports a connected client's presence state under its doc's room", async () => {
    const a = makeClient("notes.txt");
    await a.connect();
    await a.whenSynced();
    a.setPresence({ agentId: "agent-A", status: "editing" });

    await vi.waitFor(async () => {
      const status = await fetchStatus();
      const room = status.rooms.find((r) => r.docName === "notes.txt");
      expect(room?.peers).toEqual([{ clientId: a.doc.clientID, state: { agentId: "agent-A", status: "editing" } }]);
    });
  });

  it("a client with no presence set contributes no peer entry", async () => {
    const a = makeClient("quiet.txt");
    await a.connect();
    await a.whenSynced();

    const status = await fetchStatus();
    const room = status.rooms.find((r) => r.docName === "quiet.txt");
    expect(room?.peers).toEqual([]);
  });

  it("reports an active lock and clears it on release", async () => {
    const a = makeClient("schema.ts");
    await a.connect();
    await a.whenSynced();
    await a.acquireLock("agent-A", 30_000);

    let status = await fetchStatus();
    let room = status.rooms.find((r) => r.docName === "schema.ts");
    expect(room?.lock?.ownerId).toBe("agent-A");

    await a.releaseLock("agent-A");
    status = await fetchStatus();
    room = status.rooms.find((r) => r.docName === "schema.ts");
    expect(room?.lock).toBeNull();
  });

  it("reports tombstoned rooms as deleted", async () => {
    const client = makeClient("gone.ts");
    await client.connect();
    await client.whenSynced();
    client.doc.getMap<boolean>(TOMBSTONE_MAP_NAME).set("status-test", true);

    await vi.waitFor(async () => {
      const room = (await fetchStatus()).rooms.find((entry) => entry.docName === "gone.ts");
      expect(room?.deleted).toBe(true);
    });
  });

  it("404s any other path", async () => {
    const res = await fetch(`http://localhost:${server.port}/nope`);
    expect(res.status).toBe(404);
  });
});
