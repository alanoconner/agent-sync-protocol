import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncServer } from "../src/server/syncServer.js";
import { SyncFileOps } from "../src/sync/syncFileOps.js";

describe("synchronized deletion and tombstones", () => {
  let server: SyncServer;
  let a: SyncFileOps;
  let b: SyncFileOps;

  beforeEach(() => {
    server = new SyncServer(0);
    const serverUrl = `ws://localhost:${server.port}`;
    a = new SyncFileOps({ serverUrl });
    b = new SyncFileOps({ serverUrl });
  });

  afterEach(async () => {
    await Promise.all([a.close(), b.close()]);
    await server.close();
  });

  it("distinguishes an empty file from a tombstone and allows observed recreation", async () => {
    await a.writeFileFull("empty.txt", "");
    expect(await a.readFileState("empty.txt")).toEqual({ exists: true, content: "" });

    await a.deleteFileFromSnapshot("empty.txt", "");
    await vi.waitFor(async () => expect(await b.readFileState("empty.txt")).toEqual({ exists: false, content: "" }));
    await expect(b.readFile("empty.txt")).rejects.toMatchObject({ code: "ENOENT" });

    await b.writeFileFromSnapshot("empty.txt", null, "recreated\n");
    await vi.waitFor(async () => expect(await a.readFile("empty.txt")).toBe("recreated\n"));
  });

  it("rejects a deletion when the live content changed after the snapshot", async () => {
    await a.writeFileFull("stale.txt", "version one");
    const stale = await b.readFile("stale.txt");
    await a.writeFileFull("stale.txt", "version two");
    await vi.waitFor(async () => expect(await b.readFile("stale.txt")).toBe("version two"));

    await expect(b.deleteFileFromSnapshot("stale.txt", stale)).rejects.toMatchObject({ code: "EAGAIN" });
    expect(await b.readFile("stale.txt")).toBe("version two");
  });

  it("rejects a stale snapshot write after deletion instead of resurrecting the file", async () => {
    await a.writeFileFull("gone.txt", "original");
    const stale = await b.readFile("gone.txt");
    await a.deleteFileFromSnapshot("gone.txt", "original");
    await vi.waitFor(async () => expect((await b.readFileState("gone.txt")).exists).toBe(false));

    await expect(b.writeFileFromSnapshot("gone.txt", stale, "stale edit")).rejects.toMatchObject({ code: "EAGAIN" });
    expect(await b.readFileState("gone.txt")).toEqual({ exists: false, content: "" });
  });
});
