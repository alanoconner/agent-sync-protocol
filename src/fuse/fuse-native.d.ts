declare module "fuse-native" {
  interface FuseStat {
    mtime: Date;
    atime: Date;
    ctime: Date;
    size: number;
    mode: number;
    uid: number;
    gid: number;
  }

  interface FuseOperations {
    getattr?(path: string, cb: (code: number, stat?: FuseStat) => void): void;
    readdir?(path: string, cb: (code: number, names?: string[]) => void): void;
    open?(path: string, flags: number, cb: (code: number, fd?: number) => void): void;
    create?(path: string, mode: number, cb: (code: number, fd?: number) => void): void;
    read?(path: string, fd: number, buffer: Buffer, length: number, position: number, cb: (bytesReadOrError: number) => void): void;
    write?(path: string, fd: number, buffer: Buffer, length: number, position: number, cb: (bytesWrittenOrError: number) => void): void;
    truncate?(path: string, size: number, cb: (code: number) => void): void;
    flush?(path: string, fd: number, cb: (code: number) => void): void;
    release?(path: string, fd: number, cb: (code: number) => void): void;
    unlink?(path: string, cb: (code: number) => void): void;
  }

  interface FuseMountOptions {
    force?: boolean;
    mkdir?: boolean;
    debug?: boolean;
  }

  export default class Fuse {
    static ENOENT: number;
    static EIO: number;
    static EAGAIN: number;
    static EBUSY: number;
    constructor(mountPath: string, operations: FuseOperations, options?: FuseMountOptions);
    mount(cb: (err: Error | null) => void): void;
    unmount(cb: (err: Error | null) => void): void;
  }
}
