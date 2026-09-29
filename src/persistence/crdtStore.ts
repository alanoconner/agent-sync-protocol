import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { SyncedFileState } from "../sync/fileState.js";

const STORE_VERSION = 1;
const SNAPSHOT_PATTERN = /^([a-f0-9]{64})-(\d+)\.json$/;

interface SnapshotPayload {
  version: typeof STORE_VERSION;
  docName: string;
  generation: number;
  update: string;
  flushedState: SyncedFileState;
}

interface SnapshotFile extends SnapshotPayload {
  checksum: string;
}

export interface PersistedRoom {
  docName: string;
  generation: number;
  update: Uint8Array;
  flushedState: SyncedFileState;
}

function checksum(payload: SnapshotPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function roomHash(docName: string): string {
  return createHash("sha256").update(docName).digest("hex");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Opening directories is not supported by Node on every Windows
    // filesystem. The snapshot file itself has already been fsynced.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseSnapshot(path: string): PersistedRoom {
  let parsed: SnapshotFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as SnapshotFile;
  } catch (error) {
    throw new Error(`cannot read CRDT snapshot ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const payload: SnapshotPayload = {
    version: parsed.version,
    docName: parsed.docName,
    generation: parsed.generation,
    update: parsed.update,
    flushedState: parsed.flushedState,
  };
  if (
    parsed.version !== STORE_VERSION
    || typeof parsed.docName !== "string"
    || !Number.isSafeInteger(parsed.generation)
    || typeof parsed.update !== "string"
    || typeof parsed.flushedState?.exists !== "boolean"
    || typeof parsed.flushedState?.content !== "string"
    || parsed.checksum !== checksum(payload)
  ) {
    throw new Error(`CRDT snapshot is corrupt or unsupported: ${path}`);
  }
  return {
    docName: parsed.docName,
    generation: parsed.generation,
    update: Uint8Array.from(Buffer.from(parsed.update, "base64")),
    flushedState: { ...parsed.flushedState },
  };
}

/**
 * A small, dependency-free, repository-local persistence layer for complete
 * Yjs document snapshots. Snapshot generations are immutable: a crash can
 * leave an ignored temporary file, but never partially replace the last
 * acknowledged generation.
 */
export class CrdtStore {
  private readonly rooms = new Map<string, PersistedRoom>();
  private readonly files = new Map<string, string[]>();
  private readonly lockPath: string;
  private readonly lockToken = randomBytes(16).toString("hex");
  private closed = false;

  constructor(readonly root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.lockPath = join(this.root, "lock");
    this.acquireLock();
    try { this.loadSnapshots(); }
    catch (error) {
      this.close();
      throw error;
    }
  }

  private acquireLock(): void {
    for (;;) {
      try {
        mkdirSync(this.lockPath);
        writeFileSync(
          join(this.lockPath, "owner.json"),
          `${JSON.stringify({ pid: process.pid, token: this.lockToken })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owner: { pid?: number } = {};
        let lockAgeMs = 0;
        try { lockAgeMs = Date.now() - statSync(this.lockPath).mtimeMs; }
        catch { /* disappearance is handled by the next loop */ }
        try { owner = JSON.parse(readFileSync(join(this.lockPath, "owner.json"), "utf8")) as { pid?: number }; }
        catch { /* owner metadata may still be in its creation window */ }
        if (typeof owner.pid === "number" && processAlive(owner.pid)) {
          throw new Error(`CRDT persistence store is already in use by process ${owner.pid}: ${this.root}`);
        }
        if (typeof owner.pid !== "number" && lockAgeMs < 2_000) {
          throw new Error(`CRDT persistence store lock is still being initialized: ${this.root}`);
        }
        rmSync(this.lockPath, { recursive: true, force: true });
      }
    }
  }

  private loadSnapshots(): void {
    const grouped = new Map<string, Array<{ generation: number; name: string }>>();
    for (const name of readdirSync(this.root)) {
      if (name.includes(".tmp-")) {
        rmSync(join(this.root, name), { force: true });
        continue;
      }
      const match = SNAPSHOT_PATTERN.exec(name);
      if (!match) continue;
      const list = grouped.get(match[1]) ?? [];
      list.push({ generation: Number(match[2]), name });
      grouped.set(match[1], list);
    }
    for (const [hash, candidates] of grouped) {
      candidates.sort((a, b) => b.generation - a.generation);
      const latest = candidates[0];
      const room = parseSnapshot(join(this.root, latest.name));
      if (roomHash(room.docName) !== hash || room.generation !== latest.generation) {
        throw new Error(`CRDT snapshot identity mismatch: ${join(this.root, latest.name)}`);
      }
      this.rooms.set(room.docName, room);
      this.files.set(room.docName, candidates.map(({ name }) => name));
    }
  }

  listRoomNames(): string[] {
    return [...this.rooms.keys()];
  }

  load(docName: string): PersistedRoom | undefined {
    const room = this.rooms.get(docName);
    return room ? { ...room, update: room.update.slice(), flushedState: { ...room.flushedState } } : undefined;
  }

  async save(docName: string, update: Uint8Array, flushedState: SyncedFileState): Promise<PersistedRoom> {
    if (this.closed) throw new Error("CRDT persistence store is closed");
    const generation = (this.rooms.get(docName)?.generation ?? 0) + 1;
    const payload: SnapshotPayload = {
      version: STORE_VERSION,
      docName,
      generation,
      update: Buffer.from(update).toString("base64"),
      flushedState: { ...flushedState },
    };
    const file: SnapshotFile = { ...payload, checksum: checksum(payload) };
    const hash = roomHash(docName);
    const finalName = `${hash}-${generation}.json`;
    const temporaryName = `${finalName}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const temporaryPath = join(this.root, temporaryName);
    const finalPath = join(this.root, finalName);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(file)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    renameSync(temporaryPath, finalPath);
    syncDirectory(this.root);

    const room: PersistedRoom = { docName, generation, update: update.slice(), flushedState: { ...flushedState } };
    this.rooms.set(docName, room);
    const names = [finalName, ...(this.files.get(docName) ?? [])];
    this.files.set(docName, names.slice(0, 2));
    await Promise.all(names.slice(2).map((name) => rm(join(this.root, name), { force: true }).catch(() => undefined)));
    return this.load(docName)!;
  }

  async replace(docName: string, update: Uint8Array, flushedState: SyncedFileState): Promise<void> {
    await this.save(docName, update, flushedState);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      const owner = JSON.parse(readFileSync(join(this.lockPath, "owner.json"), "utf8")) as { token?: string };
      if (owner.token === this.lockToken) rmSync(this.lockPath, { recursive: true, force: true });
    } catch { /* a missing/stolen lock is already released */ }
  }
}

/** Default durable state location for a standalone repository-backed server. */
export function defaultCrdtPersistenceDir(repoRoot: string): string {
  const canonicalRoot = realpathSync(resolve(repoRoot));
  const rawCommon = execFileSync("git", ["-C", canonicalRoot, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
  const common = realpathSync(isAbsolute(rawCommon) ? rawCommon : resolve(canonicalRoot, rawCommon));
  const worktreeId = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 20);
  return join(common, "agent-sync", worktreeId, "crdt");
}
