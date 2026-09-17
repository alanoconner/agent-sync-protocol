# Changelog

Tracks progress against the build order in [agent-sync-dev-spec.md](agent-sync-dev-spec.md) Section 10. Entries are grouped by phase, in build order, not by date. See `CLAUDE.md` for the architectural detail behind each item — this file is a progress record, not a design doc.

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
