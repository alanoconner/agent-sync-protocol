import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const ROOT_MARKERS = [".agent-sync.yml", ".claude", ".git"];

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

export function toDocName(workspaceRoot: string, filePath: string): string | null {
  const rel = relative(workspaceRoot, filePath);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}
