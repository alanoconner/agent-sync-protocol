# Changelog

Tracks progress against the build order in [agent-sync-dev-spec.md](agent-sync-dev-spec.md) Section 10. Entries are grouped by phase, in build order, not by date. See `CLAUDE.md` for the architectural detail behind each item — this file is a progress record, not a design doc.

## Reliability fixes — hooks, persistence, transport, and FUSE

- Isolate hook snapshots by workspace, session, tool-call ID, and document path; do not store snapshots for read-only hooks.
- Restore pre-flush disk bytes on validation rejection without Git checkout or index mutation; remove only files that did not previously exist.
- Limit flush commits to their literal target path and mark content flushed only after Git succeeds, allowing retries after staging or commit failures.
- Close failed initial clients and evict rejected connection promises so later operations can reconnect.
- Encode document paths in WebSocket URLs and decode them on the server, preserving spaces, Unicode, and query/fragment characters.
- Wire the mounted FUSE truncate callback into snapshot-based writes and resize open descriptor buffers.
- Add regression coverage for all seven fixes, including a mocked native FUSE binding. Verified with the TypeScript build and 124 tests across 20 files; a live OS mount was not exercised.

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
