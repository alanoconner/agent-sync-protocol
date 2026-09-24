import { LockDeniedError, RangeMismatchError } from "../sync/syncFileOps.js";
import { resolveSyncFileOpsOptions, type AgentSyncConfig } from "../config/agentSyncConfig.js";
import { SyncFsOperations } from "./syncFsOperations.js";

export interface MountOptions {
  mountPath: string;
  /** A parsed `.agent-sync.yml` (Phase 7, Section 7) — supplies `server` and `paths.exclusive`. Explicit fields below override it; see `resolveSyncFileOpsOptions`. */
  config?: AgentSyncConfig;
  /** Sync server URL. Required unless `config` is given. */
  serverUrl?: string;
  /** Phase 6: paths that go through the lock service instead of relying on CRDT merge alone — see `SyncFileOpsOptions.exclusivePaths`. Replaces `config.paths.exclusive` when set. */
  exclusivePaths?: string[];
  /** Identifies this mount as a lock owner; see `SyncFileOpsOptions.ownerId`. */
  ownerId?: string;
  /** Lock lease length per write; see `SyncFileOpsOptions.lockLeaseMs`. */
  lockLeaseMs?: number;
}

/** Section 3.6's error-code table: a rejected merge is EAGAIN, a lock denial is EBUSY (Phase 6), anything else falls back to the generic EIO. */
function toErrno(err: unknown, Fuse: { EAGAIN: number; EBUSY: number; EIO: number }): number {
  if (err instanceof RangeMismatchError) return Fuse.EAGAIN;
  if (err instanceof LockDeniedError) return Fuse.EBUSY;
  return Fuse.EIO;
}

/**
 * Real OS-level mount entry point (Section 3.3a). This is the only piece of
 * Phase 3 that genuinely needs a FUSE runtime installed on the host — macFUSE
 * on macOS, libfuse on Linux, WinFsp on Windows. None of that is installed by
 * this codebase: enabling macFUSE's kernel extension is a System
 * Settings/security change the machine's owner has to do themselves, not
 * something this project does on its own. Everything upstream of the actual
 * `mount()` call — translating syscalls into sync-server reads/writes,
 * diff-merging concurrent edits — is real and is exercised directly against
 * `SyncFsOperations` by test/fuseSync.test.ts without needing a real mount.
 */
export async function mountSyncFs(options: MountOptions): Promise<() => Promise<void>> {
  const { default: Fuse } = await import("fuse-native");
  const ops = new SyncFsOperations(
    resolveSyncFileOpsOptions(options.config, {
      syncServerUrl: options.serverUrl,
      exclusivePaths: options.exclusivePaths,
      ownerId: options.ownerId,
      lockLeaseMs: options.lockLeaseMs,
    }),
  );
  const stripLeadingSlash = (path: string) => path.replace(/^\//, "");

  const fuse = new Fuse(
    options.mountPath,
    {
      getattr(path, cb) {
        if (path === "/") {
          cb(0, { mtime: new Date(), atime: new Date(), ctime: new Date(), size: 0, mode: 0o40755, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 });
          return;
        }
        ops.readFileSnapshot(stripLeadingSlash(path)).then(
          (content) =>
            cb(0, {
              mtime: new Date(),
              atime: new Date(),
              ctime: new Date(),
              size: Buffer.byteLength(content, "utf8"),
              mode: 0o100644,
              uid: process.getuid?.() ?? 0,
              gid: process.getgid?.() ?? 0,
            }),
          () => cb(Fuse.ENOENT),
        );
      },
      open(path, _flags, cb) {
        ops.open(stripLeadingSlash(path)).then(
          (fd) => cb(0, fd),
          () => cb(Fuse.ENOENT),
        );
      },
      create(path, _mode, cb) {
        ops.create(stripLeadingSlash(path)).then(
          (fd) => cb(0, fd),
          () => cb(Fuse.EIO),
        );
      },
      read(_path, fd, buffer, length, position, cb) {
        try {
          cb(ops.read(fd, buffer, length, position));
        } catch {
          cb(0);
        }
      },
      write(_path, fd, buffer, length, position, cb) {
        try {
          cb(ops.write(fd, buffer, length, position));
        } catch {
          cb(0);
        }
      },
      truncate(path, size, cb) {
        void path;
        void size;
        cb(0);
      },
      // Section 3.6: a rejected merge comes back as a real POSIX error code
      // (EAGAIN) rather than a generic I/O failure, so agents with the usual
      // retry-on-EAGAIN behavior already know what to do with no custom
      // instructions needed. A lock-lease denial (Phase 6) similarly maps to
      // the POSIX code that already means "in use, try again" — EBUSY. A
      // validation-gate rejection (Phase 5's ValidationRejectedError, spec's
      // custom EVALIDATE) has no POSIX equivalent to reuse, so it falls into
      // the generic EIO branch below — per Section 3.6, only the message text
      // needs to carry the actionable instruction in that case, not the code.
      flush(_path, fd, cb) {
        ops.flush(fd).then(
          () => cb(0),
          (err) => cb(toErrno(err, Fuse)),
        );
      },
      release(_path, fd, cb) {
        ops.release(fd).then(
          () => cb(0),
          (err) => cb(toErrno(err, Fuse)),
        );
      },
      unlink(path, cb) {
        ops.unlink(stripLeadingSlash(path)).then(
          () => cb(0),
          () => cb(Fuse.EIO),
        );
      },
    },
    { force: true, mkdir: true },
  );

  await new Promise<void>((resolve, reject) => fuse.mount((err) => (err ? reject(err) : resolve())));

  return () =>
    new Promise<void>((resolve, reject) => {
      fuse.unmount((err) => {
        ops.close();
        if (err) reject(err);
        else resolve();
      });
    });
}
