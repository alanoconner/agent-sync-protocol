import { existsSync, lstatSync } from "node:fs";
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
 * Relative tokens resolve against `baseDir` (the shell's cwd, which is where
 * the command's relative paths actually point), not the workspace root — an agent
 * in `client/src/components` saying `sed -i ... TableNode.jsx` means
 * `client/src/components/TableNode.jsx`; a leading `cd sub &&` is followed. The real fix for full coverage is FUSE/kernel-level interception, which
 * sees the actual syscalls regardless of what process issued them.
 */
export function extractCandidatePaths(workspaceRoot: string, baseDir: string, command: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const candidates = new Set<string>();
  let dir = baseDir;
  let afterCd = false;
  for (const raw of tokens) {
    // `p='a/b.js'`, `open("a/b.js")`, `--file=a/b.js` — the path is glued to code punctuation, so split on it
    // (whitespace stays intact, so a quoted path with spaces survives as one piece).
    for (const token of raw.split(/["'=(),;<>|&[\]{}]+/)) {
      if (!token) continue;
      if (afterCd) {
        // `cd sub && sed ... f.js`: later relative tokens are relative to `sub`.
        afterCd = false;
        const target = isAbsolute(token) ? token : resolve(dir, token);
        try {
          if (lstatSync(target).isDirectory()) dir = target;
        } catch {
          // not a directory — ignore
        }
        continue;
      }
      if (token === "cd") {
        afterCd = true;
        continue;
      }
      if (token.startsWith("-")) continue;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) continue; // URL
      if (/[*?$`]/.test(token)) continue; // glob, variable, command substitution — can't resolve statically
      const abs = isAbsolute(token) ? token : resolve(dir, token);
      let isFile: boolean;
      try {
        isFile = lstatSync(abs).isFile();
      } catch {
        // doesn't exist yet — plausible new file if it has a name + extension (not `.read` from `f.read()`) and lands in a real directory
        isFile = /[^./]\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(token) && existsSync(dirname(abs));
      }
      if (!isFile) continue;
      const docName = toDocName(workspaceRoot, abs);
      if (docName !== null) candidates.add(docName);
    }
  }
  return [...candidates];
}
