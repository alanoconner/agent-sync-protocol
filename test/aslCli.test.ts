import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    expect(command(repo, state, ["finish"])).toContain("original branch was not changed");
    expect(execFileSync("git", ["-C", repo, "show", `${status.integrationBranch}:README.md`], { encoding: "utf8" }))
      .toBe("fixture\nsynchronized\n");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("fixture\n");
    expect(command(repo, state, ["clean"])).toContain("Integration branch retained");
    expect(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
    expect(execFileSync("git", ["-C", repo, "branch", "--list", status.integrationBranch], { encoding: "utf8" })).toContain(status.integrationBranch);
  }, 60_000);
});
