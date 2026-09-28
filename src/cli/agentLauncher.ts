import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeJsonAtomic, type AgentKind, type AgentRecord, type DaemonState } from "./sessionState.js";
import { updateAgent } from "./sessionManager.js";

export interface AgentLaunchOptions {
  executable?: string;
  args?: string[];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function cliCommand(): string {
  const entry = resolve(process.argv[1]);
  if (entry.endsWith(".ts")) return `${shellQuote(resolve(dirname(entry), "../../node_modules/.bin/tsx"))} ${shellQuote(entry)}`;
  return `${shellQuote(process.execPath)} ${shellQuote(entry)}`;
}

export function hookCommand(kind: AgentKind, mode: "pre" | "post"): string {
  return `${cliCommand()} _hook ${kind} ${mode}`;
}

export function codexHookOverrides(): string[] {
  const pre = JSON.stringify(hookCommand("codex", "pre"));
  const post = JSON.stringify(hookCommand("codex", "post"));
  return [
    `hooks.PreToolUse=[{matcher="^(apply_patch|Bash)$",hooks=[{type="command",command=${pre},statusMessage="Refreshing shared workspace state"}]}]`,
    `hooks.PostToolUse=[{matcher="^(apply_patch|Bash)$",hooks=[{type="command",command=${post},statusMessage="Publishing workspace changes"}]}]`,
  ];
}

export function validateForwardedArgs(kind: AgentKind, args: string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (kind === "codex" && (
      arg === "-C" || arg.startsWith("-C=") || /^-C[^-]/.test(arg)
      || arg === "--cd" || arg.startsWith("--cd=")
      || arg === "--worktree" || arg.startsWith("--worktree=")
    )) {
      throw new Error(`${arg} is managed by ASL and cannot be forwarded`);
    }
    if (kind === "codex" && (arg === "-c" || arg === "--config" || arg.startsWith("-c=") || arg.startsWith("--config="))) {
      const inline = arg.startsWith("-c=") || arg.startsWith("--config=");
      const value = inline ? arg.slice(arg.indexOf("=") + 1) : args[index + 1] ?? "";
      if (value.startsWith("hooks.")) throw new Error("Codex hook configuration is managed by ASL");
      if (!inline) index += 1;
    }
    if (kind === "claude" && (arg === "--settings" || arg.startsWith("--settings="))) throw new Error("Claude --settings is managed by ASL");
  }
}

function claudeSettings(stateDir: string, agent: AgentRecord): string {
  const path = join(stateDir, "settings", `${agent.id}.claude.json`);
  mkdirSync(join(stateDir, "settings"), { recursive: true, mode: 0o700 });
  writeJsonAtomic(path, {
    hooks: {
      PreToolUse: [{ matcher: "Read|Edit|Write|Bash", hooks: [{ type: "command", command: hookCommand("claude", "pre") }] }],
      PostToolUse: [{ matcher: "Edit|Write|Bash", hooks: [{ type: "command", command: hookCommand("claude", "post") }] }],
    },
  });
  return path;
}

export async function launchAgent(
  stateDir: string,
  agent: AgentRecord,
  daemon: DaemonState,
  options: AgentLaunchOptions = {},
): Promise<number> {
  const forwarded = options.args ?? [];
  validateForwardedArgs(agent.kind, forwarded);
  const executable = options.executable ?? agent.kind;
  const args = agent.kind === "codex"
    ? ["-C", agent.worktree, ...codexHookOverrides().flatMap((value) => ["-c", value]), ...forwarded]
    : ["--settings", claudeSettings(stateDir, agent), ...forwarded];
  const child = spawn(executable, args, {
    cwd: agent.worktree,
    stdio: "inherit",
    env: {
      ...process.env,
      AGENT_SYNC_SERVER: daemon.serverUrl,
      ASL_SESSION_ID: agent.id,
    },
  });
  return await new Promise<number>((resolvePromise, reject) => {
    child.once("spawn", () => updateAgent(stateDir, agent.id, { pid: child.pid, status: "running" }));
    child.once("error", (error) => {
      updateAgent(stateDir, agent.id, { status: "exited", exitCode: 127, pid: undefined });
      reject(new Error(`failed to start ${executable}: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0);
      updateAgent(stateDir, agent.id, { status: "exited", exitCode, pid: undefined });
      resolvePromise(exitCode);
    });
  });
}
