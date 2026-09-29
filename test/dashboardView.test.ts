import { describe, expect, it } from "vitest";
import { describePeer, formatStatus, statusUrlFor } from "../src/cli/dashboardView.js";
import type { ServerStatus } from "../src/server/syncServer.js";

describe("Phase 7: dashboard view helpers", () => {
  it("derives the status URL from a ws:// server URL", () => {
    expect(statusUrlFor("ws://localhost:4600")).toBe("http://localhost:4600/status");
  });

  it("derives the status URL from a wss:// server URL", () => {
    expect(statusUrlFor("wss://sync.internal:5000")).toBe("https://sync.internal:5000/status");
  });

  it("labels a peer by agentId when its presence state has one", () => {
    expect(describePeer({ clientId: 7, state: { agentId: "agent-A", status: "editing" } })).toBe("agent-A (status=editing)");
  });

  it("falls back to a client id label when there's no agentId", () => {
    expect(describePeer({ clientId: 7, state: null })).toBe("client-7");
    expect(describePeer({ clientId: 7, state: {} })).toBe("client-7");
  });

  it("formats a status with no active files", () => {
    expect(formatStatus({ rooms: [] })).toEqual(["(no active files)"]);
  });

  it("formats rooms with peers and an unlocked file", () => {
    const status: ServerStatus = {
      rooms: [
        { docName: "notes.txt", deleted: false, peers: [{ clientId: 1, state: { agentId: "agent-A" } }], lock: null },
        { docName: "idle.txt", deleted: false, peers: [], lock: null },
      ],
    };
    expect(formatStatus(status)).toEqual(["notes.txt", "  agent-A", "idle.txt", "  (nobody)"]);
  });

  it("flags a locked file with its owner", () => {
    const status: ServerStatus = {
      rooms: [{ docName: "schema.ts", deleted: false, peers: [{ clientId: 1, state: { agentId: "agent-A" } }], lock: { ownerId: "agent-A", expiresAt: Date.now() + 5000 } }],
    };
    expect(formatStatus(status)[0]).toBe("schema.ts [locked by agent-A]");
  });

  it("labels tombstoned rooms", () => {
    expect(formatStatus({ rooms: [{ docName: "gone.ts", deleted: true, peers: [], lock: null }] })[0]).toBe("gone.ts [deleted]");
  });
});
