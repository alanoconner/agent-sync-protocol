#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_FILE_NAME, loadAgentSyncConfigOrDefault, writeDefaultConfig } from "../config/agentSyncConfig.js";
import { startAgentSyncServer } from "../server/bootstrap.js";
import type { ServerStatus } from "../server/syncServer.js";
import { formatStatus, statusUrlFor } from "./dashboardView.js";

function usage(): void {
  console.log(`Usage: agent-sync <command> [options]

Commands:
  init                 Write a default ${CONFIG_FILE_NAME} in the current directory
  server               Start the sync server, configured from ${CONFIG_FILE_NAME}
  dashboard            Live "who's editing what" view (Section 10, Phase 7)

Options:
  init:       --force            Overwrite an existing ${CONFIG_FILE_NAME}
  server:     --config <path>    Config file to read (default: ./${CONFIG_FILE_NAME})
              --repo-root <path> Directory to flush to (default: current directory)
  dashboard:  --server <ws-url>  Server to watch (default: from config, else ws://localhost:4600)
              --interval <ms>    Poll interval (default: 1000)`);
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function runInit(args: string[]): void {
  const path = resolve(process.cwd(), CONFIG_FILE_NAME);
  const { written } = writeDefaultConfig(path, args.includes("--force"));
  if (!written) {
    console.error(`${CONFIG_FILE_NAME} already exists at ${path} (use --force to overwrite)`);
    process.exitCode = 1;
    return;
  }
  console.log(`Wrote ${path}`);
}

function portFromServerUrl(serverUrl: string): number {
  const port = new URL(serverUrl).port;
  return port ? Number(port) : 4600;
}

function runServer(args: string[]): void {
  const configPath = resolve(process.cwd(), flagValue(args, "--config") ?? CONFIG_FILE_NAME);
  if (!existsSync(configPath)) {
    console.log(`No ${CONFIG_FILE_NAME} found at ${configPath} — using defaults (run "agent-sync init" to create one).`);
  }
  const config = loadAgentSyncConfigOrDefault(configPath);
  const repoRoot = resolve(process.cwd(), flagValue(args, "--repo-root") ?? ".");

  startAgentSyncServer({
    port: portFromServerUrl(config.server),
    repoRoot,
    flushDebounceMs: config.flush.debounceMs,
    validation: config.validation,
  });
}

async function runDashboard(args: string[]): Promise<void> {
  const configPath = resolve(process.cwd(), CONFIG_FILE_NAME);
  const configuredServer = existsSync(configPath) ? loadAgentSyncConfigOrDefault(configPath).server : undefined;
  const serverUrl = flagValue(args, "--server") ?? configuredServer ?? "ws://localhost:4600";
  const intervalMs = Number(flagValue(args, "--interval") ?? 1000);
  const statusUrl = statusUrlFor(serverUrl);

  console.log(`agent-sync dashboard — watching ${serverUrl} (Ctrl+C to quit)`);
  for (;;) {
    await renderOnce(statusUrl);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function renderOnce(statusUrl: string): Promise<void> {
  console.clear();
  console.log(`agent-sync dashboard — ${new Date().toLocaleTimeString()}\n`);
  try {
    const res = await fetch(statusUrl);
    if (!res.ok) throw new Error(`server responded ${res.status}`);
    const status = (await res.json()) as ServerStatus;
    for (const line of formatStatus(status)) console.log(line);
  } catch (err) {
    console.error(`Could not reach ${statusUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      runInit(rest);
      break;
    case "server":
      runServer(rest);
      break;
    case "dashboard":
      await runDashboard(rest);
      break;
    default:
      usage();
      process.exitCode = command ? 1 : 0;
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
