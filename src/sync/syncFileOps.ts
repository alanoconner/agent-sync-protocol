import { randomUUID } from "node:crypto";
import type * as Y from "yjs";
import { SyncClient } from "../client/SyncClient.js";
import { clearObservedTombstones, getSyncedFileState, type SyncedFileState, TOMBSTONE_MAP_NAME } from "./fileState.js";
import { toLf } from "./lineEndings.js";
import { applyContentDiff, computeMinimalReplacement } from "./textMerge.js";

/**
 * Thrown when a range_replace-style write's `oldStr` doesn't match the file's
 * current content exactly once — either it's not there at all (someone else's
 * concurrent edit moved on since this agent last read the file) or it appears
 * more than once (the edit's target location is ambiguous). Per spec Section
 * 3.2, this is never resolved with a fuzzy match — only a hard rejection, since
 * a silent wrong-location write is worse than a rejection.
 */
export class RangeMismatchError extends Error {
  readonly code = "EAGAIN";
  constructor(path: string, reason: "not_found" | "ambiguous") {
    super(
      reason === "not_found"
        ? `File was modified concurrently and could not be automatically merged: the expected text was not found in "${path}". Re-read the file before retrying your edit.`
        : `The expected text appears more than once in "${path}" and the edit's target location is ambiguous. Re-read the file and recompute the edit; do not retry the same replacement unchanged.`,
    );
    this.name = "RangeMismatchError";
  }
}

export class FileNotFoundError extends Error {
  readonly code = "ENOENT";
  constructor(path: string) {
    super(`No such synchronized file: "${path}".`);
    this.name = "FileNotFoundError";
  }
}

/**
 * Thrown when a write targets a doc whose last flush was rejected by the
 * validation gate (Section 6/Phase 5) and nobody has retried it since. The
 * rejection is carried as a small Y.Map entry (`_validation` / `rejection`)
 * inside the same Y.Doc as the file's content — it rides the existing
 * CRDT sync channel to every connected `SyncFileOps`/`SyncClient` for that
 * doc with no wire-protocol changes, the same way file content itself
 * propagates. Consumed once: the write that observes it deletes the entry
 * (an ordinary CRDT delete, so it converges everywhere) and is rejected;
 * the next write proceeds normally against current reality, per the spec's
 * "leave pre-flush state active so agents can retry" guidance.
 */
export class ValidationRejectedError extends Error {
  readonly code = "EVALIDATE";
  constructor(message: string) {
    super(message);
    this.name = "ValidationRejectedError";
  }
}

const VALIDATION_MAP_NAME = "_validation";
const VALIDATION_REJECTION_KEY = "rejection";

/**
 * Thrown when a write targets a path declared `exclusive` (Phase 6, spec
 * Section 2/7) whose lock lease is currently held by a different owner.
 * Per Section 3.5/3.6, this surfaces as if the file were locked at the OS
 * level — `EBUSY`, with the spec's recommended "wait briefly and retry"
 * text — never a novel response shape. The SDK does not retry on the
 * caller's behalf: like `RangeMismatchError`/`ValidationRejectedError`,
 * that decision belongs to whatever's driving the agent.
 */
export class LockDeniedError extends Error {
  readonly code = "EBUSY";
  constructor(path: string, serverMessage: string) {
    // `serverMessage` is already the spec's full recommended EBUSY text
    // (Section 3.6) — just append the path (Section 3.6's "include concrete
    // identifiers wherever available") rather than re-wrapping it in a
    // second copy of the same sentence.
    super(`${serverMessage} ("${path}")`);
    this.name = "LockDeniedError";
  }
}

const DEFAULT_LOCK_LEASE_MS = 10_000;

export interface SyncFileOpsOptions {
  serverUrl: string;
  /**
   * Paths that go through the lock service (Phase 6) instead of relying on
   * pure CRDT merge alone for writes — spec Section 7's `paths.exclusive`
   * concept, declared here explicitly since `.agent-sync.yml` (Phase 7)
   * doesn't exist yet. Reserve for files where textual merging is likely to
   * produce garbage (shared config, schema files); everything else keeps
   * relying purely on CRDT merge with no lock overhead at all.
   */
  exclusivePaths?: string[];
  /** Identifies this `SyncFileOps` instance (one agent/process) as a lock owner. Defaults to a fresh random id — override only if you need this instance's identity to be stable/inspectable across restarts. */
  ownerId?: string;
  /** Lease length for an exclusive-path lock, per write. Spec Section 12: too short causes false expiry mid-write; too long blocks unnecessarily on a crashed peer. Default 10s comfortably covers one write's round trip. */
  lockLeaseMs?: number;
}

/** Never fuzzy-matched (Section 3.2): `oldStr` must appear in the live text exactly once, or the whole edit is rejected. */
function applyExactReplace(ytext: Y.Text, path: string, oldStr: string, newStr: string): void {
  const current = ytext.toString();
  const firstIndex = current.indexOf(oldStr);
  if (firstIndex === -1) throw new RangeMismatchError(path, "not_found");
  if (current.indexOf(oldStr, firstIndex + 1) !== -1) throw new RangeMismatchError(path, "ambiguous");
  ytext.doc!.transact(() => {
    ytext.delete(firstIndex, oldStr.length);
    ytext.insert(firstIndex, newStr);
  });
}

/**
 * Normalized read/write operations against the sync layer — the "editFile" /
 * "readFile" calls that Section 3.1/3.2/3.3a all say every interception
 * mechanism (MCP proxy, FUSE mount, direct rebinding) should funnel into. Each
 * mechanism translates its own transport's shape into calls here; none of them
 * talk to a Y.Doc or SyncClient directly.
 */
export class SyncFileOps {
  private readonly clients = new Map<string, SyncClient>();
  private readonly pending = new Map<string, Promise<SyncClient>>();
  private readonly exclusivePaths: Set<string>;
  private readonly ownerId: string;
  private readonly lockLeaseMs: number;

  constructor(private readonly options: SyncFileOpsOptions) {
    this.exclusivePaths = new Set(options.exclusivePaths ?? []);
    this.ownerId = options.ownerId ?? randomUUID();
    this.lockLeaseMs = options.lockLeaseMs ?? DEFAULT_LOCK_LEASE_MS;
  }

  private getClient(path: string): Promise<SyncClient> {
    const existing = this.clients.get(path);
    if (existing) return Promise.resolve(existing);
    let pending = this.pending.get(path);
    if (!pending) {
      pending = (async () => {
        const client = new SyncClient({ serverUrl: this.options.serverUrl, docName: path });
        try {
          await client.connect();
          await client.whenSynced();
          this.clients.set(path, client);
          return client;
        } catch (err) {
          client.close();
          throw err;
        } finally {
          this.pending.delete(path);
        }
      })();
      this.pending.set(path, pending);
    }
    return pending;
  }

  async readFile(path: string): Promise<string> {
    const state = await this.readFileState(path);
    if (!state.exists) throw new FileNotFoundError(path);
    return state.content;
  }

  async readFileState(path: string): Promise<SyncedFileState> {
    const client = await this.getClient(path);
    return getSyncedFileState(client.doc);
  }

  /**
   * Non-consuming peek at whether the next write to `path` would currently be
   * rejected by a pending validation-gate notice. Writes always re-check for
   * real via `consumePendingRejection` below; this exists so callers (mainly
   * tests) can observe that a server-set rejection has actually propagated to
   * this client over the wire, without the observation itself consuming it.
   */
  async hasPendingRejection(path: string): Promise<boolean> {
    const client = await this.getClient(path);
    return client.doc.getMap<string>(VALIDATION_MAP_NAME).has(VALIDATION_REJECTION_KEY);
  }

  /**
   * Section 3.6's rejection message is about mutations, so reads never
   * consume it; writes, recreation, and deletion do.
   */
  private consumePendingRejection(client: SyncClient): void {
    const map = client.doc.getMap<string>(VALIDATION_MAP_NAME);
    const message = map.get(VALIDATION_REJECTION_KEY);
    if (message === undefined) return;
    map.delete(VALIDATION_REJECTION_KEY);
    throw new ValidationRejectedError(message);
  }

  /**
   * Gates a mutation behind the path's lock lease, for `exclusivePaths` only —
   * everything else runs `fn` directly with no lock-service round trip at
   * all. Scoped to exactly one write: acquires immediately before `fn`,
   * releases in a `finally` immediately after, rather than holding a lease
   * across multiple separate tool calls. A crashed holder is still covered
   * (Section 2's "always TTL-based expiry") by the lease's own `expiresAt`,
   * not just this `finally` — see `SyncServer`'s lock-close cleanup for the
   * other half (an actual disconnect frees the lease immediately, without
   * waiting out the TTL).
   *
   * Checked before `consumePendingRejection` (folded into `fn` by callers)
   * so a lock denial doesn't silently consume a one-shot validation
   * rejection notice the agent hasn't seen yet.
   */
  private async withExclusiveLock<T>(path: string, client: SyncClient, fn: () => T | Promise<T>): Promise<T> {
    if (!this.exclusivePaths.has(path)) return fn();

    const response = await client.acquireLock(this.ownerId, this.lockLeaseMs);
    if (response.kind === "denied") {
      throw new LockDeniedError(path, response.message);
    }
    try {
      return await fn();
    } finally {
      await client.releaseLock(this.ownerId);
    }
  }

  /** Blind full-buffer write with no record of what the writer last saw — diffed against live content (see textMerge.ts for the tradeoff this implies). */
  async writeFileFull(path: string, content: string): Promise<void> {
    const client = await this.getClient(path);
    await this.withExclusiveLock(path, client, () => {
      this.consumePendingRejection(client);
      client.doc.transact(() => {
        clearObservedTombstones(client.doc);
        applyContentDiff(client.getText(), toLf(content));
      });
    });
  }

  /**
   * Full-buffer write where the caller can prove what it believed the prior
   * content was (e.g. a FUSE fd's own open-time snapshot). Per spec Section
   * 3.3a, this goes through "the same range_replace-vs-full_replace and
   * match-or-reject logic as Section 3.2" — so rather than blindly diffing the
   * stale snapshot against live content, the writer's own before/after is
   * collapsed to a minimal `old_str`/`new_str` pair and applied with the exact
   * same exact-match-or-reject discipline as an explicit range_replace call.
   * If a concurrent edit touched the exact span this write meant to change,
   * the whole write is rejected rather than guessing.
   */
  async writeFileFromSnapshot(path: string, oldSnapshot: string | null, newContent: string): Promise<void> {
    const client = await this.getClient(path);
    await this.withExclusiveLock(path, client, () => {
      this.consumePendingRejection(client);
      const ytext = client.getText();
      const normalizedNewContent = toLf(newContent);
      const deleted = client.doc.getMap<boolean>(TOMBSTONE_MAP_NAME).size > 0;

      if (oldSnapshot === null) {
        if (!deleted) throw new RangeMismatchError(path, "not_found");
        client.doc.transact(() => {
          clearObservedTombstones(client.doc);
          applyContentDiff(ytext, normalizedNewContent);
        });
        return;
      }

      if (deleted) throw new RangeMismatchError(path, "not_found");
      const normalizedOldSnapshot = toLf(oldSnapshot);
      if (normalizedOldSnapshot === normalizedNewContent) return;

      if (ytext.toString() === normalizedOldSnapshot) {
        applyContentDiff(ytext, normalizedNewContent);
        return;
      }

      const replacement = computeMinimalReplacement(normalizedOldSnapshot, normalizedNewContent);
      if (!replacement) return;

      if (replacement.oldStr === "") {
        // No anchor text to match against — e.g. the file was empty when this
        // fd's snapshot was taken. Only safe to apply blind if nothing has
        // changed concurrently; otherwise there's no exact text to match, so
        // reject rather than guess where the new content belongs.
        throw new RangeMismatchError(path, "not_found");
      }

      applyExactReplace(ytext, path, replacement.oldStr, replacement.newStr);
    });
  }

  /** Exact-match-or-reject range replace, per spec 3.2. */
  async writeFileRange(path: string, oldStr: string, newStr: string): Promise<void> {
    const client = await this.getClient(path);
    await this.withExclusiveLock(path, client, () => {
      this.consumePendingRejection(client);
      if (client.doc.getMap<boolean>(TOMBSTONE_MAP_NAME).size > 0) throw new FileNotFoundError(path);
      applyExactReplace(client.getText(), path, toLf(oldStr), toLf(newStr));
    });
  }

  /** Deletes the path's current synchronized state. */
  async deleteFile(path: string): Promise<void> {
    const client = await this.getClient(path);
    const state = getSyncedFileState(client.doc);
    if (!state.exists) throw new FileNotFoundError(path);
    await this.deleteWithClient(path, client, state.content);
  }

  /** Deletes only if the live file still exactly matches the caller's snapshot. */
  async deleteFileFromSnapshot(path: string, oldSnapshot: string): Promise<void> {
    const client = await this.getClient(path);
    await this.deleteWithClient(path, client, toLf(oldSnapshot));
  }

  private async deleteWithClient(path: string, client: SyncClient, expectedContent: string): Promise<void> {
    await this.withExclusiveLock(path, client, () => {
      this.consumePendingRejection(client);
      const state = getSyncedFileState(client.doc);
      if (!state.exists || state.content !== expectedContent) throw new RangeMismatchError(path, "not_found");
      client.doc.getMap<boolean>(TOMBSTONE_MAP_NAME).set(randomUUID(), true);
    });
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    this.pending.clear();
  }
}
