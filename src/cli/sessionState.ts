import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type AgentKind = "codex" | "claude";
export type SessionStatus = "active" | "paused" | "finished";

export interface RepositoryInfo {
  root: string;
  commonDir: string;
  branch: string;
  head: string;
}

export interface AgentRecord {
  id: string;
  kind: AgentKind;
  branch: string;
  worktree: string;
  launcherPid?: number;
  pid?: number;
  status: "starting" | "running" | "exited";
  exitCode?: number;
  createdAt: string;
}

export interface SessionManifest {
  version: 1;
  sessionId: string;
  status: SessionStatus;
  repoRoot: string;
  commonDir: string;
  baseBranch: string;
  baseCommit: string;
  integrationBranch: string;
  integrationWorktree: string;
  controlToken: string;
  createdAt: string;
  agents: AgentRecord[];
}

export interface DaemonState {
  pid: number;
  serverUrl: string;
  controlUrl: string;
  startedAt: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function discoverRepository(cwd = process.cwd(), requireClean = true): RepositoryInfo {
  let root: string;
  try { root = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"])); }
  catch { throw new Error("asl must be run inside a non-bare Git working tree"); }
  let branch: string;
  try { branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]); }
  catch { throw new Error("asl does not start sessions from a detached HEAD; check out a branch first"); }
  if (requireClean) {
    const dirty = git(root, ["status", "--porcelain", "--untracked-files=all"]);
    if (dirty) throw new Error(`working tree must be clean before starting an ASL session:\n${dirty}`);
  }
  try { git(root, ["var", "GIT_AUTHOR_IDENT"]); }
  catch { throw new Error("Git user.name and user.email must be configured before ASL can create flush commits"); }
  const commonRaw = git(root, ["rev-parse", "--git-common-dir"]);
  const commonDir = realpathSync(isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw));
  return { root, commonDir, branch, head: git(root, ["rev-parse", "HEAD"]) };
}

export function aslStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.ASL_STATE_DIR ?? join(homedir(), ".asl"));
}

export function repositoryStateDir(repo: RepositoryInfo, env: NodeJS.ProcessEnv = process.env): string {
  const id = createHash("sha256").update(repo.commonDir).digest("hex").slice(0, 20);
  return join(aslStateRoot(env), "repos", id);
}

export function sessionPath(stateDir: string): string { return join(stateDir, "session.json"); }
export function daemonPath(stateDir: string): string { return join(stateDir, "daemon.json"); }
export function knownDocsPath(stateDir: string): string { return join(stateDir, "known-docs.json"); }
export function trustPath(stateDir: string): string { return join(stateDir, "trust.json"); }

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function readSession(stateDir: string): SessionManifest | undefined {
  const path = sessionPath(stateDir);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as SessionManifest : undefined;
}

export function writeSession(stateDir: string, session: SessionManifest): void { writeJsonAtomic(sessionPath(stateDir), session); }
export function readDaemon(stateDir: string): DaemonState | undefined {
  const path = daemonPath(stateDir);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as DaemonState : undefined;
}

export function newSession(repo: RepositoryInfo, stateDir: string): SessionManifest {
  const sessionId = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const base = `asl/${sessionId}`;
  const worktrees = join(stateDir, "worktrees", sessionId);
  return {
    version: 1,
    sessionId,
    status: "active",
    repoRoot: repo.root,
    commonDir: repo.commonDir,
    baseBranch: repo.branch,
    baseCommit: repo.head,
    integrationBranch: `${base}/integration`,
    integrationWorktree: join(worktrees, "integration"),
    controlToken: randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
    agents: [],
  };
}

interface StateLockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readLockOwner(lock: string): StateLockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as Partial<StateLockOwner>;
    if (typeof value.pid !== "number" || typeof value.token !== "string" || typeof value.acquiredAt !== "string") return undefined;
    return value as StateLockOwner;
  } catch { return undefined; }
}

function staleLock(lock: string): boolean {
  const owner = readLockOwner(lock);
  if (owner) return !processAlive(owner.pid);
  // Versions before owner metadata used an empty directory. A short grace
  // period avoids stealing one in the mkdir-to-owner-write window.
  try { return Date.now() - statSync(lock).mtimeMs >= 2_000; }
  catch { return true; }
}

export function acquireStateLock(stateDir: string): () => void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = join(stateDir, ".lock");
  const owner: StateLockOwner = {
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    acquiredAt: new Date().toISOString(),
  };
  for (;;) {
    try {
      mkdirSync(lock);
      try { writeJsonAtomic(join(lock, "owner.json"), owner); }
      catch (error) {
        rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!existsSync(lock) || !staleLock(lock)) {
        throw new Error("another ASL command is already changing this repository session", { cause: error });
      }
      const stale = `${lock}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
      try { renameSync(lock, stale); }
      catch {
        if (!existsSync(lock)) continue;
        throw new Error("another ASL command is already changing this repository session");
      }
      rmSync(stale, { recursive: true, force: true });
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (readLockOwner(lock)?.token === owner.token) rmSync(lock, { recursive: true, force: true });
  };
}

export function gitCommand(repoRoot: string, args: string[], stdio: "pipe" | "inherit" = "pipe"): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
  })?.trim() ?? "";
}
