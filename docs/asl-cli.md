# ASL managed-agent CLI

`asl` is the one-command interface for running Codex or Claude Code on top of agent-sync. It combines Git worktree isolation with the Yjs synchronization layer: worktrees give each process a safe filesystem, while hooks publish accepted text changes into shared CRDT rooms and the session daemon flushes those rooms into the integration branch.

`agent-sync` is an alias for `asl`. There are no global flags. Run `asl` with no arguments to print the built-in command summary.

## Installation from this repository

```bash
cd /path/to/agent-sync-protocol
npm install
npm run build
npm link
```

This exposes both `asl` and `agent-sync`. Published packages, standalone binaries, and platform installers are not implemented yet.

## Command index

| Command | Purpose |
|---|---|
| `asl codex [options] [-- codex-args]` | Start Codex in a new managed worktree. |
| `asl claude [options] [-- claude-args]` | Start Claude Code in a new managed worktree. |
| `asl status [--json]` | Show the current repository session. |
| `asl stop` | Flush and pause a session while retaining its worktrees. |
| `asl finish` | Flush, validate, stop, and print safe Git handoff commands. |
| `asl clean` | Remove safe managed worktrees and agent branches. |
| `asl init [--force]` | Write the default `.agent-sync.yml`. |
| `asl server [options]` | Run a standalone config-driven sync server. |
| `asl dashboard [options]` | Watch rooms, connected peers, and locks. |

## `asl codex` and `asl claude`

```text
asl codex [--name <name>] [--skip-setup] [--bin <path>] [--yes] [-- codex-args]
asl claude [--name <name>] [--skip-setup] [--bin <path>] [--yes] [-- claude-args]
```

Both commands require a clean, non-bare Git working tree on a branch, plus a configured Git author name and email. A launch performs these operations:

1. Locates the repository by its Git common directory and creates repository-scoped state under `~/.asl`.
2. Displays any configured setup and validation shell commands and asks for trust if their effective configuration has not been trusted before.
3. Creates or reuses one `asl/<session>/integration` branch and integration worktree.
4. Runs dependency setup in new worktrees unless disabled.
5. Starts or reuses a detached, loopback-only Yjs synchronization and flush daemon.
6. Creates a new `asl/<session>/<agent>` branch and agent worktree from the session's base commit.
7. Injects the compiled hooks and `AGENT_SYNC_SERVER`, then starts the selected agent in its new worktree.

The source checkout's files and checked-out branch are not changed. Git refs are added for the managed branches.

### Agent options

| Option | Behavior |
|---|---|
| `--name <name>` | Sets the session-unique agent/worktree name. Names are lowercased and unsafe characters become `-`. Defaults to `codex-001`, `claude-002`, and so on. |
| `--skip-setup` | Skips automatic or configured dependency setup for newly created integration and agent worktrees. A skipped setup command is not included in the trust prompt. |
| `--bin <path>` | Replaces the default `codex` or `claude` executable. Useful for wrappers and testing. |
| `--yes` | Noninteractively trusts the displayed repository setup and validation commands. It does not bypass Codex's own hook trust. |
| `--` | Ends ASL option parsing. Every later argument is forwarded to the coding-agent CLI. |

Examples:

```bash
asl codex
asl codex --name frontend
asl claude --name api --skip-setup
asl codex -- --model gpt-5
asl claude -- --model opus
asl codex --bin /opt/tools/codex -- --full-auto
```

Arguments for the underlying agent must follow `--`. ASL owns the working directory and injected hooks, so it rejects forwarded Codex `-C`/`--cd`/`--worktree` settings, Codex `hooks.*` configuration overrides, and Claude `--settings`.

### Hook coverage

- Codex: `apply_patch` and `Bash` pre/post events use a workspace snapshot and diff.
- Claude Code: `Read`, `Edit`, and `Write` use direct file snapshots; `Bash` uses the workspace snapshot and diff.
- Before a covered operation, hooks pull existing shared rooms into that agent's worktree.
- After a write, hooks publish changed or new text files with exact-match-or-reject semantics. A stale overlapping edit is rejected and the local file is restored to current shared truth.
- The daemon's repository root is the integration worktree. It hydrates new rooms from that worktree and commits successfully flushed documents there.

Codex hook trust remains an explicit Codex decision. On the first launch, open `/hooks` and trust the ASL hook definition before asking Codex to edit files.

## `asl status`

```text
asl status
asl status --json
```

Shows the session ID and state, base branch and commit, integration branch, daemon endpoint/state, and every managed agent's kind, state, and worktree. `--json` emits the complete session record, including paths, process IDs when present, timestamps, and daemon URLs.

Status values are:

- `active`: the session can launch agents and normally has a daemon.
- `paused`: `asl stop` completed; launching another agent resumes it.
- `finished`: final flush and validation completed; run `asl clean` before starting a new session.

## `asl stop`

```text
asl stop
```

Flushes all CRDT rooms, stops the daemon, and marks the session paused. Integration and agent worktrees remain available. It refuses to stop while an ASL-launched agent process is still running, and it does not discard a validation-rejected or failed flush.

Launching `asl codex` or `asl claude` again resumes a paused session, restarts the daemon, and creates another agent worktree.

## `asl finish`

```text
asl finish
```

Performs the final handoff without changing the original checkout:

1. Refuses to continue while an ASL-launched agent is still running.
2. Starts the daemon if necessary and flushes every CRDT room.
3. Runs the configured final validation command, if any.
4. Requires the integration worktree to be clean after its flush commits.
5. Stops the daemon and marks the session finished.
6. Prints `git merge --ff-only`, regular `git merge`, and `git cherry-pick` alternatives.

Review and run one of the printed Git commands yourself. `finish` never performs the merge or cherry-pick.

## `asl clean`

```text
asl clean
```

Removes managed agent worktrees and their agent branches, then removes the integration worktree. The integration branch is deliberately retained as the durable handoff result.

Cleanup is allowed only after `stop` or `finish`. For each agent worktree, ASL compares uncommitted and branch-level changed paths with the integration worktree. If any content is absent or different in integration, cleanup refuses rather than deleting it. The repository's command-trust record is retained for later sessions.

## `asl init`

```text
asl init
asl init --force
```

Writes the default `.agent-sync.yml` in the current directory. It refuses to overwrite an existing file unless `--force` is supplied.

The managed-worktree fields are:

```yaml
worktrees:
  auto_install: true
  # setup_command: "npm ci"
```

When `setup_command` is present, it takes precedence. Otherwise `auto_install: true` selects a command from lockfiles in this order:

| Lockfile | Command |
|---|---|
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| `yarn.lock`, Yarn 2+ in `packageManager` | `yarn install --immutable` |
| `yarn.lock`, otherwise | `yarn install --frozen-lockfile` |
| `bun.lock` or `bun.lockb` | `bun install --frozen-lockfile` |
| `package-lock.json` or `npm-shrinkwrap.json` | `npm ci` |

Setup runs once for the integration worktree and once for each new agent worktree. A failing setup, or one that leaves tracked or unignored changes, rolls back the worktree creation.

## `asl server`

```text
asl server
asl server --config /path/to/.agent-sync.yml
asl server --repo-root /path/to/repository
```

Starts the standalone synchronization server. `--config` defaults to `./.agent-sync.yml`; a missing file uses defaults. `--repo-root` defaults to the current directory and enables disk hydration, debounced flush commits, configured line endings, and validation against that repository.

This command is for manual integrations and demos. Managed `asl codex` / `asl claude` sessions start their own ephemeral-port daemon and do not require `asl server`.

## `asl dashboard`

```text
asl dashboard
asl dashboard --server ws://localhost:4600
asl dashboard --interval 500
```

Continuously polls and renders the server's status endpoint. Server selection order is `--server`, the active repository's managed daemon, `.agent-sync.yml`, then `ws://localhost:4600`. `--interval` is milliseconds and defaults to `1000`. Stop it with Ctrl+C.

## Configuration used by managed sessions

| Field | Managed-session behavior |
|---|---|
| `paths.exclusive` | Routes listed documents through the lock service. |
| `paths.ignore` | Excludes matches from workspace scans. |
| `line_endings` | Controls integration-worktree output at flush time. |
| `flush.debounce_ms` | Controls automatic daemon flush delay. |
| `worktrees.auto_install` | Enables lockfile-based setup detection. |
| `worktrees.setup_command` | Overrides automatic setup with a shell command. |
| `validation.command` | Gates flush commits and is run again by `finish`. |
| `validation.on_fail` | `reject_merge` retains pending shared state; `warn_only` commits with a warning. |
| `symbol_index.*` | Reserved for Phase 8; currently inactive. |

The configured `server` address is used by standalone consumers. A managed session always creates its own loopback server on an available port and injects that address into its hooks.

## State, branches, and recovery

By default, state is stored at:

```text
~/.asl/repos/<repository-hash>/
  session.json
  daemon.json
  daemon.log
  known-docs.json
  trust.json
  settings/
  worktrees/<session-id>/
    integration/
    codex-001/
    claude-002/
```

Set `ASL_STATE_DIR` to move the state root, primarily for tests. The daemon control endpoint requires a random bearer token stored in `session.json`. Both the sync listener and control listener bind to `127.0.0.1`.

Room names are persisted so a restarted daemon can recreate them from the latest committed integration-worktree content. The Yjs document itself is memory-resident between flushes, so a machine or daemon crash before a successful flush can still lose the unflushed in-memory state; inspect retained agent worktrees before continuing after an abnormal termination.

## Safety checks and limitations

- A new session requires a clean checkout, a checked-out branch, and configured Git identity.
- File deletion is not represented by the current protocol. Codex `apply_patch` deletion is blocked; shell deletion is not synchronized.
- Workspace scanning skips binary files, files larger than 1 MB, and more than 200 changed files in one hook call.
- A process that changes files after its `Bash` tool call has returned is outside the corresponding post-hook snapshot.
- Specialized agent tools that bypass the covered hooks are not synchronized.
- Rooms are hydrated once. Direct disk changes made behind a live daemon are not automatically reconciled into an already-open room.
- Hook infrastructure errors currently warn and fail open so the coding agent is not made unusable. Check agent output and `daemon.log` if synchronization appears absent.

## Internal commands

The executable also has `_daemon` and `_hook` subcommands. They are implementation details generated by ASL and are intentionally omitted from the public CLI surface. Calling them manually can bypass lifecycle assumptions; use the public commands above.
