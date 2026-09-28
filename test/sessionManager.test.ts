import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanSession,
  compactIntegrationHistory,
  createAgentWorktree,
  ensureSession,
  prepareUncommittedMerge,
  resetSession,
} from "../src/cli/sessionManager.js";
import { discoverRepository, readSession, repositoryStateDir, writeSession } from "../src/cli/sessionState.js";

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

  it("prepares a real merge in the source checkout without committing it", () => {
    const fixture = repoFixture();
    const repo = discoverRepository(fixture.repo);
    const stateDir = repositoryStateDir(repo, { ASL_STATE_DIR: fixture.stateRoot });
    const session = ensureSession(repo, stateDir, true);
    writeFileSync(join(session.integrationWorktree, "app.txt"), "integrated\n");
    git(session.integrationWorktree, ["add", "app.txt"]);
    git(session.integrationWorktree, ["commit", "-qm", "integrated"]);
    const integrationHead = git(fixture.repo, ["rev-parse", session.integrationBranch]);

    expect(prepareUncommittedMerge(session)).toBe(true);
    expect(git(fixture.repo, ["branch", "--show-current"])).toBe("main");
    expect(git(fixture.repo, ["rev-parse", "HEAD"])).toBe(session.baseCommit);
    expect(git(fixture.repo, ["rev-parse", "MERGE_HEAD"])).toBe(integrationHead);
    expect(git(fixture.repo, ["diff", "--cached", "--", "app.txt"])).toContain("+integrated");

    git(fixture.repo, ["merge", "--abort"]);
    expect(readFileSync(join(fixture.repo, "app.txt"), "utf8")).toBe("base\n");

    expect(prepareUncommittedMerge(session)).toBe(true);
    git(fixture.repo, ["commit", "-qm", "accept ASL merge"]);
    expect(git(fixture.repo, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ")).toHaveLength(3);
    expect(() => git(fixture.repo, ["rev-parse", "--verify", "MERGE_HEAD"])).toThrow();
    expect(readFileSync(join(fixture.repo, "app.txt"), "utf8")).toBe("integrated\n");
  });

  it("compacts per-flush integration history into one commit without changing its tree", () => {
    const fixture = repoFixture();
    const repo = discoverRepository(fixture.repo);
    const stateDir = repositoryStateDir(repo, { ASL_STATE_DIR: fixture.stateRoot });
    const session = ensureSession(repo, stateDir, true);
    for (const [path, content] of [["app.txt", "first\n"], ["second.txt", "second\n"], ["app.txt", "final\n"]]) {
      writeFileSync(join(session.integrationWorktree, path), content);
      git(session.integrationWorktree, ["add", path]);
      git(session.integrationWorktree, ["commit", "-qm", `agent-sync: flush ${path}`]);
    }
    const treeBefore = git(session.integrationWorktree, ["rev-parse", "HEAD^{tree}"]);

    expect(compactIntegrationHistory(session)).toBe(3);
    expect(git(session.integrationWorktree, ["rev-list", "--count", `${session.baseCommit}..HEAD`])).toBe("1");
    expect(git(session.integrationWorktree, ["rev-parse", "HEAD^{tree}"])).toBe(treeBefore);
    expect(git(session.integrationWorktree, ["rev-parse", "HEAD^1"])).toBe(session.baseCommit);
    expect(git(session.integrationWorktree, ["log", "-1", "--pretty=%s"])).toBe("agent-sync: synchronized changes");
    expect(readFileSync(join(session.integrationWorktree, "app.txt"), "utf8")).toBe("final\n");
    expect(readFileSync(join(session.integrationWorktree, "second.txt"), "utf8")).toBe("second\n");
  });

  it("does not create merge state when the integration branch has no commits", () => {
    const fixture = repoFixture();
    const repo = discoverRepository(fixture.repo);
    const stateDir = repositoryStateDir(repo, { ASL_STATE_DIR: fixture.stateRoot });
    const session = ensureSession(repo, stateDir, true);

    expect(prepareUncommittedMerge(session)).toBe(false);
    expect(() => git(fixture.repo, ["rev-parse", "--verify", "MERGE_HEAD"])).toThrow();
    expect(git(fixture.repo, ["status", "--porcelain"])).toBe("");
  });

  it("refuses unsafe source checkout states", () => {
    const dirtyFixture = repoFixture();
    const dirtyRepo = discoverRepository(dirtyFixture.repo);
    const dirtyState = repositoryStateDir(dirtyRepo, { ASL_STATE_DIR: dirtyFixture.stateRoot });
    const dirtySession = ensureSession(dirtyRepo, dirtyState, true);
    writeFileSync(join(dirtyFixture.repo, "app.txt"), "dirty\n");
    expect(() => prepareUncommittedMerge(dirtySession)).toThrow(/must be clean/);

    const branchFixture = repoFixture();
    const branchRepo = discoverRepository(branchFixture.repo);
    const branchState = repositoryStateDir(branchRepo, { ASL_STATE_DIR: branchFixture.stateRoot });
    const branchSession = ensureSession(branchRepo, branchState, true);
    git(branchFixture.repo, ["switch", "-c", "other"]);
    expect(() => prepareUncommittedMerge(branchSession)).toThrow(/must be on main/);

    const movedFixture = repoFixture();
    const movedRepo = discoverRepository(movedFixture.repo);
    const movedState = repositoryStateDir(movedRepo, { ASL_STATE_DIR: movedFixture.stateRoot });
    const movedSession = ensureSession(movedRepo, movedState, true);
    writeFileSync(join(movedFixture.repo, "later.txt"), "later\n");
    git(movedFixture.repo, ["add", "later.txt"]);
    git(movedFixture.repo, ["commit", "-qm", "later"]);
    expect(() => prepareUncommittedMerge(movedSession)).toThrow(/moved since/);
  });

  it("refuses when another Git operation is already in progress", () => {
    const fixture = repoFixture();
    const repo = discoverRepository(fixture.repo);
    const stateDir = repositoryStateDir(repo, { ASL_STATE_DIR: fixture.stateRoot });
    const session = ensureSession(repo, stateDir, true);
    writeFileSync(join(session.integrationWorktree, "app.txt"), "integrated\n");
    git(session.integrationWorktree, ["add", "app.txt"]);
    git(session.integrationWorktree, ["commit", "-qm", "integrated"]);
    git(fixture.repo, ["merge", "--no-ff", "--no-commit", session.integrationBranch]);

    expect(() => prepareUncommittedMerge(session)).toThrow(/merge in progress/);
    git(fixture.repo, ["merge", "--abort"]);
  });

  it("resets active sessions by discarding managed worktrees, branches, and state", async () => {
    const fixture = repoFixture();
    const repo = discoverRepository(fixture.repo);
    const stateDir = repositoryStateDir(repo, { ASL_STATE_DIR: fixture.stateRoot });
    const session = ensureSession(repo, stateDir, true);
    const { agent } = createAgentWorktree(repo, stateDir, "codex", { skipSetup: true });
    writeFileSync(join(agent.worktree, "unmatched.txt"), "discard me\n");
    writeFileSync(join(session.integrationWorktree, "app.txt"), "also discard me\n");
    git(session.integrationWorktree, ["add", "app.txt"]);
    git(session.integrationWorktree, ["commit", "-qm", "integration work"]);

    const result = await resetSession(stateDir);

    expect(result).toEqual(expect.objectContaining({ hadSession: true, sessionId: session.sessionId }));
    expect(existsSync(agent.worktree)).toBe(false);
    expect(existsSync(session.integrationWorktree)).toBe(false);
    expect(git(fixture.repo, ["branch", "--list", agent.branch])).toBe("");
    expect(git(fixture.repo, ["branch", "--list", session.integrationBranch])).toBe("");
    expect(readSession(stateDir)).toBeUndefined();
    expect(readFileSync(join(fixture.repo, "app.txt"), "utf8")).toBe("base\n");
  });

  it("terminates a recorded running agent before removing its worktree", async () => {
    const fixture = repoFixture();
    const repo = discoverRepository(fixture.repo);
    const stateDir = repositoryStateDir(repo, { ASL_STATE_DIR: fixture.stateRoot });
    ensureSession(repo, stateDir, true);
    const { agent, session } = createAgentWorktree(repo, stateDir, "codex", { skipSetup: true });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolvePromise, reject) => {
      child.once("spawn", resolvePromise);
      child.once("error", reject);
    });
    agent.pid = child.pid;
    agent.status = "running";
    session.agents[0] = agent;
    writeSession(stateDir, session);

    const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
    const result = await resetSession(stateDir);
    await exited;

    expect(result.agentsStopped).toBe(1);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });

  it("aborts only the pending merge prepared from its integration branch", async () => {
    const fixture = repoFixture();
    const repo = discoverRepository(fixture.repo);
    const stateDir = repositoryStateDir(repo, { ASL_STATE_DIR: fixture.stateRoot });
    const session = ensureSession(repo, stateDir, true);
    writeFileSync(join(session.integrationWorktree, "app.txt"), "integrated\n");
    git(session.integrationWorktree, ["add", "app.txt"]);
    git(session.integrationWorktree, ["commit", "-qm", "integrated"]);
    expect(prepareUncommittedMerge(session)).toBe(true);

    const result = await resetSession(stateDir);

    expect(result.mergeAborted).toBe(true);
    expect(() => git(fixture.repo, ["rev-parse", "--verify", "MERGE_HEAD"])).toThrow();
    expect(git(fixture.repo, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(fixture.repo, "app.txt"), "utf8")).toBe("base\n");
  });
});
