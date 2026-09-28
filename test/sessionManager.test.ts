import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanSession, createAgentWorktree, ensureSession } from "../src/cli/sessionManager.js";
import { discoverRepository, repositoryStateDir, writeSession } from "../src/cli/sessionState.js";

const roots: string[] = [];
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function repoFixture(): { repo: string; stateRoot: string } {
  const repo = mkdtempSync(join(tmpdir(), "asl-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "asl-state-"));
  roots.push(repo, stateRoot);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "ASL Test"]);
  git(repo, ["config", "user.email", "asl@example.test"]);
  writeFileSync(join(repo, "app.txt"), "base\n");
  git(repo, ["add", "app.txt"]);
  git(repo, ["commit", "-qm", "base"]);
  return { repo, stateRoot };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("ASL managed Git sessions", () => {
  it("creates one integration worktree and unique agent worktrees without changing the source branch", async () => {
    const fixture = repoFixture();
    const repo = discoverRepository(fixture.repo);
    const stateDir = repositoryStateDir(repo, { ASL_STATE_DIR: fixture.stateRoot });
    const session = ensureSession(repo, stateDir, true);
    const first = createAgentWorktree(repo, stateDir, "codex", { skipSetup: true });
    const second = createAgentWorktree(repo, stateDir, "claude", { skipSetup: true });

    expect(readFileSync(join(session.integrationWorktree, "app.txt"), "utf8")).toBe("base\n");
    expect(first.agent.worktree).not.toBe(second.agent.worktree);
    expect(git(fixture.repo, ["branch", "--show-current"])).toBe("main");
    expect(git(fixture.repo, ["status", "--porcelain"])).toBe("");

    const paused = { ...second.session, status: "paused" as const };
    writeSession(stateDir, paused);
    const result = await cleanSession(stateDir);
    expect(result.integrationBranch).toBe(session.integrationBranch);
    expect(git(fixture.repo, ["branch", "--list", session.integrationBranch])).toContain(session.integrationBranch);
  });

  it("refuses to start from a dirty source checkout", () => {
    const fixture = repoFixture();
    writeFileSync(join(fixture.repo, "app.txt"), "dirty\n");
    expect(() => discoverRepository(fixture.repo)).toThrow(/must be clean/);
  });
});
