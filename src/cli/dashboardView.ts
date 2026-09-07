import type { ServerStatus } from "../server/syncServer.js";

/** Derives the `GET /status` URL from a sync server URL (`ws(s)://...` -> `http(s)://.../status`). */
export function statusUrlFor(serverUrl: string): string {
  return serverUrl.replace(/^ws/, "http").replace(/\/+$/, "") + "/status";
}

/** A short human label for one awareness peer — `agentId` from its presence state if set (see `SyncClient.setPresence`), else its raw client id, plus any other state fields for context. */
export function describePeer(peer: { clientId: number; state: Record<string, unknown> | null }): string {
  const state = peer.state ?? {};
  const label = typeof state.agentId === "string" ? state.agentId : `client-${peer.clientId}`;
  const extras = Object.entries(state)
    .filter(([key]) => key !== "agentId")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return extras ? `${label} (${extras})` : label;
}

/** Renders a `ServerStatus` snapshot as plain text lines — one file per block, listing who's present and whether it's locked. No active files renders a single placeholder line. */
export function formatStatus(status: ServerStatus): string[] {
  if (status.rooms.length === 0) return ["(no active files)"];

  const lines: string[] = [];
  for (const room of status.rooms) {
    const lockLabel = room.lock ? ` [locked by ${room.lock.ownerId}]` : "";
    lines.push(`${room.docName}${lockLabel}`);
    lines.push(`  ${room.peers.length > 0 ? room.peers.map(describePeer).join(", ") : "(nobody)"}`);
  }
  return lines;
}
