import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const ROOT_MARKERS = [".agent-sync.yml", ".claude", ".git"];

/**
 * The directory doc names are relative to. Claude Code's hook `cwd` is the *current* directory of the
 * agent's shell, not the project root — after `cd client/src` it's `client/src`, which would name the
 * same file `components/Foo.jsx` instead of `client/src/components/Foo.jsx` (a second, empty room, whose
 * Pre hook then overwrites the real local file). So prefer CLAUDE_PROJECT_DIR, else walk up from `cwd`
 * to the nearest dir with a project marker (`.git` is a file in a worktree, hence existsSync).
 */
export function findWorkspaceRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR;
  let dir = resolve(cwd);
  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/** `null` for a path outside the workspace (e.g. a system file) — those are left alone entirely, not synced. */
export function toDocName(workspaceRoot: string, filePath: string): string | null {
  const rel = relative(workspaceRoot, filePath);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}
