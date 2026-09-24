import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncServer } from "../src/server/syncServer.js";
import { mountSyncFs } from "../src/fuse/mountSyncFs.js";

const native = vi.hoisted(() => ({ operations: null as any }));
vi.mock("fuse-native", () => ({
  default: class {
    static EIO = -5;
    static EAGAIN = -11;
    static EBUSY = -16;
    constructor(_path: string, operations: unknown) { native.operations = operations; }
    mount(cb: (error: null) => void) { cb(null); }
    unmount(cb: (error: null) => void) { cb(null); }
  },
}));

describe("native FUSE truncate adapter", () => {
  let server: SyncServer | undefined;
  let unmount: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await unmount?.();
    await server?.close();
  });

  it("persists truncation and keeps an open descriptor from restoring the old tail", async () => {
    server = new SyncServer(0, { hydrate: () => "0123456789" });
    unmount = await mountSyncFs({ mountPath: "/unused-test-mount", serverUrl: `ws://localhost:${server.port}` });
    const fd = await new Promise<number>((resolve) => native.operations.open("/file.txt", 2, (code: number, fd: number) => {
      expect(code).toBe(0);
      resolve(fd);
    }));
    const truncate = (size: number) => new Promise<number>((resolve) => native.operations.truncate("/file.txt", size, resolve));
    expect(await truncate(3)).toBe(0);
    await vi.waitFor(() => expect(server!.getDocContent("file.txt")).toBe("012"));
    const buffer = Buffer.alloc(16);
    const read = await new Promise<number>((resolve) => native.operations.read("/file.txt", fd, buffer, 16, 0, resolve));
    expect(buffer.subarray(0, read).toString()).toBe("012");
    expect(await new Promise<number>((resolve) => native.operations.release("/file.txt", fd, resolve))).toBe(0);
    expect(await truncate(0)).toBe(0);
    await vi.waitFor(() => expect(server!.getDocContent("file.txt")).toBe(""));
    expect(await truncate(-1)).toBe(-5);
  });
});
