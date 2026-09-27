// Codex PreToolUse/PostToolUse hook bridge. Codex reports file edits with the
// canonical tool name `apply_patch`; shell and unified-exec calls are reported
// as `Bash`. Both expose matching session_id/tool_use_id values across their
// Pre/Post pair.
//
// Unlike Claude Code's Edit/Write events, apply_patch supplies patch text in
// tool_input.command rather than one file_path. Parsing that patch to guess the
// affected paths would recreate the same bypass class the Bash bridge used to
// have. Instead, both supported Codex tools use a command-agnostic workspace
// snapshot: Pre pulls every active room and snapshots all syncable text files;
// Post diffs the workspace and pushes each changed/new file through
// writeFileFromSnapshot's exact-match-or-reject path.
//
// Put examples/codexHookSettings.example.json at the canonical/main checkout's
// <repo>/.codex/hooks.json, replace the absolute paths, then review/trust it
// with Codex's /hooks command. For linked Git worktrees, Codex discovers the
// project hook from that main worktree rather than a copy that exists only in
// the linked worktree. The sync server MUST be running with a repo root so
// first-touch rooms hydrate from the canonical working tree.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { statusUrlFor } from "../src/cli/dashboardView.js";
import {
  CONFIG_FILE_NAME,
  loadAgentSyncConfigOrDefault,
  resolveSyncFileOpsOptions,
} from "../src/config/agentSyncConfig.js";
import { SyncFileOps, type SyncFileOpsOptions } from "../src/sync/syncFileOps.js";
import type { SnapshotIdentity } from "./hookSnapshots.js";
import { WorkspaceScanner } from "./workspaceScan.js";
import { findWorkspaceRoot, toDocName } from "./workspaceRoot.js";

interface CodexHookInput {
  session_id?: string;
  tool_use_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { command?: string };
}

function hookConfig(ownerId: string, workspaceRoot: string): { options: SyncFileOpsOptions; ignore: string[] } {
  const config = loadAgentSyncConfigOrDefault(join(workspaceRoot, CONFIG_FILE_NAME));
  const envExclusive = process.env.AGENT_SYNC_EXCLUSIVE_PATHS;
  const options = resolveSyncFileOpsOptions(config, {
    syncServerUrl: process.env.AGENT_SYNC_SERVER,
    exclusivePaths:
      envExclusive === undefined
        ? undefined
        : envExclusive
            .split(",")
            .map((path) => path.trim())
            .filter(Boolean),
    ownerId,
  });
  return { options, ignore: config.paths.ignore };
}

function runIdFor(identity: SnapshotIdentity): string {
  if (!identity.sessionId || !identity.toolUseId) {
    throw new Error("Codex hook requires session_id and tool_use_id.");
  }
  return createHash("sha256")
    .update(JSON.stringify([identity.sessionId, identity.toolUseId]))
    .digest("hex");
}

function materialize(filePath: string, content: string): void {
  const exists = existsSync(filePath);
  if (exists ? readFileSync(filePath, "utf8") === content : content === "") return;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

async function fetchRoomNames(serverUrl: string): Promise<string[]> {
  try {
    const response = await fetch(statusUrlFor(serverUrl), { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return [];
    const body = (await response.json()) as { rooms?: { docName: string }[] };
    return (body.rooms ?? []).map((room) => room.docName);
  } catch {
    return [];
  }
}

async function runPre(
  ops: SyncFileOps,
  scanner: WorkspaceScanner,
  workspaceRoot: string,
  serverUrl: string,
  identity: SnapshotIdentity,
): Promise<void> {
  const docNames = (await fetchRoomNames(serverUrl)).filter((docName) => {
    const absolutePath = resolve(workspaceRoot, docName);
    return toDocName(workspaceRoot, absolutePath) === docName && !scanner.isExcluded(docName);
  });
  await Promise.all(
    docNames.map(async (docName) => materialize(join(workspaceRoot, docName), await ops.readFile(docName))),
  );
  scanner.saveRun(runIdFor(identity), scanner.snapshot());
}

async function pushWrite(
  ops: SyncFileOps,
  workspaceRoot: string,
  docName: string,
  oldSnapshot: string,
  newContent: string,
  isNew: boolean,
): Promise<void> {
  const filePath = join(workspaceRoot, docName);
  try {
    await ops.writeFileFromSnapshot(docName, oldSnapshot, newContent);
  } catch (error) {
    const current = await ops.readFile(docName);
    if (isNew && current === "") rmSync(filePath, { force: true });
    else writeFileSync(filePath, current, "utf8");
    console.error(`${docName}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

async function runPost(
  ops: SyncFileOps,
  scanner: WorkspaceScanner,
  workspaceRoot: string,
  identity: SnapshotIdentity,
): Promise<void> {
  const { changes, warnings } = scanner.changes(scanner.takeRun(runIdFor(identity)));
  for (const warning of warnings) console.error(`agent-sync: ${warning}`);
  for (const change of changes) {
    await pushWrite(ops, workspaceRoot, change.docName, change.before, change.after, change.isNew);
  }
}

function includesDeleteOperation(command: string | undefined): boolean {
  return typeof command === "string" && /^\*\*\* Delete File:/m.test(command);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "pre" && mode !== "post") return;

  const raw = readFileSync(0, "utf8");
  const input = (raw.trim() ? JSON.parse(raw) : {}) as CodexHookInput;
  if (input.tool_name !== "apply_patch" && input.tool_name !== "Bash") return;

  // The current sync model has text content but no tombstone/delete operation.
  // Fail before Codex touches disk rather than silently leaving the room and
  // canonical checkout with a file that only disappeared in one worktree.
  if (mode === "pre" && input.tool_name === "apply_patch" && includesDeleteOperation(input.tool_input?.command)) {
    console.error(
      "agent-sync: apply_patch file deletion is not supported by the sync protocol; delete the file outside this synchronized session.",
    );
    process.exitCode = 2;
    return;
  }

  // Ignore a stray Claude-only project override inherited from a parent shell;
  // Codex's documented hook payload identifies the workspace through `cwd`.
  const workspaceRoot = findWorkspaceRoot(input.cwd ?? process.cwd(), {
    ...process.env,
    CLAUDE_PROJECT_DIR: "",
  });
  const identity: SnapshotIdentity = {
    workspaceRoot,
    sessionId: input.session_id,
    toolUseId: input.tool_use_id,
  };
  const { options, ignore } = hookConfig(input.session_id ?? workspaceRoot, workspaceRoot);
  const ops = new SyncFileOps(options);
  const scanner = new WorkspaceScanner(workspaceRoot, ignore);
  try {
    if (mode === "pre") await runPre(ops, scanner, workspaceRoot, options.serverUrl, identity);
    else await runPost(ops, scanner, workspaceRoot, identity);
  } finally {
    await ops.close();
  }
}

main().catch((error) => {
  // Infrastructure failures remain fail-open, matching the Claude bridge. A
  // deliberate merge/lock/validation rejection is handled above with exit 2.
  console.error(`agent-sync Codex hook warning: ${error instanceof Error ? error.message : String(error)}`);
});
