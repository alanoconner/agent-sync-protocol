import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncServer } from "../src/server/syncServer.js";
import { SyncClient } from "../src/client/SyncClient.js";

describe("Phase 2: multi-file support", () => {
  let server: SyncServer;
  let serverUrl: string;
  const clients: SyncClient[] = [];

  beforeEach(() => {
    server = new SyncServer(0);
    serverUrl = `ws://localhost:${server.port}`;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await server.close();
  });

  function makeClient(docName: string): SyncClient {
    const client = new SyncClient({ serverUrl, docName });
    clients.push(client);
    return client;
  }

  it("syncs many arbitrary, deeply-nested file paths independently over one server", async () => {
    const paths = [
      "package.json",
      "src/index.ts",
      "src/server/syncServer.ts",
      "src/very/deeply/nested/dir/structure/file.ts",
      "a/b/c/d/e/f/g.ts",
    ];

    const pairs = paths.map((path) => {
      const a = makeClient(path);
      const b = makeClient(path);
      return { path, a, b };
    });

    await Promise.all(pairs.flatMap(({ a, b }) => [a.connect(), b.connect()]));
    await Promise.all(pairs.flatMap(({ a, b }) => [a.whenSynced(), b.whenSynced()]));

    for (const { path, a } of pairs) {
      a.getText().insert(0, `content for ${path}`);
    }

    await vi.waitFor(() => {
      for (const { path, b } of pairs) {
        expect(b.getText().toString()).toBe(`content for ${path}`);
      }
    });

    // Cross-check: no path's content leaked into another path's doc.
    for (const { path, a } of pairs) {
      expect(a.getText().toString()).toBe(`content for ${path}`);
    }
  });

  it("treats paths that differ only by a trailing segment as fully distinct rooms", async () => {
    const a = makeClient("src/foo.ts");
    const b = makeClient("src/foo.ts.bak");
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.whenSynced(), b.whenSynced()]);

    a.getText().insert(0, "real file");
    b.getText().insert(0, "backup file");

    await vi.waitFor(() => {
      expect(a.getText().toString()).toBe("real file");
    });
    expect(b.getText().toString()).toBe("backup file");
  });
});
