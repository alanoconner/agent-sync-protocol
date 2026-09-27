# agent-sync-protocol

A CRDT-based synchronization layer that lets multiple coding agents edit the same repository concurrently without lost writes, plus presence awareness ("who's editing what"). Built in phases against [agent-sync-dev-spec.md](agent-sync-dev-spec.md), which is the source of truth for design decisions — this file is just setup/usage. See [CLAUDE.md](CLAUDE.md) for architecture detail and [CHANGELOG.md](CHANGELOG.md) for what's been built so far.

## Requirements

- Node.js 20+ and npm
- `git` on `PATH` (only needed if you use disk-flush + auto-commit)
- macFUSE (macOS) / libfuse (Linux) / WinFsp (Windows) — only if you use the FUSE mount (Section 3.3a); not needed for the server, CLI, MCP proxy, or the Claude Code hook bridge

## Install

```bash
npm install
```

## Quick start — see two clients converge

This proves the core sync loop with no real agent involved: one server, two terminals editing the same "file."

```bash
npm run server
```

In two other terminals:

```bash
npm run demo -- shared.txt alice
npm run demo -- shared.txt bob
```

Type a line and press Enter in either terminal — it appears in both. `npm run demo -- <docName> [agentId] [serverUrl]` connects a `SyncClient`, sets presence, and prints the merged content on every change.

## Running the server

**Config-driven (recommended — Phase 7):**

```bash
npm run cli -- init             # writes .agent-sync.yml with sane defaults
npm run cli -- server --repo-root .
```

**Env-var-driven (no config file, kept for backward compatibility):**

```bash
npm run server                                                    # ws://localhost:4600, no persistence
PORT=5000 npm run server                                          # different port
AGENT_SYNC_REPO_ROOT=/path/to/repo npm run server                 # also flush to disk + git-commit every debounce interval
AGENT_SYNC_FLUSH_DEBOUNCE_MS=1000 AGENT_SYNC_REPO_ROOT=/path/to/repo npm run server   # override the 3000ms default
AGENT_SYNC_VALIDATE_COMMAND="npm test" AGENT_SYNC_REPO_ROOT=/path/to/repo npm run server   # gate each commit on a command
AGENT_SYNC_VALIDATE_ON_FAIL=warn_only ...                         # commit anyway on a failing gate, instead of reverting (reject_merge default)
```

With `AGENT_SYNC_REPO_ROOT` (or `--repo-root`), a room is also seeded from the working tree the first time it's created, so an existing file's first sync starts from its real content. With no repo root, the server holds everything in memory only and every room starts empty — good for trying things out, but nothing survives a restart.

## `.agent-sync.yml`

Written by `agent-sync init`. Every field has a default except `validation`, which is left commented out — it's a shell command that would actually run against your repo on every flush, so it needs an explicit opt-in:

```yaml
server: ws://localhost:4600

paths:
  exclusive: []              # files routed through the lock service instead of pure CRDT merge
  ignore:
    - "node_modules/**"
    - "dist/**"

line_endings: lf

flush:
  debounce_ms: 3000

# validation:
#   command: "npm run lint && npm run typecheck && npm test"
#   on_fail: reject_merge   # reject_merge | warn_only

symbol_index:
  enabled: false   # not implemented yet (Phase 8)
  language: typescript
  enforcement: advisory
```

## CLI reference

```
agent-sync init                       # write .agent-sync.yml (--force to overwrite)
agent-sync server                     # start the server from .agent-sync.yml
  --config <path>                     #   config file to read (default ./.agent-sync.yml)
  --repo-root <path>                  #   directory to flush to (default: current directory)
agent-sync dashboard                  # live "who's editing what" view, polling GET /status
  --server <ws-url>                   #   server to watch (default: from config, else ws://localhost:4600)
  --interval <ms>                     #   poll interval (default 1000)
```

During development, run any of these straight from source with `npm run cli -- <command> [options]` instead of installing the package.

## Connecting a real agent

Three interception mechanisms exist today, per spec Section 3 — pick based on how your agent reaches files:

| Agent shape | Mechanism | Where |
|---|---|---|
| Exposes file ops as MCP tools | Generic MCP proxy | `src/mcp/` — see `examples/agent-sync-mcp-map.example.yml` |
| Claude Code CLI | Hook bridge | `examples/claudeCodeHook.ts` + `examples/claudeCodeHookSettings.example.json` |
| Codex CLI/app | Hook bridge | `examples/codexHook.ts` + `examples/codexHookSettings.example.json` |
| CLI agent with no hook API and no rebindable registry | FUSE/WinFsp mount | `src/fuse/` (single-file merge only — no `readdir`/`mkdir`/`rename` yet, needs macFUSE installed) |

### Testing with real Claude Code agents (hook bridge)

This is the path that's actually been live-tested end-to-end with real Claude Code CLI agents:

1. Give each agent its own working directory sharing one git history:
   ```bash
   git worktree add ../agent-a-worktree
   git worktree add ../agent-b-worktree
   ```
2. Start the sync server pointed at the canonical checkout (this is what accumulates git commits):
   ```bash
   AGENT_SYNC_REPO_ROOT=/path/to/canonical/checkout npm run server
   ```
3. In each worktree, create `.claude/settings.json` from [examples/claudeCodeHookSettings.example.json](examples/claudeCodeHookSettings.example.json), filling in the absolute paths to this repo's `node_modules/.bin/tsx` and `examples/claudeCodeHook.ts`.
4. Run `claude` normally in each worktree — it keeps calling `Read`/`Edit`/`Write`/`Bash` exactly as usual; the hooks pull fresh shared content before each call and push the result after.
5. Watch it: `npm run cli -- dashboard` shows which files have active rooms. A room's `peers` list will usually show `(nobody)` — each hook invocation is a short-lived process, not a persistent connection, so presence is necessarily spotty. That's expected, not a bug; it doesn't mean the sync isn't working.

The hook reads the worktree's own `.agent-sync.yml` for `server` and `paths.exclusive` (hot files routed through the lock service instead of CRDT merge alone). `AGENT_SYNC_SERVER` and `AGENT_SYNC_EXCLUSIVE_PATHS` (comma-separated relative paths), set as env vars in the hook command, override those two fields if you'd rather not keep a config file in the worktree.

Edit/Write/Bash hook payloads must include matching `session_id` and `tool_use_id` values in the pre/post pair. Snapshots are isolated by workspace, session, tool call, and file path. Read hooks refresh disk without creating a snapshot. A missing snapshot is reported as a hook warning instead of being treated as an empty file.

Each flush commits only its target path, leaving unrelated staged changes staged. If validation rejects a flush, the service restores the exact pre-flush disk contents (including uncommitted changes), or removes the file only if it was absent before the flush. Failed Git operations leave the content eligible for retry through `flushPath()` or `flushAll()`.

**The server must be started with a repo root** (step 2 above, or `agent-sync server --repo-root`). That's what hydrates a brand-new room from the working tree the first time any agent touches an existing file; against a server with no repo root, every room starts empty and the hook would overwrite an existing local file with that emptiness.

**Known limitations of this bridge** (see [CLAUDE.md](CLAUDE.md) for detail):
- A rejected `Edit`/`Write` (concurrent edit, lock held, failed validation) reverts the local file and surfaces the error to the agent — expected behavior, not a failure.
- A `Bash` call is covered by diffing the workspace before and after it (git-tracked plus untracked-but-not-ignored files, minus `paths.ignore`), so it works however the command changes a file — `sed`, a script, a formatter. What it cannot see: file deletions, binary or >1 MB files, and changes made by a process that keeps running after the command returns. Full coverage of those needs the FUSE mount instead.
- A room is hydrated from the server's repo root once, when it's first created. A file changed on disk behind the server's back after that (a manual `git pull` in the canonical checkout, say) is not picked up until the server restarts — the room is the source of truth once it exists.

### Testing with Codex agents

The Codex adapter uses the same worktree and server layout as the Claude Code bridge above, but observes Codex's canonical `apply_patch` and `Bash` hook events:

1. In the canonical (main) checkout, copy [examples/codexHookSettings.example.json](examples/codexHookSettings.example.json) to `.codex/hooks.json` and replace the two absolute paths. Codex resolves project hooks for linked Git worktrees from this main worktree, so a copy that exists only inside a linked worktree is not loaded.
2. Start the server with the canonical checkout as its repo root.
3. Start Codex in each linked worktree, open `/hooks`, and trust the canonical project hook definition.
4. Use Codex normally. Before each `apply_patch` or shell call, the hook pulls active rooms and snapshots that agent's worktree; afterward it pushes changed and new text files through exact-match-or-reject synchronization.

The adapter reads `.agent-sync.yml` and honors the same `AGENT_SYNC_SERVER` and `AGENT_SYNC_EXCLUSIVE_PATHS` overrides as the Claude bridge. Codex `apply_patch` deletions are blocked before execution because the current protocol has no file tombstone/delete operation. Shell-command deletions, binary files or files over 1 MB, changes from processes that outlive the command, and calls on specialized tool paths that bypass Codex hooks are not synchronized. Hook configuration under `.codex/` is always excluded from workspace scanning.

## Testing this project itself

```bash
npm test                                            # run the full suite once
npx vitest                                          # watch mode
npx vitest run test/convergence.test.ts             # a single test file
npx vitest run -t "converges to the same state"     # a single test by name
npm run build                                       # type-check + emit to dist/
npx tsc --noEmit -p .                               # type-check only
```

See CLAUDE.md's Tests section for what each `test/*.test.ts` file covers.

## Project status

Phases 1–7 of the spec's build order are implemented and tested; Phase 8 (symbol index) and Phase 9 (cross-platform packaging) haven't been started. See [CHANGELOG.md](CHANGELOG.md) for a phase-by-phase history of what's been built, and [agent-sync-dev-spec.md](agent-sync-dev-spec.md) Section 10 for the full phase list.
