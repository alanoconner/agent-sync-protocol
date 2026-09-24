import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findWorkspaceRoot } from "../examples/workspaceRoot.js";

describe("hook workspace root", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  const tempRoot = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "asp-root-")));
    directories.push(dir);
    return dir;
  };

  it("walks up from a subdirectory cwd to the project root", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "client", "src"), { recursive: true });
    expect(findWorkspaceRoot(join(root, "client", "src"), {})).toBe(root);
  });

  it("treats a .git *file* (git worktree) as a root marker", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    expect(findWorkspaceRoot(join(root, "a", "b"), {})).toBe(root);
  });

  it("prefers CLAUDE_PROJECT_DIR over the cwd walk", () => {
    const root = tempRoot();
    expect(findWorkspaceRoot(root, { CLAUDE_PROJECT_DIR: "/some/project" })).toBe("/some/project");
  });

  it("falls back to cwd when no marker exists", () => {
    const root = tempRoot();
    expect(findWorkspaceRoot(root, {})).toBe(root);
  });
});
