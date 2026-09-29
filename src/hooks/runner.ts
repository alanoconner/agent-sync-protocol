import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { statusUrlFor } from "../cli/dashboardView.js";
import { CONFIG_FILE_NAME, loadAgentSyncConfigOrDefault, resolveSyncFileOpsOptions } from "../config/agentSyncConfig.js";
import { SyncFileOps, type SyncFileOpsOptions } from "../sync/syncFileOps.js";
import { fromLf, type LineEndingStyle } from "../sync/lineEndings.js";
import type { SyncedFileState } from "../sync/fileState.js";
import { HookSnapshots, type SnapshotIdentity } from "./hookSnapshots.js";
import { WorkspaceScanner } from "./workspaceScan.js";
import { findWorkspaceRoot, toDocName } from "./workspaceRoot.js";

export type HookAgent = "codex" | "claude";
export type HookMode = "pre" | "post";

interface HookInput {
  session_id?: string;
  tool_use_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string };
}

const snapshots = new HookSnapshots();

function hookConfig(ownerId: string, workspaceRoot: string, env: NodeJS.ProcessEnv): {
  options: SyncFileOpsOptions;
  ignore: string[];
  lineEndings: LineEndingStyle;
} {
  const config = loadAgentSyncConfigOrDefault(join(workspaceRoot, CONFIG_FILE_NAME));
  const envExclusive = env.AGENT_SYNC_EXCLUSIVE_PATHS;
  const options = resolveSyncFileOpsOptions(config, {
    syncServerUrl: env.AGENT_SYNC_SERVER,
    exclusivePaths: envExclusive === undefined ? undefined : envExclusive.split(",").map((path) => path.trim()).filter(Boolean),
    ownerId,
  });
  return { options, ignore: config.paths.ignore, lineEndings: config.lineEndings };
}

function materialize(filePath: string, state: SyncedFileState, lineEndings: LineEndingStyle): void {
  if (!state.exists) {
    rmSync(filePath, { force: true });
    return;
  }
  const diskContent = fromLf(state.content, lineEndings);
  const exists = existsSync(filePath);
  if (exists ? readFileSync(filePath, "utf8") === diskContent : diskContent === "") return;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, diskContent, "utf8");
}

async function fetchRoomNames(serverUrl: string): Promise<string[]> {
  const statusUrl = statusUrlFor(serverUrl);
  let response: Response;
  try {
    response = await fetch(statusUrl, { signal: AbortSignal.timeout(2000) });
  } catch (error) {
    throw new Error(`cannot query sync status at ${statusUrl}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!response.ok) throw new Error(`sync status request failed at ${statusUrl}: HTTP ${response.status} ${response.statusText}`.trim());

  let body: unknown;
  try { body = await response.json(); }
  catch (error) {
    throw new Error(`sync status response at ${statusUrl} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!body || typeof body !== "object" || !("rooms" in body) || !Array.isArray(body.rooms)) {
    throw new Error(`sync status response at ${statusUrl} does not contain a rooms array`);
  }
  const rooms = body.rooms as unknown[];
  if (!rooms.every((room) => room !== null && typeof room === "object" && "docName" in room && typeof room.docName === "string")) {
    throw new Error(`sync status response at ${statusUrl} contains an invalid room entry`);
  }
  return rooms.map((room) => (room as { docName: string }).docName);
}

function runIdFor(identity: SnapshotIdentity): string {
  if (!identity.sessionId || !identity.toolUseId) throw new Error("Hook requires session_id and tool_use_id.");
  return createHash("sha256").update(JSON.stringify([identity.sessionId, identity.toolUseId])).digest("hex");
}

async function pullRooms(
  ops: SyncFileOps,
  scanner: WorkspaceScanner,
  workspaceRoot: string,
  serverUrl: string,
  lineEndings: LineEndingStyle,
): Promise<void> {
  const docNames = (await fetchRoomNames(serverUrl)).filter((docName) => {
    const absolutePath = resolve(workspaceRoot, docName);
    return toDocName(workspaceRoot, absolutePath) === docName && !scanner.isExcluded(docName);
  });
  await Promise.all(docNames.map(async (docName) => materialize(join(workspaceRoot, docName), await ops.readFileState(docName), lineEndings)));
}

async function pullRoomsAndSnapshot(
  ops: SyncFileOps,
  scanner: WorkspaceScanner,
  workspaceRoot: string,
  identity: SnapshotIdentity,
  serverUrl: string,
  lineEndings: LineEndingStyle,
): Promise<void> {
  await pullRooms(ops, scanner, workspaceRoot, serverUrl, lineEndings);
  scanner.saveRun(runIdFor(identity), scanner.snapshot());
}

async function pushWrite(
  ops: SyncFileOps,
  workspaceRoot: string,
  docName: string,
  before: string | null,
  after: string,
  isNew: boolean,
  lineEndings: LineEndingStyle,
): Promise<boolean> {
  try {
    await ops.writeFileFromSnapshot(docName, isNew ? null : before, after);
    return true;
  } catch (error) {
    const current = await ops.readFileState(docName);
    const filePath = join(workspaceRoot, docName);
    materialize(filePath, current, lineEndings);
    console.error(`${docName}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function pushDelete(
  ops: SyncFileOps,
  workspaceRoot: string,
  docName: string,
  before: string,
  lineEndings: LineEndingStyle,
): Promise<boolean> {
  try {
    await ops.deleteFileFromSnapshot(docName, before);
    return true;
  } catch (error) {
    materialize(join(workspaceRoot, docName), await ops.readFileState(docName), lineEndings);
    console.error(`${docName}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function publishWorkspace(
  ops: SyncFileOps,
  scanner: WorkspaceScanner,
  workspaceRoot: string,
  identity: SnapshotIdentity,
  lineEndings: LineEndingStyle,
): Promise<boolean> {
  const { changes, warnings } = scanner.changes(scanner.takeRun(runIdFor(identity)));
  for (const warning of warnings) console.error(`agent-sync: ${warning}`);
  let accepted = true;
  for (const change of changes) {
    const published = change.kind === "delete"
      ? await pushDelete(ops, workspaceRoot, change.docName, change.before, lineEndings)
      : await pushWrite(ops, workspaceRoot, change.docName, change.before, change.after, change.isNew, lineEndings);
    accepted = published && accepted;
  }
  return accepted;
}

async function runCodex(mode: HookMode, input: HookInput, env: NodeJS.ProcessEnv): Promise<number> {
  const publishesWorkspace = input.tool_name === "apply_patch" || input.tool_name === "Bash";
  if (mode === "post" && !publishesWorkspace) return 0;
  const workspaceRoot = findWorkspaceRoot(input.cwd ?? process.cwd(), { ...env, CLAUDE_PROJECT_DIR: "" });
  const identity = { workspaceRoot, sessionId: input.session_id, toolUseId: input.tool_use_id };
  const { options, ignore, lineEndings } = hookConfig(input.session_id ?? workspaceRoot, workspaceRoot, env);
  const ops = new SyncFileOps(options);
  const scanner = new WorkspaceScanner(workspaceRoot, ignore);
  try {
    if (mode === "pre") {
      if (publishesWorkspace) await pullRoomsAndSnapshot(ops, scanner, workspaceRoot, identity, options.serverUrl, lineEndings);
      else await pullRooms(ops, scanner, workspaceRoot, options.serverUrl, lineEndings);
    } else if (!(await publishWorkspace(ops, scanner, workspaceRoot, identity, lineEndings))) {
      console.error(`agent-sync codex PostToolUse failed for ${input.tool_name}: one or more workspace changes were rejected; affected files were restored to shared state.`);
      return 2;
    }
    return 0;
  } finally { await ops.close(); }
}

async function runClaude(mode: HookMode, input: HookInput, env: NodeJS.ProcessEnv): Promise<number> {
  const workspaceRoot = findWorkspaceRoot(input.cwd ?? process.cwd(), env);
  const identity = { workspaceRoot, sessionId: input.session_id, toolUseId: input.tool_use_id };
  const { options, ignore, lineEndings } = hookConfig(input.session_id ?? workspaceRoot, workspaceRoot, env);
  const ops = new SyncFileOps(options);
  try {
    if (input.tool_name === "Bash") {
      const scanner = new WorkspaceScanner(workspaceRoot, ignore);
      if (mode === "pre") await pullRoomsAndSnapshot(ops, scanner, workspaceRoot, identity, options.serverUrl, lineEndings);
      else if (!(await publishWorkspace(ops, scanner, workspaceRoot, identity, lineEndings))) return 2;
      return 0;
    }
    if (input.tool_name !== "Read" && input.tool_name !== "Edit" && input.tool_name !== "Write") return 0;
    const filePath = input.tool_input?.file_path;
    if (!filePath) return 0;
    const docName = toDocName(workspaceRoot, filePath);
    if (docName === null) return 0;
    if (mode === "pre") {
      const remote = await ops.readFileState(docName);
      if (input.tool_name !== "Read") snapshots.stash(identity, docName, remote.exists ? fromLf(remote.content, lineEndings) : null);
      materialize(filePath, remote, lineEndings);
    } else if (input.tool_name !== "Read") {
      const before = snapshots.take(identity, docName);
      const after = readFileSync(filePath, "utf8");
      if (before !== after && !(await pushWrite(ops, workspaceRoot, docName, before, after, false, lineEndings))) return 2;
    }
    return 0;
  } finally { await ops.close(); }
}

export async function runHook(agent: HookAgent, mode: HookMode, raw: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let toolName: string | undefined;
  try {
    const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
    toolName = input.tool_name;
    return agent === "codex" ? await runCodex(mode, input, env) : await runClaude(mode, input, env);
  } catch (error) {
    const phase = mode === "pre" ? "PreToolUse" : "PostToolUse";
    const target = toolName ? ` for ${toolName}` : "";
    console.error(`agent-sync ${agent} ${phase} failed${target}: ${error instanceof Error ? error.message : String(error)}`);
    // Infrastructure failures are not safe to wave through: the tool may
    // otherwise report success even though its CRDT update was never durably
    // accepted. Ordinary scanner warnings are handled inside the workflow.
    return 2;
  }
}
