import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { statusUrlFor } from "../src/cli/dashboardView.js";

/** Files above this are never synced by the Bash scan — a build artifact or asset, not something agents merge-edit. */
export const MAX_SCANNED_FILE_BYTES = 1024 * 1024;

const IGNORED_PREFIXES = [".git/", ".claude/"];

/** Files git knows about or would add (tracked + untracked, honoring .gitignore) — so node_modules/dist are never walked. Empty outside a git repo. */
export function listWorkspaceFiles(workspaceRoot: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: workspaceRoot,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8");
    return out.split("\0").filter((file) => file && !IGNORED_PREFIXES.some((prefix) => file.startsWith(prefix)));
  } catch {
    return [];
  }
}

/** `mtime:size` per file — a cheap "did anything touch this?" fingerprint; content is only read for files that differ. */
export function statFingerprints(workspaceRoot: string, files: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const file of files) {
    try {
      const stat = lstatSync(join(workspaceRoot, file));
      if (stat.isFile() && stat.size <= MAX_SCANNED_FILE_BYTES) result[file] = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // vanished between listing and stat — not a candidate
    }
  }
  return result;
}

/** Files created or modified between two fingerprint maps. Deletions are not reported (nothing to push). */
export function changedFiles(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after).filter((file) => before[file] !== after[file]);
}

/** A doc name from an untrusted source (the server's room list) is only usable if it stays inside the workspace. */
export function isSafeDocName(docName: string): boolean {
  return docName !== "" && !isAbsolute(docName) && !docName.split("/").includes("..");
}

/** Doc names of every room the server currently has — i.e. every file some agent has touched. Empty if the server is unreachable. */
export async function fetchActiveDocNames(serverUrl: string): Promise<string[]> {
  try {
    const response = await fetch(statusUrlFor(serverUrl), { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return [];
    const status = (await response.json()) as { rooms?: { docName: string }[] };
    return (status.rooms ?? []).map((room) => room.docName).filter(isSafeDocName);
  } catch {
    return [];
  }
}
