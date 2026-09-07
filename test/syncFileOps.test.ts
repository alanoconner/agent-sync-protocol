import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
