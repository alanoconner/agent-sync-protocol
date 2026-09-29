import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simpleGit, type SimpleGit } from "simple-git";
import { SyncServer } from "../src/server/syncServer.js";
import { SyncClient } from "../src/client/SyncClient.js";
import { SyncFileOps } from "../src/sync/syncFileOps.js";
import { DiskFlushService } from "../src/flush/diskFlushService.js";
import { createDiskHydrator } from "../src/flush/diskHydration.js";

async function makeRepo(): Promise<{ dir: string; git: SimpleGit }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-sync-hydrate-"));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.name", "agent-sync-test");
  await git.addConfig("user.email", "agent-sync-test@example.com");
  return { dir, git };
}

describe("createDiskHydrator (disk→CRDT seeding, in isolation)", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "agent-sync-hydrator-"));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("returns the working-tree content of <repoRoot>/<docName>, LF-normalized", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "a.ts"), "one\r\ntwo\r\n", "utf8");
    expect(createDiskHydrator(repoDir)("src/a.ts")).toBe("one\ntwo\n");
  });

  it("returns undefined for a file that doesn't exist, so the room starts empty as before", () => {
    expect(createDiskHydrator(repoDir)("missing.ts")).toBeUndefined();
  });

  it("returns undefined for a directory rather than throwing", async () => {
    await mkdir(join(repoDir, "src"), { recursive: true });
    expect(createDiskHydrator(repoDir)("src")).toBeUndefined();
  });

  it("refuses to read outside the repo root (same discipline as DiskFlushService's resolveWithinRepo)", async () => {
    const outside = join(repoDir, "..", `agent-sync-outside-${Date.now()}.txt`);
    await writeFile(outside, "secret", "utf8");
    try {
      expect(createDiskHydrator(repoDir)(`../${basename(outside)}`)).toBeUndefined();
      expect(createDiskHydrator(repoDir)(outside)).toBeUndefined(); // absolute path resolves outside too
      expect(createDiskHydrator(repoDir)("")).toBeUndefined(); // the root itself
    } finally {
      await rm(outside, { force: true });
    }
  });
});

describe("SyncServer hydration + DiskFlushService interplay", () => {
  let server: SyncServer;
  let serverUrl: string;
  let repoDir: string;
  let git: SimpleGit;
  let flush: DiskFlushService | null;
  const clients: SyncClient[] = [];
  const opsList: SyncFileOps[] = [];

  beforeEach(async () => {
    const repo = await makeRepo();
    repoDir = repo.dir;
    git = repo.git;
    server = new SyncServer(0, { hydrate: createDiskHydrator(repoDir) });
    serverUrl = `ws://localhost:${server.port}`;
    flush = null;
  });

  afterEach(async () => {
    flush?.close();
    for (const ops of opsList.splice(0)) await ops.close();
    for (const client of clients.splice(0)) client.close();
    await server.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  function makeClient(docName: string): SyncClient {
    const client = new SyncClient({ serverUrl, docName });
    clients.push(client);
    return client;
  }

  it("the first client to open an already-existing file sees its disk content, not an empty doc", async () => {
    await writeFile(join(repoDir, "existing.ts"), "export const x = 1;\n", "utf8");

    const client = makeClient("existing.ts");
    await client.connect();
    await client.whenSynced();
    expect(client.getText().toString()).toBe("export const x = 1;\n");
    expect(server.getDocContent("existing.ts")).toBe("export const x = 1;\n");
  });

  it("hydrates exactly once — a later disk change without a room restart is not re-read", async () => {
    await writeFile(join(repoDir, "once.ts"), "v1", "utf8");
    const first = makeClient("once.ts");
    await first.connect();
    await first.whenSynced();
    expect(first.getText().toString()).toBe("v1");

    await writeFile(join(repoDir, "once.ts"), "v2 written behind the server's back", "utf8");
    const second = makeClient("once.ts");
    await second.connect();
    await second.whenSynced();
    expect(second.getText().toString()).toBe("v1"); // the room is the source of truth now, not disk
  });

  it("a doc with no file on disk still starts empty", async () => {
    const client = makeClient("brand-new.ts");
    await client.connect();
    await client.whenSynced();
    expect(client.getText().toString()).toBe("");
  });

  it("emits docHydrated (not docUpdate) for seeded content, before any client is greeted", async () => {
    await writeFile(join(repoDir, "events.ts"), "seeded", "utf8");
    const hydrated: { docName: string; content: string }[] = [];
    const updated: string[] = [];
    server.on("docHydrated", (e: { docName: string; content: string }) => hydrated.push(e));
    server.on("docUpdate", (e: { docName: string }) => updated.push(e.docName));

    const client = makeClient("events.ts");
    await client.connect();
    await client.whenSynced();

    expect(hydrated).toEqual([{ docName: "events.ts", content: "seeded" }]);
    expect(updated).toEqual([]);
  });

  it("DiskFlushService treats hydrated content as already flushed: no re-write, no no-op commit, until a real edit lands", async () => {
    await writeFile(join(repoDir, "tracked.ts"), "committed content\n", "utf8");
    await git.add("tracked.ts");
    await git.commit("initial");
    flush = new DiskFlushService({ server, repoRoot: repoDir, debounceMs: 30, git });

    const client = makeClient("tracked.ts");
    await client.connect();
    await client.whenSynced();

    await flush.flushAll();
    expect((await git.log()).total).toBe(1);
    expect(await readFile(join(repoDir, "tracked.ts"), "utf8")).toBe("committed content\n");

    client.getText().insert(0, "// agent was here\n");
    await vi.waitFor(async () => {
      expect(await readFile(join(repoDir, "tracked.ts"), "utf8")).toBe("// agent was here\ncommitted content\n");
      expect((await git.log()).total).toBe(2);
    });
  });

  it("replaces the hook bridge's seeding heuristic: a snapshot write against a freshly-hydrated room merges instead of rejecting", async () => {
    // What examples/claudeCodeHook.ts's Pre/Post pair does on the first-ever
    // touch of an existing file: read (the room is created and hydrated
    // here), let the tool edit locally, then push with the read as the
    // before-snapshot. Before hydration existed, the read would have
    // returned "" and the Pre hook had to detect that and seed the room
    // itself.
    await writeFile(join(repoDir, "hooked.ts"), "line 1\nline 2\nline 3\n", "utf8");
    const ops = new SyncFileOps({ serverUrl });
    opsList.push(ops);

    const before = await ops.readFile("hooked.ts");
    expect(before).toBe("line 1\nline 2\nline 3\n");
    await ops.writeFileFromSnapshot("hooked.ts", before, "line 1\nline 2 edited\nline 3\n");

    await vi.waitFor(() => expect(server.getDocContent("hooked.ts")).toBe("line 1\nline 2 edited\nline 3\n"));
  });
});
