import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractCandidatePaths, findWorkspaceRoot } from "../examples/workspaceRoot.js";

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

  it("resolves Bash relative tokens against the shell cwd, naming docs relative to the project root", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    const components = join(root, "client", "src", "components");
    mkdirSync(components, { recursive: true });
    writeFileSync(join(components, "TableNode.jsx"), "x");
    const found = extractCandidatePaths(root, components, "sed -i 's/a/b/' TableNode.jsx && node ../layout.js");
    expect(found).toContain("client/src/components/TableNode.jsx");
    expect(found).toContain("client/src/layout.js");
    expect(found).not.toContain("TableNode.jsx");
  });

  it("finds a path glued to code punctuation and follows an in-command cd", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    const components = join(root, "client", "src", "components");
    mkdirSync(components, { recursive: true });
    writeFileSync(join(components, "TableNode.jsx"), "x");
    const py = "python3 -c \"p='client/src/components/TableNode.jsx'; open(p).read()\"";
    expect(extractCandidatePaths(root, root, py)).toEqual(["client/src/components/TableNode.jsx"]);
    expect(extractCandidatePaths(root, root, "cd client/src/components && sed -i x TableNode.jsx")).toEqual([
      "client/src/components/TableNode.jsx",
    ]);
  });
});
