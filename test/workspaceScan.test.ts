import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileIgnore, WorkspaceScanner } from "../src/hooks/workspaceScan.js";

describe("compileIgnore", () => {
  it("handles *, **, ?, and bare directory names", () => {
    const ignored = compileIgnore(["node_modules/**", "dist", "**/*.log", "src/gen?.ts"]);
    expect(ignored("node_modules/a/b.js")).toBe(true);
    expect(ignored("dist/x.js")).toBe(true);
    expect(ignored("dist")).toBe(true);
    expect(ignored("a/b/c.log")).toBe(true);
    expect(ignored("c.log")).toBe(true);
    expect(ignored("src/gen1.ts")).toBe(true);
    expect(ignored("src/gen12.ts")).toBe(false);
    expect(ignored("src/distinct.ts")).toBe(false);
  });
});

describe("WorkspaceScanner", () => {
  let root: string;
  let store: string;
  const write = (rel: string, content: string | Buffer) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  const scanner = (ignore: string[] = []) => new WorkspaceScanner(root, ignore, store);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "asp-scan-")));
    store = realpathSync(mkdtempSync(join(tmpdir(), "asp-scan-store-")));
    execFileSync("git", ["init", "-q", root]);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("lists tracked + untracked files but not gitignored, hook settings, node_modules, or the sync config", () => {
    write(".gitignore", "build/\n");
    write("src/a.js", "a");
    write("build/out.js", "x");
    write(".claude/settings.json", "{}");
    write(".codex/hooks.json", "{}");
    write(".agent-sync.yml", "server: x");
    write("client/node_modules/pkg/i.js", "x");
    expect(scanner().listFiles().sort()).toEqual([".gitignore", "src/a.js"]);
  });

  it("falls back to a directory walk outside a git checkout", () => {
    rmSync(join(root, ".git"), { recursive: true, force: true });
    write("src/a.js", "a");
    write("node_modules/x.js", "x");
    expect(scanner().listFiles()).toEqual(["src/a.js"]);
  });

  it("honors paths.ignore", () => {
    write("src/a.js", "a");
    write("dist/b.js", "b");
    expect(scanner(["dist/**"]).listFiles()).toEqual(["src/a.js"]);
  });

  it("reports edited and created files with their exact pre-command content, however they were changed", () => {
    write("src/a.js", "one\ntwo\n");
    write("src/keep.js", "keep\n");
    const s = scanner();
    const pre = s.snapshot();

    write("src/a.js", "one\nTWO\n"); // changed size-neutrally, like a sed/python rewrite
    write("src/new.js", "fresh\n");
    const { changes, warnings } = s.changes(pre);

    expect(warnings).toEqual([]);
    expect(changes.map((c) => c.docName).sort()).toEqual(["src/a.js", "src/new.js"]);
    expect(changes.find((c) => c.docName === "src/a.js")).toMatchObject({ before: "one\ntwo\n", after: "one\nTWO\n", isNew: false });
    expect(changes.find((c) => c.docName === "src/new.js")).toMatchObject({ before: "", after: "fresh\n", isNew: true });
  });

  it("reports text deletions while ignoring unchanged and binary modifications", () => {
    write("a.txt", "same");
    write("gone.txt", "bye");
    write("img.bin", Buffer.from([1, 2, 0, 3]));
    const s = scanner();
    const pre = s.snapshot();

    write("a.txt", "same"); // rewritten with identical bytes: new mtime, same hash
    unlinkSync(join(root, "gone.txt"));
    write("img.bin", Buffer.from([9, 9, 0, 9]));
    expect(s.changes(pre).changes).toEqual([{ kind: "delete", docName: "gone.txt", before: "bye" }]);
  });

  it("reuses the cached hash for unchanged files and still recovers 'before' after later scans", () => {
    write("a.txt", "v1");
    const s = scanner();
    const pre = s.snapshot();
    s.snapshot(); // a second Pre (another agent's call) must not invalidate this run's baseline
    write("a.txt", "v2");
    expect(s.changes(pre).changes[0]).toMatchObject({ before: "v1", after: "v2" });
  });

  it("takeRun returns the saved manifest once and errors when missing", () => {
    write("a.txt", "x");
    const s = scanner();
    s.saveRun("run1", s.snapshot());
    expect(Object.keys(s.takeRun("run1"))).toEqual(["a.txt"]);
    expect(() => s.takeRun("run1")).toThrow();
  });
});
