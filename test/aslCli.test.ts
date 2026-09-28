import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");
const CLI = join(process.cwd(), "src", "cli", "index.ts");
const roots: string[] = [];

function command(cwd: string, stateRoot: string, args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  return execFileSync(TSX, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, ASL_STATE_DIR: stateRoot, ...extraEnv },
    timeout: 30_000,
  });
}

function fixture(): { repo: string; state: string } {
  const repo = mkdtempSync(join(tmpdir(), "asl-cli-repo-"));
  const state = mkdtempSync(join(tmpdir(), "asl-cli-state-"));
  roots.push(repo, state);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "ASL Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "asl@example.test"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
  return { repo, state };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      const repos = join(root, "repos");
      if (existsSync(repos)) {
        for (const name of readdirSync(repos)) {
          const daemon = join(repos, name, "daemon.json");
          if (existsSync(daemon)) {
            const pid = (JSON.parse(readFileSync(daemon, "utf8")) as { pid: number }).pid;
            try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
          }
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

describe("ASL CLI managed lifecycle", () => {
  it("treats reset without a session as an idempotent no-op", () => {
    const { repo, state } = fixture();
    expect(command(repo, state, ["reset"])).toContain("already clean");
  });

  it("stops a running agent and resets its live session from the public CLI", async () => {
    const { repo, state } = fixture();
    const fakeAgent = join(repo, "fake-agent.sh");
    writeFileSync(fakeAgent, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n");
    chmodSync(fakeAgent, 0o755);
    execFileSync("git", ["-C", repo, "add", "fake-agent.sh"]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "fake agent"]);
    const launcher = spawn(TSX, [CLI, "codex", "--yes", "--skip-setup", "--bin", fakeAgent], {
      cwd: repo,
      env: { ...process.env, ASL_STATE_DIR: state },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launcherExit = new Promise<void>((resolvePromise, reject) => {
      launcher.once("exit", () => resolvePromise());
      launcher.once("error", reject);
    });
    await new Promise<void>((resolvePromise, reject) => {
      let stdout = "";
      launcher.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes("codex workspace")) resolvePromise();
      });
      launcher.once("error", reject);
      launcher.once("exit", (code) => reject(new Error(`agent launcher exited before reset with code ${code}`)));
    });
    const status = JSON.parse(command(repo, state, ["status", "--json"])) as {
      integrationBranch: string;
      integrationWorktree: string;
      agents: { branch: string; worktree: string; running: boolean }[];
    };
    expect(status.agents[0].running).toBe(true);

    const output = command(repo, state, ["reset"]);
    await launcherExit;

    expect(output).toContain("1 agent process");
    expect(output).toContain("removed all managed worktrees, branches, and state");
    expect(existsSync(status.integrationWorktree)).toBe(false);
    expect(existsSync(status.agents[0].worktree)).toBe(false);
    expect(execFileSync("git", ["-C", repo, "branch", "--list", status.integrationBranch], { encoding: "utf8" })).toBe("");
    expect(execFileSync("git", ["-C", repo, "branch", "--list", status.agents[0].branch], { encoding: "utf8" })).toBe("");
    expect(command(repo, state, ["status"])).toContain("No ASL session");
  }, 60_000);

  it("launches Codex, syncs an edit through Yjs, finishes, and cleans safely", () => {
    const { repo, state } = fixture();
    const launch = command(repo, state, ["codex", "--yes", "--skip-setup", "--bin", "/usr/bin/true"]);
    expect(launch).toContain("codex workspace");
    expect(launch).toContain("integration branch");

    const status = JSON.parse(command(repo, state, ["status", "--json"])) as {
      status: string;
      daemon: { running: boolean; serverUrl: string };
      agents: { status: string; worktree: string }[];
      integrationBranch: string;
      baseCommit: string;
    };
    expect(status.status).toBe("active");
    expect(status.daemon.running).toBe(true);
    expect(status.agents).toEqual([expect.objectContaining({ status: "exited" })]);

    const agentWorktree = status.agents[0].worktree;
    const readme = join(agentWorktree, "README.md");
    const hookInput = JSON.stringify({
      session_id: "cli-test",
      tool_use_id: "write-1",
      cwd: agentWorktree,
      tool_name: "Write",
      tool_input: { file_path: readme },
    });
    const hookEnv = { AGENT_SYNC_SERVER: status.daemon.serverUrl };
    command(agentWorktree, state, ["_hook", "claude", "pre"], hookInput, hookEnv);
    writeFileSync(readme, "fixture\nsynchronized\n");
    command(agentWorktree, state, ["_hook", "claude", "post"], hookInput, hookEnv);

    const second = join(agentWorktree, "SECOND.md");
    const secondHookInput = JSON.stringify({
      session_id: "cli-test",
      tool_use_id: "write-2",
      cwd: agentWorktree,
      tool_name: "Write",
      tool_input: { file_path: second },
    });
    command(agentWorktree, state, ["_hook", "claude", "pre"], secondHookInput, hookEnv);
    writeFileSync(second, "second synchronized file\n");
    command(agentWorktree, state, ["_hook", "claude", "post"], secondHookInput, hookEnv);

    const baseHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const finishOutput = command(repo, state, ["finish"]);
    expect(finishOutput).toContain("compacted 2 integration flush commits into one commit");
    expect(finishOutput).toContain("no commit was created");
    expect(execFileSync("git", ["-C", repo, "show", `${status.integrationBranch}:README.md`], { encoding: "utf8" }))
      .toBe("fixture\nsynchronized\n");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("fixture\nsynchronized\n");
    expect(readFileSync(join(repo, "SECOND.md"), "utf8")).toBe("second synchronized file\n");
    expect(execFileSync("git", ["-C", repo, "rev-list", "--count", `${status.baseCommit}..${status.integrationBranch}`], { encoding: "utf8" }).trim()).toBe("1");
    expect(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(baseHead);
    expect(execFileSync("git", ["-C", repo, "rev-parse", "MERGE_HEAD"], { encoding: "utf8" }).trim())
      .toBe(execFileSync("git", ["-C", repo, "rev-parse", status.integrationBranch], { encoding: "utf8" }).trim());
    expect(execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], { encoding: "utf8" })).toBe("README.md\nSECOND.md\n");
    expect(command(repo, state, ["clean"])).toContain("Integration branch retained");
    expect(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })).toBe("M  README.md\nA  SECOND.md\n");
    expect(execFileSync("git", ["-C", repo, "branch", "--list", status.integrationBranch], { encoding: "utf8" })).toContain(status.integrationBranch);
  }, 60_000);
});
