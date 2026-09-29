import { spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";

export interface CommandInvocation {
  command: string;
  args: string[];
}

export interface HookCommands {
  posix: string;
  windows: string;
  gitBash: string;
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Quotes one argv element using the Windows CommandLineToArgvW rules. */
function quoteWindows(value: string): string {
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return result + "\\".repeat(backslashes * 2) + '"';
}

function toGitBashPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`);
}

export function renderCommand(invocation: CommandInvocation, shell: "posix" | "windows" | "git-bash"): string {
  const values = [invocation.command, ...invocation.args];
  if (shell === "windows") return values.map(quoteWindows).join(" ");
  const commandValues = shell === "git-bash" ? values.map(toGitBashPath) : values;
  return commandValues.map(quotePosix).join(" ");
}

function defaultCliEntry(): string {
  const modulePath = fileURLToPath(import.meta.url);
  return resolve(dirname(modulePath), `index.${modulePath.endsWith(".ts") ? "ts" : "js"}`);
}

export function selfInvocation(entry = defaultCliEntry()): CommandInvocation {
  if (!entry.endsWith(".ts")) return { command: process.execPath, args: [entry] };
  const require = createRequire(import.meta.url);
  return { command: process.execPath, args: [require.resolve("tsx/cli"), entry] };
}

export function hookCommands(kind: "codex" | "claude", mode: "pre" | "post"): HookCommands {
  const self = selfInvocation();
  const invocation = { ...self, args: [...self.args, "_hook", kind, mode] };
  return {
    posix: renderCommand(invocation, "posix"),
    windows: renderCommand(invocation, "windows"),
    gitBash: renderCommand(invocation, "git-bash"),
  };
}

export function spawnPortable(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  return crossSpawn(command, [...args], options);
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
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

export async function terminateProcess(
  pid: number,
  label: string,
  options: { platform?: NodeJS.Platform; gracefulMs?: number; forceMs?: number } = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error(`refusing to stop ${label}: invalid recorded process id ${pid}`);
  }
  if (!processAlive(pid)) return false;

  const platform = options.platform ?? process.platform;
  const gracefulMs = options.gracefulMs ?? 3_000;
  const forceMs = options.forceMs ?? 2_000;
  if (platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error && processAlive(pid)) throw result.error;
    if (!await waitForProcessExit(pid, forceMs)) throw new Error(`could not stop ${label} (pid ${pid})`);
    return true;
  }

  try { process.kill(pid, "SIGTERM"); }
  catch (error) {
    if (!processAlive(pid)) return false;
    throw error;
  }
  if (await waitForProcessExit(pid, gracefulMs)) return true;
  process.kill(pid, "SIGKILL");
  if (!await waitForProcessExit(pid, forceMs)) throw new Error(`could not stop ${label} (pid ${pid})`);
  return true;
}

export function shellDisplayQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? quoteWindows(value) : quotePosix(value);
}

export function findGitBash(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (configured) return existsSync(configured) ? resolve(configured) : undefined;

  const candidates = [
    env.ProgramFiles ? join(env.ProgramFiles, "Git", "bin", "bash.exe") : undefined,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe") : undefined,
  ];
  const where = spawnSync("where.exe", ["git.exe"], { encoding: "utf8", windowsHide: true });
  if (where.status === 0) {
    for (const git of where.stdout.split(/\r?\n/).filter(Boolean)) {
      candidates.push(resolve(dirname(git), "..", "bin", "bash.exe"));
    }
  }
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}
