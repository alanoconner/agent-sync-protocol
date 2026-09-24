// Claude Code PreToolUse/PostToolUse hook bridge — an example integration,
// not part of the core library. Spec Section 3.3a designates a FUSE/WinFsp
// mount as the mechanism for CLI coding agents like Claude Code (they call
// OS filesystem syscalls directly, with no MCP layer or rebindable tool
// registry in the path) — but this repo's FUSE driver only implements enough
// syscalls to prove per-file merge semantics in tests (no readdir/mkdir), and
// mounting needs macFUSE installed on the host. Section 3.3's tier 2 ("a
// plugin/middleware hook that runs before a built-in file tool executes")
// covers this instead: Claude Code's own PreToolUse/PostToolUse hooks are
// exactly that middleware hook, and route through this project's existing
// SyncFileOps with zero core-library changes and no system installs.
//
// How it works, per tool call:
//   PreToolUse  (Read | Edit | Write) — pulls the file's current CRDT-merged
//     content and overwrites local disk with it *before* the built-in tool
//     runs, so the tool always sees fresh shared state (same principle as
//     Section 3.1's read-path swap), and stashes that content as the
//     "before" snapshot for the matching PostToolUse call.
//   PostToolUse (Edit | Write) — reads what the built-in tool just wrote to
//     disk and pushes it into the sync layer via writeFileFromSnapshot, the
//     same match-or-reject discipline FUSE's flush() uses (Section 3.3a).
//     A rejection (concurrent edit, EAGAIN; lock held, EBUSY; validation
//     gate, EVALIDATE) reverts the local file to current shared truth and
//     exits 2 so Claude Code surfaces the message to the agent as feedback —
//     "the edit didn't stick, here's why, re-read and retry" (Section 3.5/3.6),
//     not a silently-lost local-only edit.
//   Bash (Pre + Post) — the command is never parsed. Pre pulls every room the
//     server already holds onto disk and snapshots the workspace; Post diffs
//     the workspace against that snapshot and pushes whatever changed through
//     the same match-or-reject path, however the change was made (sed, a
//     script, a formatter). Deletions and binary/oversized files aren't
//     synced. See workspaceScan.ts.
//
// Wire it into a project's .claude/settings.json — see
// claudeCodeHookSettings.example.json in this directory.
//
// Configuration: the workspace's own .agent-sync.yml (Phase 7, Section 7) —
// `server` and `paths.exclusive` — read the same way the MCP proxy and FUSE
// mount read it (resolveSyncFileOpsOptions). Env vars AGENT_SYNC_SERVER and
// AGENT_SYNC_EXCLUSIVE_PATHS (comma-separated relative paths) still work as
// per-hook overrides of those two fields, for setups without a config file.
//
// The sync server MUST be running with a repo root (AGENT_SYNC_REPO_ROOT, or
// `agent-sync server --repo-root`): that's what hydrates a brand-new room
// from the working tree on first touch. Against a server with no repo root,
// every room starts empty, and the Pre hook would faithfully overwrite an
// existing local file with that emptiness.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { statusUrlFor } from "../src/cli/dashboardView.js";
import { CONFIG_FILE_NAME, loadAgentSyncConfigOrDefault, resolveSyncFileOpsOptions } from "../src/config/agentSyncConfig.js";
import { SyncFileOps, type SyncFileOpsOptions } from "../src/sync/syncFileOps.js";
import { HookSnapshots, type SnapshotIdentity } from "./hookSnapshots.js";
import { WorkspaceScanner } from "./workspaceScan.js";
import { findWorkspaceRoot, toDocName } from "./workspaceRoot.js";

interface HookInput {
  session_id?: string;
  tool_use_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string };
}

const snapshots = new HookSnapshots();

function hookConfig(ownerId: string, workspaceRoot: string): { options: SyncFileOpsOptions; ignore: string[] } {
  const config = loadAgentSyncConfigOrDefault(join(workspaceRoot, CONFIG_FILE_NAME));
  const envExclusive = process.env.AGENT_SYNC_EXCLUSIVE_PATHS;
  const options = resolveSyncFileOpsOptions(config, {
    syncServerUrl: process.env.AGENT_SYNC_SERVER,
    exclusivePaths: envExclusive === undefined ? undefined : envExclusive.split(",").map((p) => p.trim()).filter(Boolean),
    ownerId,
  });
  return { options, ignore: config.paths.ignore };
}

/** Make local disk match `content`. No-op when it already does (a redundant write only bumps mtime, which makes Claude Code think the file changed under it), and never materializes an empty stray file for a path that exists nowhere. */
function materialize(filePath: string, content: string): void {
  const exists = existsSync(filePath);
  if (exists ? readFileSync(filePath, "utf8") === content : content === "") return;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

async function runPre(ops: SyncFileOps, docName: string, filePath: string, identity?: SnapshotIdentity): Promise<void> {
  // A room being created right now is seeded by the server from its repo
  // root's working tree (createDiskHydrator) before this read resolves, so
  // an existing file comes back as itself, not as an empty doc — no
  // client-side "is the room empty but disk isn't?" guesswork needed here.
  const remoteContent = await ops.readFile(docName);
  if (identity) snapshots.stash(identity, docName, remoteContent);
  materialize(filePath, remoteContent);
}

/** Push `newContent` against `oldSnapshot`; on a rejection, revert the local file to shared truth and exit 2 so Claude Code shows the agent the message. */
async function pushWrite(ops: SyncFileOps, docName: string, filePath: string, oldSnapshot: string, newContent: string, opts: { prefix?: string; isNew?: boolean } = {}): Promise<void> {
  try {
    await ops.writeFileFromSnapshot(docName, oldSnapshot, newContent);
  } catch (err) {
    const current = await ops.readFile(docName);
    if (opts.isNew && current === "") rmSync(filePath, { force: true });
    else writeFileSync(filePath, current, "utf8");
    console.error(`${opts.prefix ?? ""}${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}

async function runPost(ops: SyncFileOps, docName: string, filePath: string, identity: SnapshotIdentity): Promise<void> {
  const oldSnapshot = snapshots.take(identity, docName);
  const newContent = readFileSync(filePath, "utf8");
  if (newContent === oldSnapshot) return;
  await pushWrite(ops, docName, filePath, oldSnapshot, newContent);
}

/**
 * `Bash` can change any file by any means, and its command string can't be parsed reliably (two live runs
 * bypassed sync through a Python script / sed the path scan misread), so this doesn't look at the command at
 * all: Pre pulls every room the server already has (so the command sees shared truth) and snapshots the
 * workspace; Post diffs the workspace against that snapshot and pushes whatever changed, via the same
 * match-or-reject path as Edit/Write. See workspaceScan.ts.
 */
function runIdFor(identity: SnapshotIdentity): string {
  if (!identity.sessionId || !identity.toolUseId) throw new Error("Bash hook requires session_id and tool_use_id.");
  return createHash("sha256").update(JSON.stringify([identity.sessionId, identity.toolUseId])).digest("hex");
}

/** Rooms the server already holds — the only files whose shared content could differ from local disk. Empty (i.e. skip the pull) if the status endpoint is unreachable. */
async function fetchRoomNames(serverUrl: string): Promise<string[]> {
  try {
    const res = await fetch(statusUrlFor(serverUrl), { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { rooms?: { docName: string }[] };
    return (body.rooms ?? []).map((room) => room.docName);
  } catch {
    return [];
  }
}

async function runPreBash(ops: SyncFileOps, scanner: WorkspaceScanner, workspaceRoot: string, serverUrl: string, identity: SnapshotIdentity): Promise<void> {
  const runId = runIdFor(identity);
  const docNames = (await fetchRoomNames(serverUrl)).filter((docName) => {
    const abs = resolve(workspaceRoot, docName);
    return toDocName(workspaceRoot, abs) === docName && !scanner.isExcluded(docName);
  });
  await Promise.all(docNames.map(async (docName) => materialize(join(workspaceRoot, docName), await ops.readFile(docName))));
  scanner.saveRun(runId, scanner.snapshot());
}

async function runPostBash(ops: SyncFileOps, scanner: WorkspaceScanner, workspaceRoot: string, identity: SnapshotIdentity): Promise<void> {
  const { changes, warnings } = scanner.changes(scanner.takeRun(runIdFor(identity)));
  for (const warning of warnings) console.error(`agent-sync: ${warning}`);
  for (const change of changes) {
    await pushWrite(ops, change.docName, join(workspaceRoot, change.docName), change.before, change.after, {
      prefix: `${change.docName}: `,
      isNew: change.isNew,
    });
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const raw = readFileSync(0, "utf8");
  const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
  const baseDir = input.cwd ?? process.cwd();
  const workspaceRoot = findWorkspaceRoot(baseDir);
  const identity = { workspaceRoot, sessionId: input.session_id, toolUseId: input.tool_use_id };

  if (input.tool_name === "Bash") {
    const { options, ignore } = hookConfig(input.session_id ?? workspaceRoot, workspaceRoot);
    const ops = new SyncFileOps(options);
    const scanner = new WorkspaceScanner(workspaceRoot, ignore);
    try {
      if (mode === "pre") {
        await runPreBash(ops, scanner, workspaceRoot, options.serverUrl, identity);
      } else if (mode === "post") {
        await runPostBash(ops, scanner, workspaceRoot, identity);
      }
    } finally {
      await ops.close();
    }
    return;
  }

  if (input.tool_name !== "Read" && input.tool_name !== "Edit" && input.tool_name !== "Write") return;
  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== "string") return;

  const docName = toDocName(workspaceRoot, filePath);
  if (docName === null) return;

  const ops = new SyncFileOps(hookConfig(input.session_id ?? workspaceRoot, workspaceRoot).options);
  try {
    if (mode === "pre") {
      await runPre(ops, docName, filePath, input.tool_name === "Read" ? undefined : identity);
    } else if (mode === "post" && input.tool_name !== "Read") {
      await runPost(ops, docName, filePath, identity);
    }
  } finally {
    await ops.close();
  }
}

main().catch((err) => {
  // Fail open: a broken/unreachable sync server degrades to "no sync for
  // this tool call" rather than hard-blocking the agent's own tool — the
  // deliberate rejection path (RangeMismatchError/LockDeniedError/
  // ValidationRejectedError) is handled inside runPost above and always
  // exits 2 on purpose; this catch is only for things like "server down."
  console.error(`agent-sync hook warning: ${err instanceof Error ? err.message : String(err)}`);
});
