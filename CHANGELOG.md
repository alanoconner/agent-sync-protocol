# Changelog

Tracks progress against the build order in [agent-sync-dev-spec.md](agent-sync-dev-spec.md) Section 10. Entries are grouped by phase, in build order, not by date. See `CLAUDE.md` for the architectural detail behind each item — this file is a progress record, not a design doc.

## Phase 9 groundwork — managed `asl` agent launcher

- Added `asl codex` and `asl claude`. From a clean project checkout, one command creates/reuses an isolated integration worktree, creates a per-agent worktree and branch, starts a detached loopback-only Yjs/flush daemon, injects compiled hooks and environment variables, and launches the requested coding-agent CLI in that worktree.
- Moved the production hook bridge and workspace scanner into compiled `src/hooks/` modules. Codex hooks are injected through CLI config overrides without bypassing Codex trust; Claude Code receives an ASL-generated settings file. The older `examples/` bridge remains as a manual reference path.
- Added lockfile-driven worktree setup for npm, pnpm, Yarn, and Bun, plus `worktrees.auto_install` and `worktrees.setup_command`. Repository-defined setup and validation commands require an explicit first-use trust decision, and setup is rolled back if it fails or dirties the worktree.
- Added repository-scoped state under `~/.asl`, `asl status`, `stop`, `finish`, and guarded `clean`. Finalization flushes all CRDT rooms, reruns validation, shuts down the daemon, compacts granular flush history into one integration commit, preserves that branch, and prepares a `--no-ff --no-commit` merge in the original checkout for user review. It refuses a dirty, moved, or otherwise busy source checkout, and cleanup refuses to discard unmatched worktree changes.
- The daemon persists its known document list so a restarted session rehydrates CRDT rooms from the integration worktree. Its authenticated control API is bound to `127.0.0.1`; the synchronization listener is loopback-only as well.
- Added unit coverage for setup detection, hook injection/argument ownership, worktree lifecycle, final merge guards, and cleanup safety, plus an end-to-end CLI test proving an agent worktree edit passes through the hook and Yjs, is committed on the integration branch, and reaches the original checkout as a staged, uncommitted merge.
- Added `docs/asl-cli.md` as the complete public command and operations reference, including lifecycle semantics, option forwarding, configuration, state layout, safety checks, limitations, and internal-command boundaries.
- This is packaging groundwork, not completion of Phase 9: standalone binary builds, npm publication, platform installers, and installation CI remain outstanding.

## Phase 3 addendum — Codex hook adapter

- Added `examples/codexHook.ts`, a Codex-native `PreToolUse`/`PostToolUse` bridge for canonical `apply_patch` and `Bash` events. Both paths pull active rooms and use the command-agnostic workspace snapshot/diff flow, then publish changes through `writeFileFromSnapshot` so stale overlapping edits are rejected and reverted rather than guessed.
- Added `examples/codexHookSettings.example.json` for `.codex/hooks.json`. The adapter consumes Codex's matching `session_id`/`tool_use_id` pair, reads `.agent-sync.yml`, and supports the same environment overrides as the Claude Code bridge.
- `apply_patch` file deletions fail closed during `PreToolUse`, because the protocol has no delete/tombstone operation and allowing the patch would silently split the local worktree from shared state. `.codex/` joins `.claude/` in the workspace scanner's always-excluded hook configuration paths.
- Added `test/codexHook.test.ts` for successful patch synchronization, a stale same-span conflict and local revert, new-file handling, `.codex` exclusion, and deletion denial.
- Verified with the TypeScript build and 141 tests across 24 files.

## Reliability fixes — hooks, persistence, transport, and FUSE

- Prevent snapshot-based Codex/Bash/FUSE writes from entering deterministic retry loops on repetitive files: an unchanged live snapshot now applies its granular diff directly, while concurrent writes use an adaptively expanded anchor that is first proven unique in the writer's snapshot and then matched exactly once against live CRDT content. Genuine overlap and live ambiguity still reject without fuzzy matching.
- Isolate hook snapshots by workspace, session, tool-call ID, and document path; do not store snapshots for read-only hooks.
- Restore pre-flush disk bytes on validation rejection without Git checkout or index mutation; remove only files that did not previously exist.
- Limit flush commits to their literal target path and mark content flushed only after Git succeeds, allowing retries after staging or commit failures.
- Close failed initial clients and evict rejected connection promises so later operations can reconnect.
- Encode document paths in WebSocket URLs and decode them on the server, preserving spaces, Unicode, and query/fragment characters.
- Wire the mounted FUSE truncate callback into snapshot-based writes and resize open descriptor buffers.
- Add regression coverage for all seven fixes, including a mocked native FUSE binding. Verified with the TypeScript build and 124 tests across 20 files; a live OS mount was not exercised.

## Phase 3 addendum — hook bridge resolves the project root, not the shell cwd

- Found in a live run against a real repo: with `CLAUDE_PROJECT_DIR` unset, the hook used Claude Code's `cwd`, which follows the agent's `cd`. From `client/src` the same file was named `components/Foo.jsx` instead of `client/src/components/Foo.jsx` — a second, empty room (the dashboard showed both), whose `Pre` hook would overwrite the real local file with nothing. The hook now uses `CLAUDE_PROJECT_DIR`, else walks up from `cwd` to the nearest `.agent-sync.yml`/`.claude`/`.git` (`examples/workspaceRoot.ts`, `test/workspaceRoot.test.ts`).
- Second live run showed stray root-level `SchemaDiagram.jsx`/`TableNode.jsx`: the Bash path scan resolved relative tokens against the project root instead of the shell's cwd, so `sed ... TableNode.jsx` run from `client/src/components` named a nonexistent root file, and `Pre` materialized it empty. Tokens now resolve against `cwd` (docs are still named relative to the project root), and `Pre` no longer creates an empty file for a path that exists neither locally nor in the room.
- Third live run (same-line conflict test): one agent's edit never reached the room and no rejection fired — it edited via `python3 -c "p='client/…jsx'…"` through Bash, and the scan tokenized `p='client/…jsx'` as one garbage token (doc `p='client/…`), so the write silently bypassed sync (the known Bash gap, but a narrower one than it had to be). The scan now splits tokens on code punctuation (`= ' \" ( ) , ; < > | & [ ] { }`) and follows a `cd <dir>` earlier in the same command; non-existent tokens need an alphabetic extension to count as a plausible new file.

## Phase 3 addendum — hook bridge: command-agnostic `Bash` coverage (supersedes the path-token scan)

- Replaced the `Bash` path-token heuristic entirely. Three live runs showed it can't be made reliable (wrong base directory, `p='a/b.jsx'` read as one garbage token, `cd` inside the command) and every miss was a silent split-brain, which forced testers to tell agents "use only Edit". The `Bash` hooks no longer read the command: `Pre` pulls every existing room onto disk and snapshots the workspace; `Post` diffs against the snapshot and pushes each changed or new file through `writeFileFromSnapshot` (exact-match-or-reject, rejection reverts the file and exits 2), so it works for `sed`, scripts, formatters — anything that changes a file on disk.
- New `examples/workspaceScan.ts`: `WorkspaceScanner` lists files via `git ls-files --cached --others --exclude-standard` (walk fallback outside git; never `.git`/`node_modules`/`.claude`/`.agent-sync.yml`; honors `paths.ignore` via a small glob matcher), keeps a per-workspace mtime+size+hash cache (unchanged file = one `lstat`) and a content-addressed object store for each file's pre-command text, garbage-collected once unreferenced. Limits: deletions not synced, binary/>1 MB files skipped, ≤200 changed files per call, background processes outliving the command invisible.
- `paths.ignore` is now consumed (by the `Bash` scan only).
- `Pre` no longer rewrites a file whose content already matches shared truth (a redundant write bumped the mtime and made Claude Code report "file changed since last read"), and never materializes an empty file for a path that exists nowhere. `examples/claudeCodeHook.ts` is now type-checked by hand only (`tsconfig` covers `src/` alone) — worth wiring into CI later.
- Tests: `test/workspaceScan.test.ts` (listing/ignore/diff/cache/GC-safety) and `test/hookBash.test.ts` (runs the real hook as a subprocess against a real server: a script-driven edit from a subdirectory syncs, a stale conflicting one is rejected with the file reverted; new files sync, gitignored/`.claude` files don't). Verified with 138 tests across 23 files; not yet run against live Claude Code agents.

## Phase 7 addendum — `.agent-sync.yml` wired into every `SyncFileOps` consumer

Phase 7 shipped the config file but only `agent-sync server` read it; `paths.exclusive` was parsed and consumed by nothing. Now:

- `resolveSyncFileOpsOptions(config, overrides)` (`src/config/agentSyncConfig.ts`) is the single place a parsed config becomes `SyncFileOps` options (`server` → `serverUrl`, `paths.exclusive` → `exclusivePaths`). Explicit overrides win; a server URL from neither source is a hard error rather than a guessed `localhost:4600`.
- `McpSyncProxyOptions` and `MountOptions` accept `config?: AgentSyncConfig`; their `syncServerUrl`/`serverUrl` became optional (required only when no config is given). Existing explicit-options callers are unaffected.
- `examples/claudeCodeHook.ts` loads the workspace's `.agent-sync.yml` via `loadAgentSyncConfigOrDefault`; `AGENT_SYNC_SERVER`/`AGENT_SYNC_EXCLUSIVE_PATHS` remain as per-hook overrides.
- `line_endings` from the config now actually reaches `DiskFlushService` (`StartServerOptions.lineEndings`, passed by the CLI's `server` command) — it was parsed but dropped before.
- Verified: new `resolveSyncFileOpsOptions` tests, a config-driven `McpSyncProxy` test proving a write to a `paths.exclusive` path held by another owner comes back `EBUSY`, and a live smoke test of the hook bridge reading `paths.exclusive` from a real `.agent-sync.yml`.
- Still not consumed anywhere: `paths.ignore` and `symbol_index` (Phase 8).

## Phase 4 addendum — disk→CRDT hydration on room creation

Phase 4 only ever flushed doc→disk; a brand-new room always started empty, which is why the hook bridge needed its "room empty but disk isn't, so seed from disk" heuristic (and why that heuristic couldn't tell a never-synced file from a legitimately emptied one).

- `SyncServer` takes `SyncServerOptions.hydrate?: (docName) => string | undefined`, called exactly once per room on creation, synchronously and *before* the first client is greeted — so the sync-step-1/2 exchange already carries the seeded content. It emits `docHydrated` (not `docUpdate`) for seeded content; the server itself stays agnostic about what a doc name means.
- `createDiskHydrator(repoRoot)` (`src/flush/diskHydration.ts`) is the hydrator that treats a doc name as a path under the repo root — same convention and same refuse-to-escape-the-root discipline as `DiskFlushService`. Content is `toLf`-normalized on the way in, since this is a write entry point into the CRDT like any other.
- `DiskFlushService` listens to `docHydrated` and primes its last-seen/last-flushed trackers, so hydrated content (already on disk by definition) is neither re-written nor no-op-committed until a real edit lands.
- `startAgentSyncServer` installs the hydrator whenever `repoRoot` is set, so both the env-var binary and `agent-sync server` get it with no new flag. Without a repo root, rooms still start empty as before.
- The hook bridge's seeding heuristic is removed; it now relies on the server hydrating. Consequence, documented in the hook header and README: the bridge requires a server started with a repo root.
- Verified: `test/diskHydration.test.ts` (10 tests: hydrator in isolation, first-connect sees disk content, hydrate-once semantics, `docHydrated`-not-`docUpdate`, no no-op commit, snapshot write against a freshly hydrated room merges), plus a live smoke test with simulated hook stdin against a real server + git repo (first-touch `Read` preserved local content; `Edit` merged and committed).

## Docs — README.md added

Added `README.md` as the setup/usage entry point (install, running the server env-var- vs. config-driven, `.agent-sync.yml` reference, CLI command reference, and step-by-step instructions for wiring up the Claude Code hook bridge against real agents, including its known limitations). `CLAUDE.md` remains the architecture reference for contributors; this is the user-facing "how do I run this" doc.

## Phase 3 addendum — hook bridge hardened against Bash bypass

Live-tested `examples/claudeCodeHook.ts` (the Section 3.3b hook integration) against a real project with two real Claude Code agents editing concurrently.

- Confirmed working as designed: an `Edit` call correctly received `RangeMismatchError`/EAGAIN ("ambiguous") when its minimized `oldStr` matched more than one location in the file — the exact-match-or-reject discipline rejecting rather than guessing.
- Found and fixed a real gap: after two rejections, the agent applied the same change via a Python script run through `Bash` — a tool name the hooks didn't match. Confirmed live that the edit landed on disk but never reached the CRDT room (peeked the server's in-memory content directly), a split-brain that a later `Pre` hook on that file would have silently overwritten.
- Fix: `PreToolUse`/`PostToolUse` matchers extended to `Read|Edit|Write|Bash` / `Edit|Write|Bash`. A new `extractCandidatePaths` helper does a best-effort, non-shell-parsing scan of a `Bash` call's command string for tokens that resolve to an existing (or plausibly new) file inside the workspace, then runs each candidate through the same per-file `runPre`/`runPost` flow as a direct `Edit`/`Write` call. Verified against a live scratch repo: a `sed -i` edit applied through `Bash` now shows up in the CRDT room's content.
- Explicitly not a full fix — documented in `CLAUDE.md` and in code as a narrowing, not a close: a path built from a shell variable, glob, command substitution, or heredoc still bypasses sync silently. Full coverage regardless of mechanism is what FUSE/kernel-level interception (Section 3.3a) is for.

## Phase 7 — CLI + config + dashboard

- `.agent-sync.yml` config format (`src/config/agentSyncConfig.ts`): every field defaults to what `agent-sync init` writes except `validation`, which is left unset rather than guessed, since it's a shell command that runs against the repo on every flush.
- `GET /status` endpoint on the sync server's existing HTTP server (`src/server/syncServer.ts`) — a plain polled JSON snapshot rather than a new wire-protocol message, since it's a read-only, low-frequency, human-facing concern with no CRDT/awareness semantics.
- `startAgentSyncServer()` (`src/server/bootstrap.ts`) extracted so the env-var-driven binary and the config-file-driven CLI share one implementation of the flush/validation wiring.
- `agent-sync` CLI (`src/cli/index.ts`): `init` (writes `.agent-sync.yml`), `server` (config-file-driven), `dashboard` (polls `/status`, renders via pure functions in `src/cli/dashboardView.ts`).
- Verified: 96 tests passing (`test/agentSyncConfig.test.ts`, `test/serverStatus.test.ts`, `test/dashboardView.test.ts` new for this phase) plus a live smoke test of the compiled CLI binary end-to-end (init → server → dashboard → real client → real git commit).
- `examples/demoClient.ts` added as a manual-testing aid — two terminals against the same doc name, watching real CRDT convergence.

## Phase 6 — Lock service for declared exclusive files

- Server-arbitrated lock leases (`SyncServer`'s per-room `Room.lock`), not CRDT-merged state — a real "one requester wins now" protocol needed its own wire-protocol type (`MESSAGE_LOCK`) rather than riding the sync/awareness channels.
- `SyncFileOps` gained `exclusivePaths`/`ownerId`/`lockLeaseMs`, wrapping each write in an acquire-before/release-after (`finally`) around the lock service, transaction-scoped to one write.
- TTL-based expiry (covers a hung holder) plus immediate release on socket disconnect (covers the common case of a holder's process actually exiting).
- `LockDeniedError` (`EBUSY`) threaded through both the MCP proxy's `.code`-based error dispatch and the FUSE driver's explicit `toErrno` mapping.

## Phase 5 — Validation gate

- `ValidationGateService` (`src/validation/validationGateService.ts`): runs a configured shell command, reports pass/fail — knows nothing about git or the sync layer, so it's unit-testable standalone.
- `DiskFlushService` integration: commit only after a passing gate; `reject_merge` reverts the on-disk write and leaves the live `Y.Doc` untouched (agents keep editing against current reality); `warn_only` commits anyway and emits a warning event.
- Rejection notice rides the same `Y.Doc` as file content (a reserved `_validation` Y.Map entry) rather than a side channel, so it converges to every client for free. Consumed once by the next write attempt (`ValidationRejectedError`/`EVALIDATE`), which is what makes "re-read and retry" actually true.
- Concurrent flushes across different docs serialized, since a slow validation command widens the write→commit race window that Phase 4 left mostly harmless.

## Phase 4 — Disk flush + git commit + line-ending normalization

- `DiskFlushService` (`src/flush/diskFlushService.ts`): debounced per-doc flush to `<repoRoot>/<docName>` plus a commit-per-flush via `simple-git`.
- LF held canonically inside the CRDT itself (`toLf` at every `SyncFileOps` write entry point); converted to the configured line-ending style only at the disk-flush boundary (`fromLf`) — two normalization points for two different reasons, not one.
- `SyncServer` gained a `docUpdate` event plus `getDocNames()`/`getDocContent()` so `DiskFlushService` can read canonical state in-process without opening its own `SyncClient`.

## Phase 3 — Transparent tool interception

- `SyncFileOps` (`src/sync/syncFileOps.ts`): the shared `readFile`/`writeFileFull`/`writeFileFromSnapshot`/`writeFileRange` normalization point every interception mechanism funnels into.
- `src/sync/textMerge.ts`: `applyContentDiff` (blind full-replace, diffed against live content) and `computeMinimalReplacement` (honest before/after, collapsed to a minimal exact-match-or-reject range) — kept pure and independently unit-tested.
- `McpSyncProxy` (`src/mcp/`, Section 3.2): a real MCP server/client pair that forwards `tools/list` verbatim and diverts only mapped `tools/call`s. `.agent-sync-mcp-map.yml` parsing is deliberately strict — no guessed defaults for an ambiguous tool mapping.
- `SyncFsOperations`/`mountSyncFs.ts` (`src/fuse/`, Section 3.3a): FUSE driver proving per-file merge semantics in tests. No `readdir`/`mkdir`/`rename` yet, and needs macFUSE installed to actually mount — not production-usable for real project navigation.
- `examples/claudeCodeHook.ts` (Section 3.3b): the hook-based mechanism, validated as the recommended default for CLI coding agents that expose a hook API (see the Phase 3 addendum above for the Bash-bypass fix found during live testing). Also fixed during initial live testing: a disk→CRDT seeding heuristic in `runPre` — without it, the first agent to touch an already-existing file would pull an empty new room and overwrite real local content with nothing.

## Phase 2 — Multi-file + presence awareness

- Arbitrary/nested doc paths (`test/multiFile.test.ts`).
- Awareness channel wired through `y-protocols/awareness`, with both server and client clearing their own phantom `{}` local state on construction so an agent that hasn't called `setPresence()` doesn't show up as a contentless peer.
- Client reconnect with jittered exponential backoff (`test/reconnect.test.ts`); two protocol details fixed here are documented in `CLAUDE.md`'s Client section (`whenSynced()` keying off sync-step-2 specifically, and re-asserting presence via `setLocalState()` rather than a raw re-encode after reconnect).

## Phase 1 — Core CRDT sync

- Wire protocol (`src/protocol/messageTypes.ts`): `MESSAGE_SYNC`/`MESSAGE_AWARENESS` envelope over `y-protocols/sync` and `y-protocols/awareness`, with `yjs` owning all merge/staleness logic.
- `SyncServer`: one `Y.Doc` + `Awareness` per room, keyed by WebSocket URL path; rooms created lazily and kept alive for the server's lifetime regardless of client connections.
- `SyncClient`: wraps a `Y.Doc` + `Awareness`, mirrors the server's handshake.
- Proven via real WebSocket round-trips between two test clients (`test/convergence.test.ts`) rather than mocking the protocol.
