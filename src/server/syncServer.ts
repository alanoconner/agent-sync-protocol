import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";
import * as awarenessProtocol from "y-protocols/awareness.js";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { Observable } from "lib0/observable";
import { MESSAGE_AWARENESS, MESSAGE_LOCK, MESSAGE_SYNC } from "../protocol/messageTypes.js";
import type { LockRequestPayload, LockResponsePayload } from "../protocol/lockMessages.js";

// Phase 2: one Y.Doc + one Awareness instance per doc name ("room"), all in
// memory, and no directory semantics beyond "doc name is whatever the
// connection path says" — the server doesn't care what a doc name means,
// that's the client SDK's job (Phase 4's DiskFlushService is the first thing
// that treats a doc name as a file path, and it does so from outside this
// class, via getDocNames()/getDocContent() below). Rooms live for the life of
// the server process (not torn down when the last client leaves) — even with
// Phase 4's disk flush in place, an in-memory room is still the only copy of
// whatever hasn't been flushed yet, so dropping one on a momentary
// all-disconnected state would still be silent data loss.
interface Room {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  /** Which awareness clientIDs were introduced by each connection, so we can clear exactly those on disconnect. */
  clients: Map<WebSocket, Set<number>>;
  /**
   * Phase 6's lock service (spec Section 4/12): at most one lease per room,
   * since a room already *is* one doc/one path. Arbitrated entirely here —
   * this handler runs synchronously per incoming WS message on Node's single
   * event loop, so two "acquire" messages racing for the same room can never
   * actually interleave; whichever is handled first simply wins, no CRDT
   * merge ambiguity involved (unlike the awareness-based approaches this
   * codebase uses elsewhere, a lock needs one arbiter, not eventual
   * consistency). `expiresAt` is the TTL half of "always TTL-based expiry,
   * never graceful-unlock-only" (Section 2); the `ws` close handler below is
   * the other half, for the crash-instead-of-hang case.
   */
  lock: { ownerId: string; expiresAt: number; ws: WebSocket } | null;
}

function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Emitted whenever any room's document content changes — {@link DiskFlushService} listens for this to drive its per-doc debounce. */
export interface DocUpdateEvent {
  docName: string;
  content: string;
}

/** One room's snapshot for the Phase 7 dashboard (`GET /status`) — awareness peer states plus current lock, if any. */
export interface RoomStatus {
  docName: string;
  peers: { clientId: number; state: Record<string, unknown> | null }[];
  lock: { ownerId: string; expiresAt: number } | null;
}

export interface ServerStatus {
  rooms: RoomStatus[];
}

export class SyncServer extends Observable<string> {
  private readonly rooms = new Map<string, Room>();
  private readonly httpServer: HttpServer;
  private readonly wss: WebSocketServer;

  constructor(port: number) {
    super();
    // A plain HTTP server (rather than the ws-managed standalone server
    // `new WebSocketServer({ port })` creates internally) so a non-upgrade
    // GET can be answered directly on the same port — Phase 7's "basic
    // who's-editing-what view" (spec Section 10) is read-only, low-frequency
    // status, not a CRDT/awareness concern, so it doesn't need a new binary
    // wire-protocol message the way Phase 6's lock service did.
    this.httpServer = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/status") {
        const body = JSON.stringify(this.getStatus());
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req.url ?? "/"));
    this.httpServer.listen(port);
  }

  private getRoom(name: string): Room {
    let room = this.rooms.get(name);
    if (!room) {
      const doc = new Y.Doc();
      const awareness = new awarenessProtocol.Awareness(doc);
      // The Awareness constructor gives itself a local state ({}) keyed by
      // doc.clientID, as if the doc itself were a peer. The server isn't a
      // peer, it's the room — clear that phantom entry so it never shows up
      // as a fake "who's editing" participant.
      awareness.setLocalState(null);

      room = { doc, awareness, clients: new Map(), lock: null };
      this.rooms.set(name, room);

      doc.on("update", (update: Uint8Array, origin: unknown) => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeUpdate(encoder, update);
        const message = encoding.toUint8Array(encoder);
        for (const client of room!.clients.keys()) {
          if (client !== origin && client.readyState === WebSocket.OPEN) {
            client.send(message);
          }
        }
        this.emit("docUpdate", [{ docName: name, content: doc.getText("content").toString() } satisfies DocUpdateEvent]);
      });

      awareness.on(
        "update",
        ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
          // Track which clientIDs a given connection is responsible for, so
          // we know what to clear when that connection drops.
          if (origin instanceof WebSocket) {
            const controlled = room!.clients.get(origin);
            if (controlled) {
              for (const id of added) controlled.add(id);
              for (const id of removed) controlled.delete(id);
            }
          }
          const changed = added.concat(updated, removed);
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
          encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
          const message = encoding.toUint8Array(encoder);
          // Broadcast to everyone, including the origin connection — same
          // as the reference y-websocket implementation. It's a no-op for
          // the sender (their own state already matches) rather than a bug.
          for (const client of room!.clients.keys()) {
            if (client.readyState === WebSocket.OPEN) client.send(message);
          }
        },
      );
    }
    return room;
  }

  private handleConnection(ws: WebSocket, url: string): void {
    const docName = new URL(url, "ws://placeholder").pathname.replace(/^\//, "") || "default";
    const room = this.getRoom(docName);
    room.clients.set(ws, new Set());

    // Greet the new client with our current state vector so it can tell us
    // what it's missing (sync step 1 of the Yjs sync protocol).
    const greeting = encoding.createEncoder();
    encoding.writeVarUint(greeting, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(greeting, room.doc);
    ws.send(encoding.toUint8Array(greeting));

    // Bring the new client up to speed on who's already present.
    if (room.awareness.getStates().size > 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(room.awareness.getStates().keys())),
      );
      ws.send(encoding.toUint8Array(encoder));
    }

    ws.on("message", (data: RawData) => {
      const decoder = decoding.createDecoder(toUint8Array(data));
      const outerType = decoding.readVarUint(decoder);

      if (outerType === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
        // readSyncMessage only appends a response for step1 (answered with
        // step2); step2/update messages produce no reply.
        if (encoding.length(encoder) > 1) {
          ws.send(encoding.toUint8Array(encoder));
        }
      } else if (outerType === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws);
      } else if (outerType === MESSAGE_LOCK) {
        const request = JSON.parse(decoding.readVarString(decoder)) as LockRequestPayload;
        const response = this.handleLockRequest(room, ws, request);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_LOCK);
        encoding.writeVarString(encoder, JSON.stringify(response));
        ws.send(encoding.toUint8Array(encoder));
      }
    });

    ws.on("close", () => {
      const controlledIds = room.clients.get(ws);
      room.clients.delete(ws);
      if (controlledIds && controlledIds.size > 0) {
        awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(controlledIds), null);
      }
      // Section 2: "always TTL-based expiry, never graceful-unlock-only" — the
      // TTL check in handleLockRequest covers a hung-but-still-connected
      // holder; this covers the more common case (the holder's process
      // actually exited) without waiting out the lease.
      if (room.lock?.ws === ws) room.lock = null;
    });
  }

  /** Grants, denies, or releases a lock lease for one room. A lease is available if nobody holds it, the current holder's lease expired, or the requester is the current holder (idempotent re-acquire/renew). */
  private handleLockRequest(room: Room, ws: WebSocket, request: LockRequestPayload): LockResponsePayload {
    if (request.kind === "release") {
      if (room.lock?.ownerId === request.ownerId) room.lock = null;
      return { kind: "released", requestId: request.requestId };
    }

    const available = !room.lock || room.lock.expiresAt <= Date.now() || room.lock.ownerId === request.ownerId;
    if (!available) {
      return {
        kind: "denied",
        requestId: request.requestId,
        message: `File is currently locked by another process. Wait briefly and retry.`,
      };
    }
    const expiresAt = Date.now() + request.leaseMs;
    room.lock = { ownerId: request.ownerId, expiresAt, ws };
    return { kind: "granted", requestId: request.requestId, expiresAt };
  }

  /** Every doc name with an active (in-memory) room, in the order rooms were first created. */
  getDocNames(): string[] {
    return Array.from(this.rooms.keys());
  }

  /** Current merged content for a doc, or `undefined` if no room by that name has ever been created. */
  getDocContent(docName: string): string | undefined {
    return this.rooms.get(docName)?.doc.getText("content").toString();
  }

  /**
   * Records a validation-gate rejection (Phase 5, spec Section 6) for a doc,
   * as an entry in a reserved Y.Map on the same Y.Doc as the file content —
   * not a side channel. This rides the existing CRDT sync mechanism to every
   * connected client for that doc automatically (no wire-protocol change),
   * the same way file content itself propagates. `SyncFileOps` consumes
   * (deletes) this entry the next time something tries to write to the doc,
   * surfacing it as an `EVALIDATE` error on that write per Section 3.5/3.6.
   * No-op if the room no longer exists (e.g. server shut down mid-flush).
   */
  setValidationRejection(docName: string, message: string): void {
    this.rooms.get(docName)?.doc.getMap<string>("_validation").set("rejection", message);
  }

  /** Clears a pending validation-rejection notice, e.g. once a later flush of the same doc passes. No-op if none is pending. */
  clearValidationRejection(docName: string): void {
    this.rooms.get(docName)?.doc.getMap<string>("_validation").delete("rejection");
  }

  /** Current lock lease for a doc (Phase 6), or `null` if unlocked/expired/no such room. Read-only — acquiring/releasing goes through the `MESSAGE_LOCK` protocol, not this getter. Mainly for tests/observability. */
  getLockState(docName: string): { ownerId: string; expiresAt: number } | null {
    const lock = this.rooms.get(docName)?.lock;
    if (!lock || lock.expiresAt <= Date.now()) return null;
    return { ownerId: lock.ownerId, expiresAt: lock.expiresAt };
  }

  /** Every room's awareness peers and lock state — the data behind `GET /status` and the CLI dashboard (Phase 7). */
  getStatus(): ServerStatus {
    const rooms: RoomStatus[] = [];
    for (const [docName, room] of this.rooms) {
      const peers = Array.from(room.awareness.getStates().entries()).map(([clientId, state]) => ({
        clientId,
        state: (state as Record<string, unknown> | null) ?? null,
      }));
      const lock = room.lock && room.lock.expiresAt > Date.now() ? { ownerId: room.lock.ownerId, expiresAt: room.lock.expiresAt } : null;
      rooms.push({ docName, peers, lock });
    }
    return { rooms };
  }

  /** Actual bound port — useful when constructed with port 0 (OS-assigned), e.g. in tests. */
  get port(): number {
    const address = this.httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("server is not listening on a TCP port");
    }
    return address.port;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      for (const room of this.rooms.values()) {
        for (const client of room.clients.keys()) client.terminate();
        room.awareness.destroy();
      }
      // `wss` doesn't own `httpServer` (it was handed one), so closing it
      // only stops handling new upgrades — the actual listening socket is
      // `httpServer`'s to close.
      this.wss.close();
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
