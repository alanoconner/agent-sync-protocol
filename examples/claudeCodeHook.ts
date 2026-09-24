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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_FILE_NAME, loadAgentSyncConfigOrDefault, resolveSyncFileOpsOptions } from "../src/config/agentSyncConfig.js";
import { SyncFileOps } from "../src/sync/syncFileOps.js";
import { HookSnapshots, type SnapshotIdentity } from "./hookSnapshots.js";
import { extractCandidatePaths, findWorkspaceRoot, toDocName } from "./workspaceRoot.js";

interface HookInput {
  session_id?: string;
  tool_use_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string };
}

const snapshots = new HookSnapshots();

function makeOps(ownerId: string, workspaceRoot: string): SyncFileOps {
  const config = loadAgentSyncConfigOrDefault(join(workspaceRoot, CONFIG_FILE_NAME));
  const envExclusive = process.env.AGENT_SYNC_EXCLUSIVE_PATHS;
  return new SyncFileOps(
    resolveSyncFileOpsOptions(config, {
      syncServerUrl: process.env.AGENT_SYNC_SERVER,
      exclusivePaths: envExclusive === undefined ? undefined : envExclusive.split(",").map((p) => p.trim()).filter(Boolean),
      ownerId,
    }),
  );
}

async function runPre(ops: SyncFileOps, docName: string, filePath: string, identity?: SnapshotIdentity): Promise<void> {
  // A room being created right now is seeded by the server from its repo
  // root's working tree (createDiskHydrator) before this read resolves, so
  // an existing file comes back as itself, not as an empty doc — no
  // client-side "is the room empty but disk isn't?" guesswork needed here.
  const remoteContent = await ops.readFile(docName);
  if (identity) snapshots.stash(identity, docName, remoteContent);

  // A path that exists nowhere (empty room, no local file) is a guess or a file about to be created —
  // don't materialize an empty stray file for it.
  if (remoteContent === "" && !existsSync(filePath)) return;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, remoteContent, "utf8");
}

async function runPost(ops: SyncFileOps, docName: string, filePath: string, identity: SnapshotIdentity): Promise<void> {
  const oldSnapshot = snapshots.take(identity, docName);
  const newContent = readFileSync(filePath, "utf8");
  if (newContent === oldSnapshot) return;

  try {
    await ops.writeFileFromSnapshot(docName, oldSnapshot, newContent);
  } catch (err) {
    const current = await ops.readFile(docName);
    writeFileSync(filePath, current, "utf8");
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  }
}

async function runPreBash(ops: SyncFileOps, workspaceRoot: string, baseDir: string, command: string, identity: SnapshotIdentity): Promise<void> {
  for (const docName of extractCandidatePaths(workspaceRoot, baseDir, command)) {
    await runPre(ops, docName, join(workspaceRoot, docName), identity);
  }
}

async function runPostBash(ops: SyncFileOps, workspaceRoot: string, baseDir: string, command: string, identity: SnapshotIdentity): Promise<void> {
  for (const docName of extractCandidatePaths(workspaceRoot, baseDir, command)) {
    const filePath = join(workspaceRoot, docName);
    if (!existsSync(filePath)) continue; // deleted or never created by the command — nothing to push
    await runPost(ops, docName, filePath, identity);
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
    const command = input.tool_input?.command;
    if (typeof command !== "string") return;
    const ops = makeOps(input.session_id ?? workspaceRoot, workspaceRoot);
    try {
      if (mode === "pre") {
        await runPreBash(ops, workspaceRoot, baseDir, command, identity);
      } else if (mode === "post") {
        await runPostBash(ops, workspaceRoot, baseDir, command, identity);
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

  const ops = makeOps(input.session_id ?? workspaceRoot, workspaceRoot);
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
