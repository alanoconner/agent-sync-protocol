#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { CONFIG_FILE_NAME, loadAgentSyncConfigOrDefault, writeDefaultConfig } from "../config/agentSyncConfig.js";
import { runHook, type HookAgent, type HookMode } from "../hooks/runner.js";
import { startAgentSyncServer } from "../server/bootstrap.js";
import type { ServerStatus } from "../server/syncServer.js";
import { launchAgent } from "./agentLauncher.js";
import { formatStatus, statusUrlFor } from "./dashboardView.js";
import { runSessionDaemon } from "./sessionDaemon.js";
import { cleanSession, createAgentWorktree, ensureDaemon, ensureSession, finishSession, stopSession } from "./sessionManager.js";
import { detectSetupCommand } from "./setupCommand.js";
import {
  discoverRepository,
  readDaemon,
  readSession,
  repositoryStateDir,
  trustPath,
  writeJsonAtomic,
  writeSession,
  type AgentKind,
} from "./sessionState.js";

function usage(): void {
  console.log(`Usage: asl <command> [options]

Commands:
  codex [options] [-- args]  Start Codex in a managed synchronized worktree
  claude [options] [-- args] Start Claude Code in a managed synchronized worktree
  status [--json]            Show the current repository session
  stop                       Flush and pause the current session
  finish                     Flush, validate, and prepare an uncommitted merge
  clean                      Remove safe managed worktrees; retain integration branch
  init [--force]             Write a default ${CONFIG_FILE_NAME}
  server [options]           Start a standalone sync server
  dashboard [options]        Live "who's editing what" view

Agent options:
  --name <name>       Name the managed agent/worktree
  --skip-setup        Do not run dependency setup for the new worktree
  --bin <path>        Override the codex/claude executable
  --yes               Accept the first-use executable configuration prompt
  --                  Pass all remaining arguments to the agent CLI

Server options:
  --config <path>     Config file (default: ./${CONFIG_FILE_NAME})
  --repo-root <path>  Directory to flush to (default: current directory)

Dashboard options:
  --server <ws-url>   Server to watch (default: active ASL session, then config)
  --interval <ms>     Poll interval (default: 1000)`);
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function runInit(args: string[]): void {
  const path = resolve(process.cwd(), CONFIG_FILE_NAME);
  const { written } = writeDefaultConfig(path, args.includes("--force"));
  if (!written) throw new Error(`${CONFIG_FILE_NAME} already exists at ${path} (use --force to overwrite)`);
  console.log(`Wrote ${path}`);
}

function portFromServerUrl(serverUrl: string): number {
  const port = new URL(serverUrl).port;
  return port ? Number(port) : 4600;
}

function runServer(args: string[]): void {
  const configPath = resolve(process.cwd(), flagValue(args, "--config") ?? CONFIG_FILE_NAME);
  if (!existsSync(configPath)) console.log(`No ${CONFIG_FILE_NAME} found at ${configPath} — using defaults.`);
  const config = loadAgentSyncConfigOrDefault(configPath);
  startAgentSyncServer({
    port: portFromServerUrl(config.server),
    repoRoot: resolve(process.cwd(), flagValue(args, "--repo-root") ?? "."),
    flushDebounceMs: config.flush.debounceMs,
    lineEndings: config.lineEndings,
    validation: config.validation,
  });
}

function activeServerUrl(): string | undefined {
  try {
    const repo = discoverRepository(process.cwd(), false);
    const daemon = readDaemon(repositoryStateDir(repo));
    if (daemon) return daemon.serverUrl;
  } catch { /* fall back to project config */ }
  return undefined;
}

async function runDashboard(args: string[]): Promise<void> {
  const configPath = resolve(process.cwd(), CONFIG_FILE_NAME);
  const configuredServer = existsSync(configPath) ? loadAgentSyncConfigOrDefault(configPath).server : undefined;
  const serverUrl = flagValue(args, "--server") ?? activeServerUrl() ?? configuredServer ?? "ws://localhost:4600";
  const intervalMs = Number(flagValue(args, "--interval") ?? 1000);
  console.log(`agent-sync dashboard — watching ${serverUrl} (Ctrl+C to quit)`);
  for (;;) {
    console.clear();
    console.log(`agent-sync dashboard — ${new Date().toLocaleTimeString()}\n`);
    try {
      const response = await fetch(statusUrlFor(serverUrl));
      if (!response.ok) throw new Error(`server responded ${response.status}`);
      for (const line of formatStatus(await response.json() as ServerStatus)) console.log(line);
    } catch (error) { console.error(`Could not reach ${statusUrlFor(serverUrl)}: ${error instanceof Error ? error.message : String(error)}`); }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

interface ParsedLaunch {
  name?: string;
  skipSetup: boolean;
  executable?: string;
  yes: boolean;
  forwarded: string[];
}

function parseLaunchArgs(args: string[]): ParsedLaunch {
  const separator = args.indexOf("--");
  const own = separator === -1 ? args : args.slice(0, separator);
  const forwarded = separator === -1 ? [] : args.slice(separator + 1);
  const result: ParsedLaunch = { skipSetup: false, yes: false, forwarded };
  for (let index = 0; index < own.length; index += 1) {
    const arg = own[index];
    if (arg === "--skip-setup") result.skipSetup = true;
    else if (arg === "--yes") result.yes = true;
    else if (arg === "--name" || arg === "--bin") {
      const value = own[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--name") result.name = value;
      else result.executable = value;
    } else throw new Error(`unknown ASL agent option: ${arg}; put agent CLI arguments after --`);
  }
  return result;
}

async function trustExecutableConfig(repoRoot: string, stateDir: string, yes: boolean, skipSetup: boolean): Promise<void> {
  const config = loadAgentSyncConfigOrDefault(resolve(repoRoot, CONFIG_FILE_NAME));
  const setup = skipSetup ? undefined : config.worktrees.setupCommand ?? (config.worktrees.autoInstall ? detectSetupCommand(repoRoot) : undefined);
  const effective = { setup, validation: config.validation };
  const hash = createHash("sha256").update(JSON.stringify(effective)).digest("hex");
  const recordPath = trustPath(stateDir);
  if (existsSync(recordPath)) {
    try { if ((JSON.parse(readFileSync(recordPath, "utf8")) as { hash?: string }).hash === hash) return; } catch { /* prompt again */ }
  }
  if (setup || config.validation) {
    console.log("ASL will execute this repository configuration:");
    if (setup) console.log(`  worktree setup: ${setup}`);
    if (config.validation) console.log(`  validation: ${config.validation.command} (${config.validation.onFail})`);
    if (!yes) {
      if (!input.isTTY) throw new Error("first use requires confirmation; inspect the commands and rerun with --yes");
      const prompt = createInterface({ input, output });
      const answer = await prompt.question("Trust this configuration? [y/N] ");
      prompt.close();
      if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error("configuration was not trusted");
    }
  }
  writeJsonAtomic(recordPath, { hash, trustedAt: new Date().toISOString() });
}

async function runAgent(kind: AgentKind, args: string[]): Promise<void> {
  const options = parseLaunchArgs(args);
  const repo = discoverRepository();
  const stateDir = repositoryStateDir(repo);
  await trustExecutableConfig(repo.root, stateDir, options.yes, options.skipSetup);
  let session = ensureSession(repo, stateDir, options.skipSetup);
  if (session.status === "paused") { session.status = "active"; writeSession(stateDir, session); }
  const daemon = await ensureDaemon(stateDir, session);
  const created = createAgentWorktree(repo, stateDir, kind, { name: options.name, skipSetup: options.skipSetup });
  console.log(`asl: ${kind} workspace ${created.agent.worktree}`);
  console.log(`asl: integration branch ${created.session.integrationBranch}`);
  if (kind === "codex") console.log("asl: on first use, open /hooks and trust the stable ASL hook definition before submitting work.");
  process.exitCode = await launchAgent(stateDir, created.agent, daemon, { executable: options.executable, args: options.forwarded });
}

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

function runStatus(args: string[]): void {
  const repo = discoverRepository(process.cwd(), false);
  const stateDir = repositoryStateDir(repo);
  const session = readSession(stateDir);
  if (!session) { console.log("No ASL session for this repository."); return; }
  const daemon = readDaemon(stateDir);
  const value = {
    ...session,
    daemon: daemon ? { ...daemon, running: processAlive(daemon.pid) } : null,
    agents: session.agents.map((agent) => ({ ...agent, running: Boolean(agent.pid && processAlive(agent.pid)) })),
  };
  if (args.includes("--json")) { console.log(JSON.stringify(value, null, 2)); return; }
  console.log(`ASL session ${session.sessionId} (${session.status})`);
  console.log(`  base: ${session.baseBranch} @ ${session.baseCommit.slice(0, 12)}`);
  console.log(`  integration: ${session.integrationBranch}`);
  console.log(`  daemon: ${daemon && processAlive(daemon.pid) ? daemon.serverUrl : "stopped"}`);
  for (const agent of value.agents) console.log(`  ${agent.id}: ${agent.kind} ${agent.running ? "running" : agent.status} — ${agent.worktree}`);
}

function quote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

async function runStop(): Promise<void> {
  const repo = discoverRepository(process.cwd(), false);
  const stateDir = repositoryStateDir(repo);
  const session = await stopSession(stateDir);
  console.log(`ASL session ${session.sessionId} paused; worktrees and ${session.integrationBranch} were retained.`);
}

async function runFinish(): Promise<void> {
  const repo = discoverRepository(process.cwd(), false);
  const stateDir = repositoryStateDir(repo);
  const { session, mergePrepared, integrationCommitCount } = await finishSession(stateDir);
  if (integrationCommitCount > 1) {
    console.log(`ASL compacted ${integrationCommitCount} integration flush commits into one commit.`);
  }
  if (!mergePrepared) {
    console.log(`ASL session ${session.sessionId} finished. The integration branch contains no new commits.`);
    return;
  }
  console.log(`ASL session ${session.sessionId} finished. Integration changes are staged on ${session.baseBranch}; no commit was created.`);
  console.log("Review or complete the pending merge:");
  console.log(`  git -C ${quote(session.repoRoot)} status`);
  console.log(`  git -C ${quote(session.repoRoot)} diff --cached`);
  console.log(`  git -C ${quote(session.repoRoot)} commit`);
  console.log(`  git -C ${quote(session.repoRoot)} merge --abort`);
}

async function runClean(): Promise<void> {
  const repo = discoverRepository(process.cwd(), false);
  const result = await cleanSession(repositoryStateDir(repo));
  console.log(`Removed safe ASL worktrees and agent branches. Integration branch retained: ${result.integrationBranch}`);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "codex": case "claude": await runAgent(command, rest); break;
    case "status": runStatus(rest); break;
    case "stop": await runStop(); break;
    case "finish": await runFinish(); break;
    case "clean": await runClean(); break;
    case "init": runInit(rest); break;
    case "server": runServer(rest); break;
    case "dashboard": await runDashboard(rest); break;
    case "_daemon": {
      const state = flagValue(rest, "--state");
      if (!state) throw new Error("_daemon requires --state");
      await runSessionDaemon(resolve(state));
      break;
    }
    case "_hook": {
      const [agent, mode] = rest as [HookAgent, HookMode];
      if ((agent !== "codex" && agent !== "claude") || (mode !== "pre" && mode !== "post")) throw new Error("invalid hook invocation");
      process.exitCode = await runHook(agent, mode, readFileSync(0, "utf8"));
      break;
    }
    default: usage(); process.exitCode = command ? 1 : 0;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`asl: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
