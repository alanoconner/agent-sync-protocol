import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CONFIG_FILE_NAME, loadAgentSyncConfigOrDefault, type AgentSyncConfig } from "../config/agentSyncConfig.js";
import { ValidationGateService } from "../validation/validationGateService.js";
import { detectSetupCommand } from "./setupCommand.js";
import {
  acquireStateLock,
  daemonPath,
  gitCommand,
  newSession,
  readDaemon,
  readSession,
  trustPath,
  writeJsonAtomic,
  writeSession,
  type AgentKind,
  type AgentRecord,
  type DaemonState,
  type RepositoryInfo,
  type SessionManifest,
} from "./sessionState.js";

export interface LaunchOptions {
  name?: string;
  skipSetup?: boolean;
  launcherPid?: number;
}

export interface FinishResult {
  session: SessionManifest;
  mergePrepared: boolean;
  integrationCommitCount: number;
}

export interface ResetResult {
  hadSession: boolean;
  sessionId?: string;
  agentsStopped: number;
  daemonStopped: boolean;
  mergeAborted: boolean;
}

function removeWorktree(repoRoot: string, worktree: string, branch: string): void {
  try { gitCommand(repoRoot, ["worktree", "remove", "--force", worktree]); } catch { /* best effort rollback */ }
  try { gitCommand(repoRoot, ["branch", "-D", branch]); } catch { /* branch may not exist */ }
}

function runSetup(worktree: string, config: AgentSyncConfig, skip = false): string | undefined {
  if (skip) return undefined;
  const command = config.worktrees.setupCommand ?? (config.worktrees.autoInstall ? detectSetupCommand(worktree) : undefined);
  if (!command) return undefined;
  console.log(`asl: preparing ${basename(worktree)} with: ${command}`);
  const result = spawnSync(command, { cwd: worktree, shell: true, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`setup command failed with exit code ${result.status ?? "unknown"}: ${command}`);
  const dirty = gitCommand(worktree, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty) throw new Error(`setup command changed tracked or unignored files:\n${dirty}`);
  return command;
}

export function ensureSession(repo: RepositoryInfo, stateDir: string, skipSetup = false): SessionManifest {
  const release = acquireStateLock(stateDir);
  try {
    const existing = readSession(stateDir);
    if (existing) {
      if (existing.commonDir !== repo.commonDir) throw new Error("ASL state belongs to a different Git repository");
      if (existing.status === "finished") throw new Error("the previous ASL session is finished; run `asl clean` before starting another");
      return existing;
    }
    const session = newSession(repo, stateDir);
    mkdirSync(dirname(session.integrationWorktree), { recursive: true, mode: 0o700 });
    gitCommand(repo.root, ["worktree", "add", "-b", session.integrationBranch, session.integrationWorktree, session.baseCommit], "inherit");
    try {
      const config = loadAgentSyncConfigOrDefault(join(session.integrationWorktree, CONFIG_FILE_NAME));
      runSetup(session.integrationWorktree, config, skipSetup);
      writeSession(stateDir, session);
      return session;
    } catch (error) {
      removeWorktree(repo.root, session.integrationWorktree, session.integrationBranch);
      throw error;
    }
  } finally { release(); }
}

function sanitizedName(value: string): string {
  const name = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name || name === "." || name === "..") throw new Error(`invalid agent name: ${value}`);
  return name;
}

export function createAgentWorktree(
  repo: RepositoryInfo,
  stateDir: string,
  kind: AgentKind,
  options: LaunchOptions = {},
): { session: SessionManifest; agent: AgentRecord } {
  const release = acquireStateLock(stateDir);
  try {
    const session = readSession(stateDir);
    if (!session) throw new Error("ASL session disappeared while allocating an agent worktree");
    const sequence = session.agents.length + 1;
    const id = sanitizedName(options.name ?? `${kind}-${String(sequence).padStart(3, "0")}`);
    if (session.agents.some((agent) => agent.id === id)) throw new Error(`agent name already exists in this session: ${id}`);
    const branch = `asl/${session.sessionId}/${id}`;
    const worktree = join(dirname(session.integrationWorktree), id);
    gitCommand(repo.root, ["worktree", "add", "-b", branch, worktree, session.baseCommit], "inherit");
    try {
      const config = loadAgentSyncConfigOrDefault(join(worktree, CONFIG_FILE_NAME));
      runSetup(worktree, config, options.skipSetup);
    } catch (error) {
      removeWorktree(repo.root, worktree, branch);
      throw error;
    }
    const agent: AgentRecord = {
      id,
      kind,
      branch,
      worktree,
      launcherPid: options.launcherPid,
      status: "starting",
      createdAt: new Date().toISOString(),
    };
    session.agents.push(agent);
    writeSession(stateDir, session);
    return { session, agent };
  } finally { release(); }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await delay(50);
  }
  return !processAlive(pid);
}

async function terminateManagedProcess(pid: number, label: string): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error(`refusing to stop ${label}: invalid recorded process id ${pid}`);
  }
  if (!processAlive(pid)) return false;
  try { process.kill(pid, "SIGTERM"); }
  catch (error) {
    if (!processAlive(pid)) return false;
    throw error;
  }
  if (await waitForProcessExit(pid, 3_000)) return true;
  process.kill(pid, "SIGKILL");
  if (!await waitForProcessExit(pid, 2_000)) throw new Error(`could not stop ${label} (pid ${pid})`);
  return true;
}

function selfCommand(): { command: string; prefix: string[] } {
  const entry = resolve(process.argv[1]);
  if (entry.endsWith(".ts")) return { command: resolve(dirname(entry), "../../node_modules/.bin/tsx"), prefix: [entry] };
  return { command: process.execPath, prefix: [entry] };
}

async function healthyDaemon(stateDir: string, session: SessionManifest): Promise<DaemonState | undefined> {
  const daemon = readDaemon(stateDir);
  if (!daemon || !processAlive(daemon.pid)) return undefined;
  try {
    const response = await fetch(`${daemon.controlUrl}/status`, { headers: { Authorization: `Bearer ${session.controlToken}` }, signal: AbortSignal.timeout(1000) });
    if (response.ok) return daemon;
  } catch { /* stale runtime */ }
  return undefined;
}

export async function ensureDaemon(stateDir: string, session: SessionManifest): Promise<DaemonState> {
  const existing = await healthyDaemon(stateDir, session);
  if (existing) return existing;
  rmSync(daemonPath(stateDir), { force: true });
  const logPath = join(stateDir, "daemon.log");
  const log = openSync(logPath, "a", 0o600);
  const self = selfCommand();
  const child = spawn(self.command, [...self.prefix, "_daemon", "--state", stateDir], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  closeSync(log);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const daemon = await healthyDaemon(stateDir, session);
    if (daemon) return daemon;
    if (child.pid && !processAlive(child.pid)) break;
    await delay(100);
  }
  throw new Error(`ASL daemon failed to start; see ${logPath}`);
}

export async function controlRequest(
  stateDir: string,
  session: SessionManifest,
  action: "flush" | "shutdown",
): Promise<{ pending: string[] }> {
  const daemon = await healthyDaemon(stateDir, session);
  if (!daemon) throw new Error("ASL daemon is not running");
  const response = await fetch(`${daemon.controlUrl}/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.controlToken}` },
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json() as { pending?: string[]; error?: string };
  if (!response.ok) throw new Error(body.error ?? `cannot ${action}; pending documents: ${(body.pending ?? []).join(", ")}`);
  return { pending: body.pending ?? [] };
}

export function updateAgent(stateDir: string, id: string, update: Partial<AgentRecord>): void {
  const release = acquireStateLock(stateDir);
  try {
    const session = readSession(stateDir);
    if (!session) return;
    const agent = session.agents.find((candidate) => candidate.id === id);
    if (!agent) return;
    Object.assign(agent, update);
    writeSession(stateDir, session);
  } finally { release(); }
}

export async function stopSession(stateDir: string): Promise<SessionManifest> {
  const session = readSession(stateDir);
  if (!session) throw new Error("no ASL session for this repository");
  if (session.status === "finished") throw new Error("the ASL session is already finished");
  if (session.agents.some((agent) => agent.status === "running" && agent.pid && processAlive(agent.pid))) {
    throw new Error("cannot stop while an ASL-launched agent is still running");
  }
  if (await healthyDaemon(stateDir, session)) await controlRequest(stateDir, session, "shutdown");
  session.status = "paused";
  writeSession(stateDir, session);
  return session;
}

function gitOperationInProgress(repoRoot: string): string | undefined {
  const markers = [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["sequencer", "sequenced Git operation"],
  ] as const;
  for (const [marker, operation] of markers) {
    const path = gitCommand(repoRoot, ["rev-parse", "--git-path", marker]);
    if (existsSync(resolve(repoRoot, path))) return operation;
  }
  return undefined;
}

function assertMergeTarget(session: SessionManifest): void {
  let branch: string;
  try { branch = gitCommand(session.repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]); }
  catch { throw new Error(`original checkout must be on ${session.baseBranch}, but HEAD is detached`); }
  if (branch !== session.baseBranch) {
    throw new Error(`original checkout must be on ${session.baseBranch}, but is on ${branch}`);
  }
  const operation = gitOperationInProgress(session.repoRoot);
  if (operation) throw new Error(`original checkout has a ${operation} in progress; complete or abort it before finishing`);
  const dirty = gitCommand(session.repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty) throw new Error(`original checkout must be clean before finishing:\n${dirty}`);
  const head = gitCommand(session.repoRoot, ["rev-parse", "HEAD"]);
  if (head !== session.baseCommit) {
    throw new Error(`original checkout moved since the ASL session started; expected ${session.baseCommit}, found ${head}`);
  }
}

function gitSucceeds(repoRoot: string, args: string[]): boolean {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { stdio: "ignore" });
  if (result.error) throw result.error;
  return result.status === 0;
}

function assertIntegrationBranch(session: SessionManifest): void {
  let branch: string;
  try { branch = gitCommand(session.integrationWorktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]); }
  catch { throw new Error("integration worktree has a detached HEAD; cannot compact its flush history"); }
  if (branch !== session.integrationBranch) {
    throw new Error(`integration worktree must be on ${session.integrationBranch}, but is on ${branch}`);
  }
  const operation = gitOperationInProgress(session.integrationWorktree);
  if (operation) throw new Error(`integration worktree has a ${operation} in progress; complete or abort it before finishing`);
  const dirty = gitCommand(session.integrationWorktree, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty) throw new Error(`integration worktree must be clean before compacting flush commits:\n${dirty}`);
  if (!gitSucceeds(session.integrationWorktree, ["merge-base", "--is-ancestor", session.baseCommit, session.integrationBranch])) {
    throw new Error(`integration branch no longer descends from the session base commit: ${session.integrationBranch}`);
  }
}

export function compactIntegrationHistory(session: SessionManifest): number {
  assertIntegrationBranch(session);
  const count = Number(gitCommand(session.integrationWorktree, ["rev-list", "--count", `${session.baseCommit}..${session.integrationBranch}`]));
  if (count <= 1) return count;
  const integrationTree = gitCommand(session.integrationWorktree, ["rev-parse", `${session.integrationBranch}^{tree}`]);
  const commit = gitCommand(session.integrationWorktree, [
    "commit-tree",
    integrationTree,
    "-p",
    session.baseCommit,
    "-m",
    "agent-sync: synchronized changes",
  ]);
  gitCommand(session.integrationWorktree, ["reset", "--hard", commit], "inherit");
  return count;
}

export function prepareUncommittedMerge(session: SessionManifest): boolean {
  assertMergeTarget(session);
  try { gitCommand(session.repoRoot, ["rev-parse", "--verify", `${session.integrationBranch}^{commit}`]); }
  catch { throw new Error(`integration branch does not exist: ${session.integrationBranch}`); }
  if (!gitSucceeds(session.repoRoot, ["merge-base", "--is-ancestor", session.baseCommit, session.integrationBranch])) {
    throw new Error(`integration branch no longer descends from the session base commit: ${session.integrationBranch}`);
  }
  const integrationHead = gitCommand(session.repoRoot, ["rev-parse", session.integrationBranch]);
  if (integrationHead === session.baseCommit) return false;
  try {
    gitCommand(session.repoRoot, ["merge", "--no-ff", "--no-commit", "--no-edit", session.integrationBranch], "inherit");
  } catch {
    throw new Error("could not prepare the integration merge; inspect `git status` and use `git merge --abort` before retrying");
  }
  return true;
}

export async function finishSession(stateDir: string): Promise<FinishResult> {
  const session = readSession(stateDir);
  if (!session) throw new Error("no ASL session for this repository");
  if (session.status === "finished") throw new Error("the ASL session is already finished");
  if (session.agents.some((agent) => agent.status === "running" && agent.pid && processAlive(agent.pid))) {
    throw new Error("cannot finish while an ASL-launched agent is still running");
  }
  assertMergeTarget(session);
  const daemon = await ensureDaemon(stateDir, session);
  void daemon;
  await controlRequest(stateDir, session, "flush");
  const config = loadAgentSyncConfigOrDefault(join(session.integrationWorktree, CONFIG_FILE_NAME));
  if (config.validation) {
    const outcome = await new ValidationGateService({ ...config.validation, cwd: session.integrationWorktree }).run();
    if (!outcome.passed) throw new Error(`final validation failed (${config.validation.command}):\n${outcome.output}`);
  }
  const dirty = gitCommand(session.integrationWorktree, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty) throw new Error(`integration worktree is not clean after the final flush:\n${dirty}`);
  await controlRequest(stateDir, session, "shutdown");
  let mergePrepared: boolean;
  let integrationCommitCount: number;
  try {
    integrationCommitCount = compactIntegrationHistory(session);
    mergePrepared = prepareUncommittedMerge(session);
  } catch (error) {
    session.status = "paused";
    writeSession(stateDir, session);
    throw error;
  }
  session.status = "finished";
  writeSession(stateDir, session);
  return { session, mergePrepared, integrationCommitCount };
}

function changedPaths(worktree: string, integrationBranch?: string, agentBranch?: string): string[] {
  const raw = gitCommand(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const entries = raw ? raw.split("\0").filter(Boolean) : [];
  const paths = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    paths.add(entry.slice(3));
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  if (integrationBranch && agentBranch) {
    const branchDiff = gitCommand(worktree, ["diff", "--name-only", "-z", integrationBranch, agentBranch]);
    for (const path of branchDiff.split("\0").filter(Boolean)) paths.add(path);
  }
  return [...paths];
}

function samePath(leftRoot: string, rightRoot: string, rel: string): boolean {
  const left = join(leftRoot, rel);
  const right = join(rightRoot, rel);
  if (!existsSync(left) || !existsSync(right)) return !existsSync(left) && !existsSync(right);
  const a = statSync(left); const b = statSync(right);
  if (!a.isFile() || !b.isFile() || a.size !== b.size) return false;
  return readFileSync(left).equals(readFileSync(right));
}

export async function cleanSession(stateDir: string): Promise<{ integrationBranch: string }> {
  const session = readSession(stateDir);
  if (!session) throw new Error("no ASL session for this repository");
  if (session.status === "active" || await healthyDaemon(stateDir, session)) throw new Error("stop or finish the ASL session before cleaning it");
  for (const agent of session.agents) {
    if (!existsSync(agent.worktree)) continue;
    const unmatched = changedPaths(agent.worktree, session.integrationBranch, agent.branch)
      .filter((rel) => !samePath(agent.worktree, session.integrationWorktree, rel));
    if (unmatched.length > 0) throw new Error(`refusing to remove ${agent.id}; changes are not present in integration:\n${unmatched.join("\n")}`);
  }
  for (const agent of session.agents) removeWorktree(session.repoRoot, agent.worktree, agent.branch);
  if (existsSync(session.integrationWorktree)) gitCommand(session.repoRoot, ["worktree", "remove", session.integrationWorktree]);
  const integrationBranch = session.integrationBranch;
  let trust: unknown;
  try { trust = JSON.parse(readFileSync(trustPath(stateDir), "utf8")); } catch { /* no valid trust record to retain */ }
  rmSync(stateDir, { recursive: true, force: true });
  if (trust !== undefined) writeJsonAtomic(trustPath(stateDir), trust);
  return { integrationBranch };
}

function abortPreparedAslMerge(session: SessionManifest): boolean {
  const mergeHeadPath = resolve(session.repoRoot, gitCommand(session.repoRoot, ["rev-parse", "--git-path", "MERGE_HEAD"]));
  if (!existsSync(mergeHeadPath)) return false;
  const mergeHead = gitCommand(session.repoRoot, ["rev-parse", "MERGE_HEAD"]);
  let integrationHead: string;
  try { integrationHead = gitCommand(session.repoRoot, ["rev-parse", `${session.integrationBranch}^{commit}`]); }
  catch { throw new Error("original checkout has a merge in progress, but the ASL integration branch is missing; abort it manually before resetting"); }
  if (mergeHead !== integrationHead) {
    throw new Error("original checkout has a non-ASL merge in progress; complete or abort it before resetting");
  }
  gitCommand(session.repoRoot, ["merge", "--abort"], "inherit");
  return true;
}

function registeredWorktrees(repoRoot: string): Set<string> {
  const paths = new Set<string>();
  for (const line of gitCommand(repoRoot, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) paths.add(resolve(line.slice("worktree ".length)));
  }
  return paths;
}

function removeManagedWorktree(repoRoot: string, worktree: string, branch: string): void {
  if (existsSync(worktree) || registeredWorktrees(repoRoot).has(resolve(worktree))) {
    gitCommand(repoRoot, ["worktree", "remove", "--force", worktree], "inherit");
  }
  if (gitSucceeds(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
    gitCommand(repoRoot, ["branch", "-D", branch], "inherit");
  }
}

/**
 * Destructively removes every artifact owned by the repository's current ASL
 * session. Unlike cleanSession, this intentionally discards unmatched agent
 * and integration changes so the next launch can create a new session.
 */
export async function resetSession(stateDir: string): Promise<ResetResult> {
  const release = acquireStateLock(stateDir);
  let session: SessionManifest | undefined;
  try {
    session = readSession(stateDir);
    if (session) {
      // Block a concurrent launcher from adding another worktree while reset is
      // stopping processes and removing the recorded session artifacts.
      session.status = "finished";
      writeSession(stateDir, session);
    }
  } finally { release(); }

  if (!session) {
    rmSync(stateDir, { recursive: true, force: true });
    return { hadSession: false, agentsStopped: 0, daemonStopped: false, mergeAborted: false };
  }

  let agentsStopped = 0;
  for (const agent of session.agents) {
    let stopped = agent.pid ? await terminateManagedProcess(agent.pid, `agent ${agent.id}`) : false;
    if (!stopped && agent.launcherPid) {
      stopped = await terminateManagedProcess(agent.launcherPid, `agent launcher ${agent.id}`);
    }
    if (stopped) agentsStopped += 1;
  }

  const daemon = readDaemon(stateDir);
  const daemonStopped = daemon ? await terminateManagedProcess(daemon.pid, "ASL daemon") : false;
  const mergeAborted = abortPreparedAslMerge(session);

  for (const agent of session.agents) {
    removeManagedWorktree(session.repoRoot, agent.worktree, agent.branch);
  }
  removeManagedWorktree(session.repoRoot, session.integrationWorktree, session.integrationBranch);
  gitCommand(session.repoRoot, ["worktree", "prune"]);
  rmSync(stateDir, { recursive: true, force: true });
  return { hadSession: true, sessionId: session.sessionId, agentsStopped, daemonStopped, mergeAborted };
}
