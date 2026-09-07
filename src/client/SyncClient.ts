import { WebSocket, type RawData } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync.js";
import * as awarenessProtocol from "y-protocols/awareness.js";
import { Observable } from "lib0/observable";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { MESSAGE_AWARENESS, MESSAGE_LOCK, MESSAGE_SYNC } from "../protocol/messageTypes.js";
import type { LockRequestPayload, LockResponsePayload } from "../protocol/lockMessages.js";

export interface ReconnectOptions {
  /** Delay before the first reconnect attempt. Doubles on each subsequent failure. */
  baseDelayMs?: number;
  /** Upper bound on the backoff delay, however many attempts have failed. */
  maxDelayMs?: number;
}

export interface SyncClientOptions {
  /** e.g. "ws://localhost:4600" */
  serverUrl: string;
  /** Identifies which doc/"room" to sync — a file path, in the real system. */
  docName: string;
  /** Set to false to disable automatic reconnect after an unintended disconnect. Defaults to true. */
  autoReconnect?: boolean;
  reconnect?: ReconnectOptions;
}

export type ConnectionStatus = "connected" | "disconnected" | "reconnecting";

/**
 * Minimal client for Phases 1–2: connects to the sync server, keeps a Y.Doc
 * and an Awareness (presence) instance in sync over the wire, and
 * reconnects with backoff on an unintended disconnect. This is not yet the
 * tool-binding SDK from Section 3 (that's Phase 3) — just the transport +
 * CRDT/presence plumbing it will sit on top of.
 */
export class SyncClient extends Observable<string> {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly autoReconnect: boolean;
  private readonly reconnectOptions: Required<ReconnectOptions>;
  private synced = false;
  private syncedWaiters: Array<() => void> = [];
  /** True once the caller has explicitly called close() — disables auto-reconnect. */
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lockRequestCounter = 0;
  private readonly pendingLockRequests = new Map<string, (response: LockResponsePayload) => void>();

  constructor(options: SyncClientOptions) {
    super();
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    // The Awareness constructor defaults local state to `{}`, as if the
    // client were already declaring a (contentless) presence. Clear it —
    // an agent that hasn't called setPresence() shouldn't show up as a
    // phantom peer in everyone else's list (same reasoning as the server
    // clearing its own room-doc's phantom self-entry).
    this.awareness.setLocalState(null);
    this.url = `${options.serverUrl.replace(/\/$/, "")}/${options.docName}`;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectOptions = {
      baseDelayMs: options.reconnect?.baseDelayMs ?? 200,
      maxDelayMs: options.reconnect?.maxDelayMs ?? 10_000,
    };

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return; // this update came from the server; don't echo it back
      this.sendSyncUpdate(update);
    });

    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changed = added.concat(updated, removed);
        this.sendAwarenessUpdate(awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      },
    );
  }

  connect(): Promise<void> {
    this.closedByUser = false;
    this.reconnectAttempt = 0;
    return this.openSocket();
  }

  /** Sets this client's presence state (e.g. `{ agentId, filePath, status }`), broadcast to every other peer on this doc. Pass `null` to go offline without disconnecting. */
  setPresence(state: Record<string, unknown> | null): void {
    this.awareness.setLocalState(state);
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;

      ws.on("open", () => {
        this.reconnectAttempt = 0;
        this.emit("status", [{ status: "connected" satisfies ConnectionStatus }]);

        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, this.doc);
        ws.send(encoding.toUint8Array(encoder));

        // The server has no memory of us across a reconnect — re-announce
        // our presence rather than waiting for the next state change.
        // Must go through setLocalState (not a raw re-encode of the
        // existing state) so the clock actually advances: the server
        // dropped our old entry without bumping its clock (only a *local*
        // removal does that), so re-sending the same clock would be
        // rejected by the receiving side's staleness check as a no-op.
        // This mirrors Awareness's own internal heartbeat-renewal pattern.
        if (this.awareness.getLocalState() !== null) {
          this.awareness.setLocalState(this.awareness.getLocalState());
        }

        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on("message", (data: RawData) => this.handleMessage(data));

      ws.on("close", () => {
        this.ws = null;
        this.synced = false;
        // We can no longer vouch for any peer's presence — clear everyone
        // but ourselves rather than let stale "still editing" state linger.
        awarenessProtocol.removeAwarenessStates(
          this.awareness,
          Array.from(this.awareness.getStates().keys()).filter((id) => id !== this.awareness.clientID),
          this,
        );
        // Any lock request still in flight will never get its reply now —
        // fail it rather than leaving the caller's awaited promise hanging.
        for (const resolve of this.pendingLockRequests.values()) {
          resolve({ kind: "denied", requestId: "", message: "Connection closed before the lock request completed." });
        }
        this.pendingLockRequests.clear();
        this.emit("status", [{ status: "disconnected" satisfies ConnectionStatus }]);
        if (!settled) settled = true;
        if (!this.closedByUser && this.autoReconnect) this.scheduleReconnect();
      });

      ws.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        // 'close' always follows 'error' for a failed connection and will
        // schedule the actual reconnect — nothing further to do here.
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const attempt = this.reconnectAttempt++;
    const exp = Math.min(this.reconnectOptions.maxDelayMs, this.reconnectOptions.baseDelayMs * 2 ** attempt);
    const delayMs = exp * (0.5 + Math.random() * 0.5); // jitter so many clients don't retry in lockstep
    this.emit("status", [{ status: "reconnecting" satisfies ConnectionStatus, attempt: attempt + 1, delayMs }]);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket().catch(() => {
        /* the 'close' handler above will run and schedule the next attempt */
      });
    }, delayMs);
  }

  private handleMessage(data: RawData): void {
    const buf = Array.isArray(data)
      ? new Uint8Array(Buffer.concat(data))
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    const decoder = decoding.createDecoder(buf);
    const outerType = decoding.readVarUint(decoder);

    if (outerType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const syncType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 1 && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(encoding.toUint8Array(encoder));
      }
      // Only a step2 reply actually carries the peer's data into our doc;
      // a step1 (their state vector) doesn't mean we're caught up yet.
      if (!this.synced && syncType === syncProtocol.messageYjsSyncStep2) {
        this.synced = true;
        this.syncedWaiters.splice(0).forEach((resolve) => resolve());
      }
    } else if (outerType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    } else if (outerType === MESSAGE_LOCK) {
      const response = JSON.parse(decoding.readVarString(decoder)) as LockResponsePayload;
      const resolve = this.pendingLockRequests.get(response.requestId);
      if (resolve) {
        this.pendingLockRequests.delete(response.requestId);
        resolve(response);
      }
    }
  }

  /**
   * Phase 6 (spec Section 4/12): requests the room's single lock lease.
   * Idempotent for the same `ownerId` — also how a caller renews a lease it
   * already holds, by calling this again before `leaseMs` elapses. Resolves
   * to `{kind: "denied", ...}` rather than throwing on contention — the
   * caller (`SyncFileOps`) decides how to surface that, per Section 3.5.
   */
  acquireLock(ownerId: string, leaseMs: number): Promise<LockResponsePayload> {
    return this.sendLockRequest({ kind: "acquire", requestId: this.nextLockRequestId(), ownerId, leaseMs });
  }

  /** Releases the room's lock lease if `ownerId` currently holds it; a no-op (still resolves) otherwise. */
  releaseLock(ownerId: string): Promise<LockResponsePayload> {
    return this.sendLockRequest({ kind: "release", requestId: this.nextLockRequestId(), ownerId });
  }

  private nextLockRequestId(): string {
    return `${this.doc.clientID}-${this.lockRequestCounter++}`;
  }

  private sendLockRequest(request: LockRequestPayload): Promise<LockResponsePayload> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ kind: "denied", requestId: request.requestId, message: "Not connected to the sync server." });
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_LOCK);
    encoding.writeVarString(encoder, JSON.stringify(request));
    this.ws.send(encoding.toUint8Array(encoder));
    return new Promise((resolve) => this.pendingLockRequests.set(request.requestId, resolve));
  }

  private sendSyncUpdate(update: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.ws.send(encoding.toUint8Array(encoder));
  }

  private sendAwarenessUpdate(update: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, update);
    this.ws.send(encoding.toUint8Array(encoder));
  }

  /** Resolves once this client has completed its most recent sync with the server (waits again after a reconnect). */
  whenSynced(): Promise<void> {
    if (this.synced) return Promise.resolve();
    return new Promise((resolve) => this.syncedWaiters.push(resolve));
  }

  getText(name = "content"): Y.Text {
    return this.doc.getText(name);
  }

  /** Test-only hook: hard-drops the socket (no close handshake) without marking this client as intentionally closed, so auto-reconnect kicks in — simulates a real network drop rather than a deliberate close(). */
  simulateNetworkDrop(): void {
    this.ws?.terminate();
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.awareness.destroy();
  }
}
