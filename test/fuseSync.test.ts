import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncServer } from "../src/server/syncServer.js";
import { SyncClient } from "../src/client/SyncClient.js";
import { SyncFsOperations } from "../src/fuse/syncFsOperations.js";

describe("Phase 3: FUSE/WinFsp operation handlers (Section 3.3a)", () => {
  let server: SyncServer;
  let serverUrl: string;
  let fsOps: SyncFsOperations;
  const rawClients: SyncClient[] = [];

  beforeEach(() => {
    server = new SyncServer(0);
    serverUrl = `ws://localhost:${server.port}`;
    fsOps = new SyncFsOperations({ serverUrl });
  });

  afterEach(async () => {
    await fsOps.close();
    for (const client of rawClients.splice(0)) client.close();
    await server.close();
  });

  function makeRawClient(docName: string): SyncClient {
    const client = new SyncClient({ serverUrl, docName });
    rawClients.push(client);
    return client;
  }

  it("open() snapshots current synced content and read() returns it", async () => {
    const seed = makeRawClient("note.txt");
    await seed.connect();
    await seed.whenSynced();
    seed.getText().insert(0, "hello world");
    await vi.waitFor(() => expect(seed.getText().toString()).toBe("hello world"));

    const fd = await fsOps.open("note.txt");
    const buf = Buffer.alloc(64);
    const n = fsOps.read(fd, buf, 64, 0);
    expect(buf.subarray(0, n).toString("utf8")).toBe("hello world");
  });

  it("write() + release() flushes the fd's buffer as a real edit visible to other clients", async () => {
    const fd = await fsOps.create("new-file.txt");
    const content = Buffer.from("created via FUSE");
    fsOps.write(fd, content, content.length, 0);
    await fsOps.release(fd);

    const observer = makeRawClient("new-file.txt");
    await observer.connect();
    await observer.whenSynced();
    expect(observer.getText().toString()).toBe("created via FUSE");
  });

  it("a truncate + overwrite round-trips correctly through open/write/release", async () => {
    const seed = makeRawClient("resize.txt");
    await seed.connect();
    await seed.whenSynced();
    seed.getText().insert(0, "0123456789");
    await vi.waitFor(() => expect(seed.getText().toString()).toBe("0123456789"));

    const fd = await fsOps.open("resize.txt");
    fsOps.truncate(fd, 5);
    expect(fsOps.size(fd)).toBe(5);
    const overwrite = Buffer.from("XX");
    fsOps.write(fd, overwrite, overwrite.length, 5);
    await fsOps.release(fd);

    const observer = makeRawClient("resize.txt");
    await observer.connect();
    await observer.whenSynced();
    expect(observer.getText().toString()).toBe("01234XX");
  });

  it("flushing a FUSE write preserves a concurrent edit made in an untouched region of the file", async () => {
    const seed = makeRawClient("shared-doc.txt");
    await seed.connect();
    await seed.whenSynced();
    seed.getText().insert(0, "line1\nline2\nline3\n");
    await vi.waitFor(() => expect(seed.getText().toString()).toBe("line1\nline2\nline3\n"));

    // FUSE opens and snapshots "line1\nline2\nline3\n" into its own fd buffer.
    const fd = await fsOps.open("shared-doc.txt");

    // Meanwhile, another agent prepends a header directly via the sync layer —
    // this happens after the FUSE fd's snapshot was taken, so the fd has no
    // knowledge of it.
    const other = makeRawClient("shared-doc.txt");
    await other.connect();
    await other.whenSynced();
    other.getText().insert(0, "HEADER\n");
    await vi.waitFor(() => expect(seed.getText().toString()).toBe("HEADER\nline1\nline2\nline3\n"));

    // The FUSE side appends a line at what it believes is the end of the file
    // (offset = its own snapshot's length) — it never touches bytes 0..N, so
    // the diff-vs-its-own-snapshot approach should replay only the append,
    // not clobber the concurrently-inserted header.
    const appended = Buffer.from("line4\n");
    fsOps.write(fd, appended, appended.length, "line1\nline2\nline3\n".length);
    await fsOps.release(fd);

    await vi.waitFor(() => {
      expect(seed.getText().toString()).toBe("HEADER\nline1\nline2\nline3\nline4\n");
    });
  });

  it("unlink clears the file's content", async () => {
    const seed = makeRawClient("to-delete.txt");
    await seed.connect();
    await seed.whenSynced();
    seed.getText().insert(0, "gone soon");
    await vi.waitFor(() => expect(seed.getText().toString()).toBe("gone soon"));

    await fsOps.unlink("to-delete.txt");

    await vi.waitFor(() => expect(seed.getText().toString()).toBe(""));
  });

  it("rejects a flush whose targeted span was changed by a concurrent edit, leaving live content untouched", async () => {
    const seed = makeRawClient("conflict.txt");
    await seed.connect();
    await seed.whenSynced();
    seed.getText().insert(0, "AAAA BBBB CCCC");
    await vi.waitFor(() => expect(seed.getText().toString()).toBe("AAAA BBBB CCCC"));

    const fd = await fsOps.open("conflict.txt");

    const other = makeRawClient("conflict.txt");
    await other.connect();
    await other.whenSynced();
    const start = other.getText().toString().indexOf("BBBB");
    other.getText().delete(start, 4);
    other.getText().insert(start, "ZZZZ");
    await vi.waitFor(() => expect(seed.getText().toString()).toBe("AAAA ZZZZ CCCC"));

    // The FUSE fd rewrites its own (now-stale) view of the same span.
    const rewritten = Buffer.from("AAAA QQQQ CCCC");
    fsOps.write(fd, rewritten, rewritten.length, 0);

    await expect(fsOps.release(fd)).rejects.toThrow(/EAGAIN|modified concurrently/);
    expect(seed.getText().toString()).toBe("AAAA ZZZZ CCCC");
  });
});
