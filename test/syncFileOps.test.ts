import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncServer } from "../src/server/syncServer.js";
import { SyncClient } from "../src/client/SyncClient.js";
import { SyncFileOps } from "../src/sync/syncFileOps.js";

describe("Phase 4: line-ending normalization at the SyncFileOps boundary", () => {
  let server: SyncServer;
  let serverUrl: string;
  let ops: SyncFileOps;
  const rawClients: SyncClient[] = [];

  beforeEach(() => {
    server = new SyncServer(0);
    serverUrl = `ws://localhost:${server.port}`;
    ops = new SyncFileOps({ serverUrl });
  });

  afterEach(async () => {
    await ops.close();
    for (const client of rawClients.splice(0)) client.close();
    await server.close();
  });

  it("normalizes CRLF content to LF on a full-buffer write, regardless of the writer's own EOL style", async () => {
    await ops.writeFileFull("crlf.txt", "line1\r\nline2\r\n");
    expect(await ops.readFile("crlf.txt")).toBe("line1\nline2\n");
  });

  it("normalizes CRLF in a range_replace's new_str", async () => {
    await ops.writeFileFull("range.txt", "AAAA BBBB CCCC");
    await ops.writeFileRange("range.txt", "BBBB", "X\r\nY");
    expect(await ops.readFile("range.txt")).toBe("AAAA X\nY CCCC");
  });

  it("normalizes CRLF on a snapshot-based (FUSE-style) write", async () => {
    await ops.writeFileFull("fuse.txt", "line1\nline2\n");
    await ops.writeFileFromSnapshot("fuse.txt", "line1\nline2\n", "line1\r\nline2\r\nline3\r\n");
    expect(await ops.readFile("fuse.txt")).toBe("line1\nline2\nline3\n");
  });

  it("accepts a snapshot edit in repetitive content when live state still equals the snapshot", async () => {
    const repeated = "12345678VALUE87654321";
    const before = `first block\n${repeated}\nsecond block\n${repeated}\n`;
    const target = before.lastIndexOf("VALUE");
    const after = `${before.slice(0, target)}CHANGED${before.slice(target + "VALUE".length)}`;
    await ops.writeFileFull("repetitive.txt", before);

    await ops.writeFileFromSnapshot("repetitive.txt", before, after);

    expect(await ops.readFile("repetitive.txt")).toBe(after);
  });

  it("uses an expanded unique anchor to preserve a concurrent non-overlapping edit", async () => {
    const repeated = "12345678VALUE87654321";
    const before = `first block\n${repeated}\nsecond block\n${repeated}\n`;
    const target = before.lastIndexOf("VALUE");
    const after = `${before.slice(0, target)}CHANGED${before.slice(target + "VALUE".length)}`;
    await ops.writeFileFull("concurrent-repetitive.txt", before);
    const other = new SyncClient({ serverUrl, docName: "concurrent-repetitive.txt" });
    rawClients.push(other);
    await other.connect();
    await other.whenSynced();
    other.getText().insert(0, "CONCURRENT HEADER\n");
    await vi.waitFor(async () => expect(await ops.readFile("concurrent-repetitive.txt")).toBe(`CONCURRENT HEADER\n${before}`));

    await ops.writeFileFromSnapshot("concurrent-repetitive.txt", before, after);

    expect(await ops.readFile("concurrent-repetitive.txt")).toBe(`CONCURRENT HEADER\n${after}`);
  });

  it("rejects a snapshot edit when concurrency duplicates its exact expanded anchor", async () => {
    const before = "unique prefix 12345678VALUE87654321 unique suffix\n";
    const after = before.replace("VALUE", "CHANGED");
    await ops.writeFileFull("duplicated-anchor.txt", before);
    const other = new SyncClient({ serverUrl, docName: "duplicated-anchor.txt" });
    rawClients.push(other);
    await other.connect();
    await other.whenSynced();
    other.getText().insert(other.getText().length, before);
    await vi.waitFor(async () => expect(await ops.readFile("duplicated-anchor.txt")).toBe(before + before));

    await expect(ops.writeFileFromSnapshot("duplicated-anchor.txt", before, after))
      .rejects.toThrow(/appears more than once/);
    expect(await ops.readFile("duplicated-anchor.txt")).toBe(before + before);
  });
});
