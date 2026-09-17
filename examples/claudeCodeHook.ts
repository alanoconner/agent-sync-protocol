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
// Env vars: AGENT_SYNC_SERVER (default ws://localhost:4600),
// AGENT_SYNC_EXCLUSIVE_PATHS (optional comma-separated relative paths that
// go through the lock service instead of pure CRDT merge, Phase 6).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { SyncFileOps } from "../src/sync/syncFileOps.js";

interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string };
}

const SNAPSHOT_DIR = join(tmpdir(), "agent-sync-hook-snapshots");

function snapshotPath(docName: string): string {
  return join(SNAPSHOT_DIR, `${createHash("sha256").update(docName).digest("hex")}.snapshot`);
}

function stashSnapshot(docName: string, content: string): void {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(snapshotPath(docName), content, "utf8");
}

/** Consumed once, like the server's own validation-rejection notice — if Pre never ran for this call, "" is the safest fallback: writeFileFromSnapshot treats an empty oldStr as "only apply blind if nothing changed concurrently," so a stale/missing snapshot rejects rather than silently misapplying. */
function takeSnapshot(docName: string): string {
  const path = snapshotPath(docName);
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8");
  unlinkSync(path);
  return content;
}

/** `null` for a path outside the workspace (e.g. a system file) — those are left alone entirely, not synced. */
function toDocName(workspaceRoot: string, filePath: string): string | null {
  const rel = relative(workspaceRoot, filePath);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function makeOps(ownerId: string): SyncFileOps {
  const serverUrl = process.env.AGENT_SYNC_SERVER ?? "ws://localhost:4600";
  const exclusivePaths = (process.env.AGENT_SYNC_EXCLUSIVE_PATHS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return new SyncFileOps({ serverUrl, exclusivePaths, ownerId });
}

async function runPre(ops: SyncFileOps, docName: string, filePath: string): Promise<void> {
  const remoteContent = await ops.readFile(docName);

  // A brand-new CRDT room always starts empty — there's no disk→doc
  // hydration in this codebase yet (Phase 4's DiskFlushService only flushes
  // the other direction). Without this check, the first agent to touch an
  // already-existing file would pull that empty room and overwrite real
  // local content with nothing. Heuristic, not a real fix: if the room is
  // empty but local disk already has content, assume this is that first
  // touch and seed the shared doc from disk instead of wiping it. This can't
  // distinguish "never synced yet" from "someone legitimately emptied the
  // file" — acceptable for this example bridge, not something to rely on
  // for an actual disk-hydration guarantee.
  const localContent = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
  if (remoteContent === "" && localContent) {
    await ops.writeFileFull(docName, localContent);
    const seeded = await ops.readFile(docName);
    writeFileSync(filePath, seeded, "utf8");
    stashSnapshot(docName, seeded);
    return;
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, remoteContent, "utf8");
  stashSnapshot(docName, remoteContent);
}

async function runPost(ops: SyncFileOps, docName: string, filePath: string): Promise<void> {
  const oldSnapshot = takeSnapshot(docName);
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

/**
 * Best-effort file-path extraction for a `Bash` tool call — not a real shell
 * parser. `Read`/`Edit`/`Write` name their target file directly; `Bash` only
 * gives a free-text command string, so anything it touches (`sed -i`, a
 * Python script that opens a path, `cp a b`) would otherwise bypass this
 * bridge entirely — confirmed live: an agent blocked twice by a genuine
 * RangeMismatchError fell back to editing via a Python script through Bash,
 * and that write never reached the CRDT doc at all. This narrows the gap for
 * the common cases (a literal, already-existing or extension-bearing path
 * token in the command) without pretending to close it — it cannot see a
 * path built from a variable, a glob, command substitution, or a heredoc.
 * The real fix for full coverage is FUSE/kernel-level interception, which
 * sees the actual syscalls regardless of what process issued them.
 */
function extractCandidatePaths(workspaceRoot: string, command: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const candidates = new Set<string>();
  for (const raw of tokens) {
    const token = raw.replace(/^["']|["']$/g, "");
    if (!token || token.startsWith("-")) continue;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) continue; // URL
    if (/[*?$`]/.test(token)) continue; // glob, variable, command substitution — can't resolve statically
    const abs = isAbsolute(token) ? token : join(workspaceRoot, token);
    let isFile: boolean;
    try {
      isFile = lstatSync(abs).isFile();
    } catch {
      isFile = /\.[a-zA-Z0-9]{1,10}$/.test(token); // doesn't exist yet — plausible new file if it looks like one
    }
    if (!isFile) continue;
    const docName = toDocName(workspaceRoot, abs);
    if (docName !== null) candidates.add(docName);
  }
  return [...candidates];
}

async function runPreBash(ops: SyncFileOps, workspaceRoot: string, command: string): Promise<void> {
  for (const docName of extractCandidatePaths(workspaceRoot, command)) {
    await runPre(ops, docName, join(workspaceRoot, docName));
  }
}

async function runPostBash(ops: SyncFileOps, workspaceRoot: string, command: string): Promise<void> {
  for (const docName of extractCandidatePaths(workspaceRoot, command)) {
    const filePath = join(workspaceRoot, docName);
    if (!existsSync(filePath)) continue; // deleted or never created by the command — nothing to push
    await runPost(ops, docName, filePath);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const raw = readFileSync(0, "utf8");
  const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
  const workspaceRoot = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();

  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command;
    if (typeof command !== "string") return;
    const ops = makeOps(input.session_id ?? workspaceRoot);
    try {
      if (mode === "pre") {
        await runPreBash(ops, workspaceRoot, command);
      } else if (mode === "post") {
        await runPostBash(ops, workspaceRoot, command);
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

  const ops = makeOps(input.session_id ?? workspaceRoot);
  try {
    if (mode === "pre") {
      await runPre(ops, docName, filePath);
    } else if (mode === "post" && input.tool_name !== "Read") {
      await runPost(ops, docName, filePath);
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
