# agent-sync-protocol

A CRDT-based synchronization layer that lets multiple coding agents edit the same repository concurrently without lost writes, plus presence awareness ("who's editing what"). Built in phases against [agent-sync-dev-spec.md](agent-sync-dev-spec.md), which is the source of truth for design decisions — this file is just setup/usage. See [CLAUDE.md](CLAUDE.md) for architecture detail and [CHANGELOG.md](CHANGELOG.md) for what's been built so far.

## Requirements

- Node.js 20.12+ and npm for source development or the private npm package; private standalone builds embed Node.js
- `git` on `PATH` (Git for Windows on native Windows; required by the managed `asl codex` / `asl claude` workflow and by disk flush)
- Codex CLI or Claude Code on `PATH`, depending on which agent you launch
- macFUSE (macOS) / libfuse (Linux) — only if you explicitly install and use the optional FUSE adapter; it is not used by the hook workflow and has no native WinFsp implementation

## Install

`agent-sync-layer` is currently a private package and is not published to npm. Repository collaborators can build and install a verified tarball locally:

```bash
npm ci
npm run pack:private
npm install -g ./artifacts/npm/agent-sync-layer-0.1.0.tgz
```

The packaging scripts can produce standalone archives for Linux x64, Windows x64, macOS x64, and macOS ARM64 when run on each target. Those builds expose `asl` without requiring Node.js on the destination machine. See [private packaging and installation](docs/private-packaging.md) for local builds, checksum verification, signing limitations, and the temporarily deferred CI workflow.

For development in this checkout, `npm run build && npm link` exposes both `asl` and `agent-sync`. `fuse-native` is optional, so a missing native FUSE runtime does not prevent installation or hook-based use; FUSE is not included in standalone builds.

## Quick start — real coding agents

From a clean Git checkout of the project you want the agents to edit:

```bash
asl codex
# or
asl claude
```

Run the command again in another terminal to add another agent to the same session. ASL automatically creates one integration worktree and a separate worktree/branch per agent, starts a loopback-only Yjs daemon, injects the compiled pre/post hooks, sets the required environment, detects the package-manager install command, and launches the requested CLI in its worktree. The original checkout and branch are not modified.

### Native Windows

The managed hook workflow supports launching `asl` from PowerShell, cmd, or Git Bash. Install Git for Windows and the chosen agent CLI, then install either the private npm tarball (which also needs Node.js 20.12+) or the Windows x64 standalone artifact. Codex receives a native `command_windows` hook command automatically. Claude Code uses Git Bash internally; ASL discovers the standard Git for Windows installation or honors `CLAUDE_CODE_GIT_BASH_PATH` when Git is installed elsewhere.

WSL remains supported as a Linux environment, but is not required for the native hook workflow. The experimental FUSE adapter is unrelated to this support and does not implement WinFsp.

On first use, ASL shows any repository-defined setup or validation command before running it. Codex also asks you to trust the stable hook definition: open `/hooks` when prompted by ASL. This trust step is intentionally left to Codex.

```bash
asl status       # inspect the session, daemon, worktrees, and agents
asl finish       # flush, validate, and stage an uncommitted merge on the original branch
asl clean        # remove safe agent worktrees/branches; retain the integration branch
asl reset        # stop agents and discard the entire managed session
```

`asl finish` keeps granular flush commits for recovery while agents work, then compacts them into one integration commit and prepares a real `--no-ff --no-commit` merge in the original checkout. Review the staged result, then either commit it or run `git merge --abort`. It refuses to proceed if that checkout is dirty, is no longer on the session's original branch and commit, or has another Git operation in progress. Use `asl stop` instead when you want to flush and pause while retaining all managed worktrees.

`asl reset` is the destructive start-over command. It terminates the agent processes recorded in the current repository's ASL session, stops the daemon, force-removes all session-owned agent and integration worktrees (including partial allocations left by interrupted initialization), deletes their `asl/...` branches, and removes the repository's state and trust record under `~/.asl`. Stale locks left by an interrupted ASL process are reclaimed automatically. Unmatched and unflushed work in those managed worktrees is intentionally discarded. If `asl finish` left its ASL integration merge pending, reset aborts that merge too; it refuses to touch an unrelated merge. Files and commits already accepted in the original project branch are not removed.

## Core demo — see two clients converge

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

With `AGENT_SYNC_REPO_ROOT` (or `--repo-root`), full Yjs room state is durably snapshotted before a write reports success, independently of the later validation/Git flush. A restart therefore restores acknowledged but unflushed text, tombstones, and validation notices without rebuilding a different CRDT history from disk. Standalone state lives under the repository's Git common directory; managed state lives under `~/.asl`. With no repo root, the server remains memory-only and every room starts empty.

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

worktrees:
  auto_install: true          # infer npm/pnpm/yarn/bun install from lockfiles
  # setup_command: "npm ci"  # explicit override; shown for trust before execution

# validation:
#   command: "npm run lint && npm run typecheck && npm test"
#   on_fail: reject_merge   # reject_merge | warn_only

symbol_index:
  enabled: false   # not implemented yet (Phase 8)
  language: typescript
  enforcement: advisory
```

## CLI reference

The complete command, lifecycle, configuration, state-layout, and safety reference is in [docs/asl-cli.md](docs/asl-cli.md). The public commands are summarized here:

```
asl codex [options] [-- agent args]   # launch Codex in a managed synchronized worktree
asl claude [options] [-- agent args]  # launch Claude Code the same way
  --name <name>                       #   stable agent/worktree name within this session
  --skip-setup                        #   skip package-manager/setup command
  --bin <path>                        #   override the agent executable
  --yes                               #   accept displayed first-use repo commands noninteractively
asl status [--json]                   # inspect the current repository session
asl stop                              # flush, stop the daemon, retain worktrees
asl finish                            # flush, validate, stop, and prepare an uncommitted merge
asl clean                             # remove safe worktrees; retain the integration branch
asl reset                             # stop agents and discard all managed session artifacts
asl recover <path> --use-crdt         # resolve restart drift in favor of durable CRDT state
asl recover <path> --use-disk         # explicitly discard that room's pending CRDT state
asl init                              # write .agent-sync.yml (--force to overwrite)
asl server                            # start the server from .agent-sync.yml
  --config <path>                     #   config file to read (default ./.agent-sync.yml)
  --repo-root <path>                  #   directory to flush to (default: current directory)
asl dashboard                         # live "who's editing what" view, polling GET /status
  --server <ws-url>                   #   server to watch (default: active session, then config)
  --interval <ms>                     #   poll interval (default 1000)
```

`agent-sync` remains an alias for `asl`. Managed session state lives outside the target repository under `~/.asl` (override with `ASL_STATE_DIR` for testing). ASL refuses to start from a dirty checkout, detached HEAD, or missing Git identity. `clean` refuses to remove an agent worktree if it contains changes that are not present in the integration worktree; `reset` is the explicit destructive alternative when those changes should be discarded.

During development, run any of these straight from source with `npm run cli -- <command> [options]` instead of installing the package.

### What the managed launcher added

- Repository-scoped sessions with one integration worktree and one isolated worktree per agent.
- A detached loopback-only Yjs daemon with authenticated lifecycle control and durable, pre-acknowledgment room recovery.
- Compiled Codex and Claude Code hooks, injected automatically without copying hook files or exporting variables.
- Lockfile-based dependency setup plus explicit trust for repository-defined setup and validation commands.
- Safe pause, compacted integration history, uncommitted final merge, and cleanup commands that preserve the integration branch and refuse known data-loss cases.

## Connecting a real agent

Three interception mechanisms exist today, per spec Section 3 — pick based on how your agent reaches files:

| Agent shape | Mechanism | Where |
|---|---|---|
| Exposes file ops as MCP tools | Generic MCP proxy | `src/mcp/` — see `examples/agent-sync-mcp-map.example.yml` |
| Claude Code CLI | Managed hook bridge | `asl claude` (`src/hooks/`) |
| Codex CLI/app | Managed hook bridge | `asl codex` (`src/hooks/`) |
| CLI agent with no hook API and no rebindable registry | Optional FUSE mount | `src/fuse/` (macOS/Linux prototype only; no `readdir`/`mkdir`/`rename`, no WinFsp adapter) |

### Manual Claude Code hook setup (advanced)

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

Edit/Write/Bash hook payloads must include matching `session_id` and `tool_use_id` values in the pre/post pair. Snapshots are isolated by workspace, session, tool call, and file path. Read hooks refresh disk without creating a snapshot. A missing snapshot is a blocking hook failure instead of being treated as an empty file.

Each flush commits only its target path, leaving unrelated staged changes staged. If validation rejects a flush, the service restores the exact pre-flush disk contents (including uncommitted changes), or removes the file only if it was absent before the flush. Failed Git operations leave the content eligible for retry through `flushPath()` or `flushAll()`.

**The server must be started with a repo root** (step 2 above, or `agent-sync server --repo-root`). That's what hydrates a brand-new room from the working tree the first time any agent touches an existing file; against a server with no repo root, every room starts empty and the hook would overwrite an existing local file with that emptiness.

**Known limitations of this bridge** (see [CLAUDE.md](CLAUDE.md) for detail):
- A rejected `Edit`/`Write` (concurrent edit, lock held, failed validation) reverts the local file and surfaces the error to the agent — expected behavior, not a failure.
- A `Bash` call is covered by diffing the workspace before and after it (git-tracked plus untracked-but-not-ignored files, minus `paths.ignore`), so it works however the command changes a text file — `sed`, a script, a formatter, or deletion. Binary or >1 MB files and changes made by a process that keeps running after the command returns remain outside hook coverage.
- A room is hydrated from the server's repo root once, when it's first created. A file changed on disk behind the server's back after that (a manual `git pull` in the canonical checkout, say) is not picked up until the server restarts — the room is the source of truth once it exists.

### Manual Codex hook setup (advanced)

The Codex adapter uses the same worktree and server layout as the Claude Code bridge above. Its wildcard `PreToolUse` hook refreshes active shared rooms before every supported local tool, while `apply_patch` and `Bash` additionally use post-tool workspace diffing to publish writes:

1. In the canonical (main) checkout, copy [examples/codexHookSettings.example.json](examples/codexHookSettings.example.json) to `.codex/hooks.json` and replace the two absolute paths. Codex resolves project hooks for linked Git worktrees from this main worktree, so a copy that exists only inside a linked worktree is not loaded.
2. Start the server with the canonical checkout as its repo root.
3. Start Codex in each linked worktree, open `/hooks`, and trust the canonical project hook definition.
4. Use Codex normally. Before each supported local tool call, the hook pulls active rooms so shell, MCP, and other local reads see current shared files. Before `apply_patch` or a shell call it also snapshots the worktree; afterward it pushes changed, new, and deleted text files through exact-match-or-reject synchronization.

The adapter reads `.agent-sync.yml` and honors the same `AGENT_SYNC_SERVER` and `AGENT_SYNC_EXCLUSIVE_PATHS` overrides as the Claude bridge. Codex `apply_patch` and shell-command deletions create synchronized tombstones: stale deletions reject and restore current content, while a writer that has observed the tombstone may recreate the path. A status lookup or sync failure blocks the tool with actionable stderr instead of silently proceeding against stale disk. Binary files, files over 1 MB, changes from processes that outlive the command, and calls on specialized tool paths that bypass Codex hooks are not synchronized. Hook configuration under `.codex/` is always excluded from workspace scanning.

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

Phases 1–7 of the spec's build order are implemented and tested. Phase 8 (symbol index) has not started. Phase 9 now has the managed launcher, native Windows hook support, a private installable npm/SDK tarball, and native standalone builds for Linux x64, Windows x64, macOS x64, and macOS ARM64. The GitHub Actions workflow is temporarily deferred because the repository token cannot update workflow files. Public package publication, permanent releases, trusted code signing, and platform package-manager manifests are intentionally deferred. See [CHANGELOG.md](CHANGELOG.md) for a phase-by-phase history and [agent-sync-dev-spec.md](agent-sync-dev-spec.md) Section 10 for the full phase list.
