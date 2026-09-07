/**
 * Payload shapes for the `MESSAGE_LOCK` envelope (Phase 6, spec Section
 * 4/10/12). One lock per room (a room already is one doc/one path), so unlike
 * sync/awareness these never need to name a path themselves — the WebSocket
 * connection's URL already picked the room. Shared between client and server
 * so the two sides can't drift on the shape.
 */
export type LockRequestPayload =
  | { kind: "acquire"; requestId: string; ownerId: string; leaseMs: number }
  | { kind: "release"; requestId: string; ownerId: string };

export type LockResponsePayload =
  | { kind: "granted"; requestId: string; expiresAt: number }
  | { kind: "denied"; requestId: string; message: string }
  | { kind: "released"; requestId: string };
