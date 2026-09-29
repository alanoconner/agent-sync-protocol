import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const ROOT_MARKERS = [".agent-sync.yml", ".claude", ".git"];

export function findWorkspaceRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_PROJECT_DIR) return canonicalPath(env.CLAUDE_PROJECT_DIR);
  let dir = resolve(cwd);
  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return canonicalPath(dir);
    const parent = dirname(dir);
    if (parent === dir) return canonicalPath(cwd);
    dir = parent;
  }
}

function canonicalPath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    missing.push(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing.reverse());
}

export function toDocName(workspaceRoot: string, filePath: string): string | null {
  const rel = relative(canonicalPath(workspaceRoot), canonicalPath(filePath));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}
