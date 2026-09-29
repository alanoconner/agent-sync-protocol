import { SyncFileOps, type SyncFileOpsOptions } from "../sync/syncFileOps.js";

interface OpenFile {
  path: string;
  /** What this fd believed the file contained as of its last flush (or open) — the honest before/after baseline used by writeFileFromSnapshot. */
  snapshot: string | null;
  /** The fd's current in-memory view, mutated in place by read/write syscalls before being flushed. */
  buffer: Buffer;
}

let nextFd = 1;

/**
 * FUSE/WinFsp operation handlers (Section 3.3a), transport-agnostic: this is the
 * logic a real `fuse-native` (or WinFsp) binding calls into, but it's plain
 * async/sync methods so it can be exercised directly in tests without an actual
 * OS-level mount. Reads/writes/truncates operate on a per-fd in-memory buffer,
 * mirroring how a real filesystem driver buffers a file between open and
 * release; only `flush`/`release` actually talk to the sync layer, translating
 * the accumulated buffer change into an `editFile` call (same principle as the
 * MCP proxy's write path, just triggered by close() instead of a tool call).
 */
export class SyncFsOperations {
  private readonly ops: SyncFileOps;
  private readonly openFiles = new Map<number, OpenFile>();

  constructor(options: SyncFileOpsOptions) {
    this.ops = new SyncFileOps(options);
  }

  /** Opens an existing virtual file, snapshotting its current CRDT content into a fresh fd's buffer. */
  async open(path: string): Promise<number> {
    const content = await this.ops.readFile(path);
    return this.allocate(path, content);
  }

  /** Creates a new virtual file (or truncates an existing one to empty) and returns a fresh fd for it. */
  async create(path: string): Promise<number> {
    const state = await this.ops.readFileState(path);
    return this.allocate(path, state.exists ? state.content : null, "");
  }

  private allocate(path: string, snapshot: string | null, content = snapshot ?? ""): number {
    const fd = nextFd++;
    this.openFiles.set(fd, { path, snapshot, buffer: Buffer.from(content, "utf8") });
    return fd;
  }

  read(fd: number, buffer: Buffer, length: number, position: number): number {
    const file = this.requireOpen(fd);
    if (position >= file.buffer.length) return 0;
    const slice = file.buffer.subarray(position, position + length);
    slice.copy(buffer);
    return slice.length;
  }

  write(fd: number, buffer: Buffer, length: number, position: number): number {
    const file = this.requireOpen(fd);
    const incoming = buffer.subarray(0, length);
    const end = position + incoming.length;
    if (end > file.buffer.length) {
      const grown = Buffer.alloc(end);
      file.buffer.copy(grown);
      file.buffer = grown;
    }
    incoming.copy(file.buffer, position);
    return incoming.length;
  }

  truncate(fd: number, size: number): void {
    const file = this.requireOpen(fd);
    if (size === file.buffer.length) return;
    const resized = Buffer.alloc(size);
    file.buffer.copy(resized, 0, 0, Math.min(size, file.buffer.length));
    file.buffer = resized;
  }

  size(fd: number): number {
    return this.requireOpen(fd).buffer.length;
  }

  /** Apply path-based truncate immediately, then refresh existing descriptors. */
  async truncatePath(path: string, size: number): Promise<void> {
    const snapshot = await this.ops.readFile(path);
    const resized = Buffer.alloc(size);
    Buffer.from(snapshot, "utf8").copy(resized);
    const content = resized.toString("utf8");
    await this.ops.writeFileFromSnapshot(path, snapshot, content);
    for (const file of this.openFiles.values()) {
      if (file.path !== path) continue;
      const buffer = Buffer.alloc(size);
      file.buffer.copy(buffer);
      file.buffer = buffer;
      file.snapshot = content;
    }
  }

  /** Pushes this fd's buffered content to the sync layer as an edit against its own last-known snapshot, then re-baselines the snapshot so a later flush on the same fd diffs incrementally. */
  async flush(fd: number): Promise<void> {
    const file = this.requireOpen(fd);
    const newContent = file.buffer.toString("utf8");
    if (file.snapshot !== null && newContent === file.snapshot) return;
    await this.ops.writeFileFromSnapshot(file.path, file.snapshot, newContent);
    file.snapshot = newContent;
  }

  async release(fd: number): Promise<void> {
    await this.flush(fd);
    this.openFiles.delete(fd);
  }

  async unlink(path: string): Promise<void> {
    await this.ops.deleteFile(path);
  }

  async readFileSnapshot(path: string): Promise<string> {
    return this.ops.readFile(path);
  }

  private requireOpen(fd: number): OpenFile {
    const file = this.openFiles.get(fd);
    if (!file) throw new Error(`no such open file descriptor: ${fd}`);
    return file;
  }

  async close(): Promise<void> {
    this.openFiles.clear();
    await this.ops.close();
  }
}
