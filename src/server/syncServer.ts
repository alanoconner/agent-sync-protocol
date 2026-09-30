import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";
import * as awarenessProtocol from "y-protocols/awareness.js";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { Observable } from "lib0/observable";
import { MESSAGE_AWARENESS, MESSAGE_DURABILITY, MESSAGE_LOCK, MESSAGE_SYNC } from "../protocol/messageTypes.js";
import type { LockRequestPayload, LockResponsePayload } from "../protocol/lockMessages.js";
import { getSyncedFileState, TOMBSTONE_MAP_NAME, type SyncedFileState } from "../sync/fileState.js";
import type { DurabilityRequest, DurabilityResponse } from "../protocol/durabilityMessages.js";
import type { CrdtStore } from "../persistence/crdtStore.js";

// Phase 2: one Y.Doc + one Awareness instance per doc name ("room"), all in
// memory, and no directory semantics beyond "doc name is whatever the
// connection path says" — the server doesn't care what a doc name means,
// that's the client SDK's job (Phase 4's DiskFlushService is the first thing
// that treats a doc name as a file path, and it does so from outside this
// class, via getDocNames()/getDocContent() below). Rooms live for the life of
// the server process (not torn down when the last client leaves). A
// repository-backed runtime also snapshots their full Yjs state; memory-only
// servers still rely on this lifetime rule to avoid dropping live state.
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
  flushedState: SyncedFileState;
  persistenceQueue: Promise<void>;
  persistenceError: unknown;
}

function sameState(a: SyncedFileState, b: SyncedFileState): boolean {
  return a.exists === b.exists && a.content === b.content;
}

export class RecoveryConflictError extends Error {
  constructor(
    readonly docName: string,
    readonly persisted: SyncedFileState,
    readonly flushed: SyncedFileState,
    readonly disk: SyncedFileState,
    readonly persistenceRoot: string,
  ) {
    super(`Recovery conflict for "${docName}": disk and durable CRDT state both changed since the last successful flush. Run \`asl recover ${JSON.stringify(docName)} --use-crdt\` or \`--use-disk\` while the daemon is stopped.`);
    this.name = "RecoveryConflictError";
  }
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

/** Emitted whenever a room's logical content or existence changes — {@link DiskFlushService} listens for this to drive its per-doc debounce. */
export interface DocUpdateEvent extends SyncedFileState {
  docName: string;
}

/** One room's snapshot for the Phase 7 dashboard (`GET /status`) — awareness peer states plus current lock, if any. */
export interface RoomStatus {
  docName: string;
  deleted: boolean;
  peers: { clientId: number; state: Record<string, unknown> | null }[];
  lock: { ownerId: string; expiresAt: number } | null;
}

export interface ServerStatus {
  rooms: RoomStatus[];
}

/** Emitted once per room after `hydrate` establishes its present or deleted disk state, before any client is greeted. */
export interface DocHydratedEvent extends SyncedFileState {
  docName: string;
}

/** Emitted after a room is reconstructed from durable Yjs state. */
export interface DocRecoveredEvent extends SyncedFileState {
  docName: string;
  flushedState: SyncedFileState;
  validationRejected: boolean;
}

export interface SyncServerOptions {
  /** Optional bind host. ASL-managed daemons use 127.0.0.1; omitted preserves the historical all-interface behavior. */
  host?: string;
  /**
   * Initial logical state for a room that's being created for the first time.
   * `undefined` means use the historical present-but-empty default. Called exactly once per room, on
   * creation, synchronously and *before* the first client is greeted, so a
   * connecting client's sync-step-1 exchange already carries the seeded
   * content rather than racing against it. The server still has no idea what
   * a doc name means — `createDiskHydrator` (src/flush/diskHydration.ts) is
   * what treats it as a path under a repo root, from outside this class.
   */
  hydrate?: (docName: string) => SyncedFileState | string | undefined;
  /** Durable full-document snapshots for repository-backed runtimes. */
  persistence?: CrdtStore;
}

export class SyncServer extends Observable<string> {
  private readonly rooms = new Map<string, Room>();
  private readonly httpServer: HttpServer;
  private readonly wss: WebSocketServer;

  private readonly hydrate: SyncServerOptions["hydrate"];
  private readonly persistence: CrdtStore | undefined;

  constructor(port: number, options: SyncServerOptions = {}) {
    super();
    this.hydrate = options.hydrate;
    this.persistence = options.persistence;
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
    this.httpServer.listen(port, options.host);
  }

  private getRoom(name: string): Room {
    let room = this.rooms.get(name);
    if (!room) {
      const doc = new Y.Doc();
      const persisted = this.persistence?.load(name);
      let initial: SyncedFileState;
      let recovered = false;
      if (persisted) {
        Y.applyUpdate(doc, persisted.update);
        initial = getSyncedFileState(doc);
        recovered = true;
        const hydrated = this.hydrate?.(name);
        const disk = typeof hydrated === "string" ? { exists: true, content: hydrated } : hydrated;
        if (disk && !sameState(disk, persisted.flushedState) && !sameState(disk, initial)) {
          throw new RecoveryConflictError(name, initial, persisted.flushedState, disk, this.persistence!.root);
        }
      } else {
        const hydrated = this.hydrate?.(name);
        initial = typeof hydrated === "string"
          ? { exists: true, content: hydrated }
          : hydrated ?? { exists: true, content: "" };
        if (initial.exists) {
          if (initial.content) doc.getText("content").insert(0, initial.content);
        } else {
          doc.getMap<boolean>(TOMBSTONE_MAP_NAME).set("hydrated", true);
        }
      }
      const awareness = new awarenessProtocol.Awareness(doc);
      // The Awareness constructor gives itself a local state ({}) keyed by
      // doc.clientID, as if the doc itself were a peer. The server isn't a
      // peer, it's the room — clear that phantom entry so it never shows up
      // as a fake "who's editing" participant.
      awareness.setLocalState(null);

      room = {
        doc,
        awareness,
        clients: new Map(),
        lock: null,
        flushedState: persisted?.flushedState ?? initial,
        persistenceQueue: Promise.resolve(),
        persistenceError: undefined,
      };
      this.rooms.set(name, room);

      doc.on("update", (update: Uint8Array, origin: unknown) => {
        const logicalState = getSyncedFileState(doc);
        const publish = () => {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.writeUpdate(encoder, update);
          const message = encoding.toUint8Array(encoder);
          for (const client of room!.clients.keys()) {
            if (client !== origin && client.readyState === WebSocket.OPEN) client.send(message);
          }
          this.emit("docUpdate", [{ docName: name, ...logicalState } satisfies DocUpdateEvent]);
        };
        if (!this.persistence) {
          publish();
          return;
        }
        const snapshot = Y.encodeStateAsUpdate(doc);
        const flushedState = { ...room!.flushedState };
        const task = room!.persistenceQueue.then(async () => {
          await this.persistence!.save(name, snapshot, flushedState);
          publish();
        });
        room!.persistenceQueue = task;
        void task.catch((error) => { room!.persistenceError = error; });
      });

      if (!persisted && this.persistence) {
        const snapshot = Y.encodeStateAsUpdate(doc);
        room.persistenceQueue = this.persistence.save(name, snapshot, room.flushedState).then(() => undefined);
        void room.persistenceQueue.catch((error) => { room!.persistenceError = error; });
      }

      if (recovered) {
        this.emit("docRecovered", [{
          docName: name,
          ...initial,
          flushedState: { ...room.flushedState },
          validationRejected: doc.getMap<string>("_validation").has("rejection"),
        } satisfies DocRecoveredEvent]);
      } else {
        this.emit("docHydrated", [{ docName: name, ...initial } satisfies DocHydratedEvent]);
      }

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
    let docName: string;
    try {
      docName = decodeURIComponent(new URL(url, "ws://placeholder").pathname.replace(/^\//, "")) || "default";
    } catch {
      ws.close(1008, "Invalid document path encoding");
      return;
    }
    let room: Room;
    try {
      room = this.getRoom(docName);
    } catch (error) {
      ws.close(1011, error instanceof Error ? error.message.slice(0, 120) : "Room recovery failed");
      return;
    }
    if (room.persistenceError) {
      ws.close(1011, "Durable CRDT storage for this room is unavailable");
      return;
    }
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

      // A failed save may settle between the update and the following
      // durability barrier. Let that barrier through so the client receives
      // the stored error immediately instead of waiting for its timeout.
      if (room.persistenceError && outerType !== MESSAGE_DURABILITY) {
        ws.close(1011, "Durable CRDT storage for this room is unavailable");
        return;
      }

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
      } else if (outerType === MESSAGE_DURABILITY) {
        const request = JSON.parse(decoding.readVarString(decoder)) as DurabilityRequest;
        void this.handleDurabilityRequest(room, ws, request);
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

  private async handleDurabilityRequest(room: Room, ws: WebSocket, request: DurabilityRequest): Promise<void> {
    let response: DurabilityResponse;
    try {
      await room.persistenceQueue;
      if (room.persistenceError) throw room.persistenceError;
      response = { kind: "durable", requestId: request.requestId, persistent: this.persistence !== undefined };
    } catch (error) {
      response = {
        kind: "error",
        requestId: request.requestId,
        message: `CRDT persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_DURABILITY);
    encoding.writeVarString(encoder, JSON.stringify(response));
    ws.send(encoding.toUint8Array(encoder));
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

  /** Current logical state for a doc, or `undefined` if no room by that name has ever been created. */
  getDocState(docName: string): SyncedFileState | undefined {
    const room = this.rooms.get(docName);
    return room ? getSyncedFileState(room.doc) : undefined;
  }

  /** Current merged content for a live doc; tombstoned and unknown docs return `undefined`. */
  getDocContent(docName: string): string | undefined {
    const state = this.getDocState(docName);
    return state?.exists ? state.content : undefined;
  }

  /** Recreates named rooms, including one-time migration from the legacy known-doc inventory. */
  preloadDocNames(docNames: string[]): void {
    for (const docName of docNames) this.getRoom(docName);
  }

  /** Reconstructs every durable room before a repository-backed server is exposed to clients. */
  preloadPersistedDocNames(): void {
    this.preloadDocNames(this.persistence?.listRoomNames() ?? []);
  }

  /** Waits until every update currently accepted for a room is on durable storage. */
  async whenDocPersisted(docName: string): Promise<void> {
    const room = this.rooms.get(docName);
    if (!room) return;
    await room.persistenceQueue;
    if (room.persistenceError) throw room.persistenceError;
  }

  /** Records the logical disk/Git checkpoint only after a flush has succeeded. */
  async markDocFlushed(docName: string, state: SyncedFileState): Promise<void> {
    const room = this.rooms.get(docName);
    if (!room) return;
    const previous = room.flushedState;
    room.flushedState = { ...state };
    if (!this.persistence) return;
    const snapshot = Y.encodeStateAsUpdate(room.doc);
    const checkpoint = { ...state };
    const task = room.persistenceQueue.then(() => this.persistence!.save(docName, snapshot, checkpoint)).then(() => undefined);
    room.persistenceQueue = task;
    void task.catch((error) => { room.persistenceError = error; });
    try { await task; }
    catch (error) {
      room.flushedState = previous;
      throw error;
    }
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
  async setValidationRejection(docName: string, message: string): Promise<void> {
    this.rooms.get(docName)?.doc.getMap<string>("_validation").set("rejection", message);
    await this.whenDocPersisted(docName);
  }

  /** Clears a pending validation-rejection notice, e.g. once a later flush of the same doc passes. No-op if none is pending. */
  async clearValidationRejection(docName: string): Promise<void> {
    this.rooms.get(docName)?.doc.getMap<string>("_validation").delete("rejection");
    await this.whenDocPersisted(docName);
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
      rooms.push({ docName, deleted: !getSyncedFileState(room.doc).exists, peers, lock });
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

  whenListening(): Promise<void> {
    if (this.httpServer.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.httpServer.once("listening", resolve);
      this.httpServer.once("error", reject);
    });
  }

  async close(): Promise<void> {
    for (const room of this.rooms.values()) {
      for (const client of room.clients.keys()) client.terminate();
    }
    let persistenceError: unknown;
    try { await Promise.all([...this.rooms.values()].map((room) => room.persistenceQueue)); }
    catch (error) { persistenceError = error; }
    try {
      for (const room of this.rooms.values()) room.awareness.destroy();
      this.wss.close();
      await new Promise<void>((resolve, reject) => {
        this.httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    } finally {
      this.persistence?.close();
    }
    if (persistenceError) throw persistenceError;
  }
}
