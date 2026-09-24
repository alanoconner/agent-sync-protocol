import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncServer } from "../src/server/syncServer.js";
import { SyncClient } from "../src/client/SyncClient.js";
import { SyncFileOps } from "../src/sync/syncFileOps.js";

describe("initial connection recovery", () => {
  let server: SyncServer | undefined;
  let ops: SyncFileOps | undefined;
  afterEach(async () => {
    await ops?.close();
    await server?.close();
    vi.restoreAllMocks();
  });

  it("closes failed clients and retries the same path after the server returns", async () => {
    const reservation = new SyncServer(0);
    const port = reservation.port;
    await reservation.close();
    ops = new SyncFileOps({ serverUrl: `ws://localhost:${port}` });
    const close = vi.spyOn(SyncClient.prototype, "close");
    await expect(ops.readFile("retry.txt")).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
    server = new SyncServer(port, { hydrate: () => "recovered" });
    await expect(ops.readFile("retry.txt")).resolves.toBe("recovered");
  });
});
