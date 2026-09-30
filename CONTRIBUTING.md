# Contributing to Agent Sync Layer

Thank you for helping improve concurrent coding-agent synchronization. Contributions are welcome in the form of bug reports, reproducible integration failures, documentation improvements, tests, and focused code changes.

## Development setup

Requirements:

- Node.js 20.12 or newer.
- npm.
- Git with an author name and email configured.
- Platform prerequisites only for features you are testing, such as macFUSE or libfuse for a real FUSE mount.

Install and verify the project:

```bash
npm ci
npm run typecheck
npm run typecheck:examples
npm test
npm run build
```

## Repository layout

- `src/server/` and `src/client/` implement Yjs/WebSocket transport, presence, locking, and durability.
- `src/sync/` provides normalized file operations, text merging, tombstones, and line-ending handling.
- `src/hooks/` connects Codex and Claude Code file operations to shared state.
- `src/cli/` manages agent worktrees, the daemon, recovery, and final integration.
- `src/flush/`, `src/persistence/`, and `src/validation/` handle durable state, disk/Git commits, and validation.
- `src/mcp/` and `src/fuse/` provide alternate interception adapters.
- `test/` contains Vitest integration and unit tests.
- `agent-sync-dev-spec.md` is the design source of truth.

## Making a change

1. Read the relevant section of `agent-sync-dev-spec.md` and the nearby implementation.
2. Keep adapters routed through `SyncFileOps` rather than duplicating merge logic.
3. Preserve strict TypeScript and ESM conventions: two-space indentation, double quotes, semicolons, and `.js` extensions in relative imports.
4. Add or update tests for observable behavior.
5. Run a focused test while iterating, then the complete verification commands before submitting.

Example focused test:

```bash
npx vitest run test/convergence.test.ts
```

## Test expectations

Tests should cover externally visible outcomes, especially:

- convergence between independent clients;
- stale or ambiguous edit rejection;
- reconnect and crash recovery;
- deletion/tombstone behavior;
- validation rollback;
- literal filenames and path containment;
- cleanup of sockets, servers, timers, worktrees, and temporary repositories.

Prefer real WebSocket or MCP round trips over mocks when validating protocol behavior. Use polling assertions such as `vi.waitFor` for asynchronous convergence instead of fixed timing sleeps where practical.

## Pull requests

Keep pull requests focused. Include:

- the problem being solved;
- the behavior before and after;
- relevant specification sections or issues;
- validation commands run;
- documentation changes when configuration, guarantees, installation, or user workflow changes.

Do not include generated `dist/`, `artifacts/`, dependency directories, credentials, local `.agent-sync.yml` files, or ASL session state.

## Reporting bugs

Include the operating system, installation method, Node.js version when applicable, Git version, coding-agent CLI, exact ASL command, relevant `.agent-sync.yml` fields, and a minimal reproduction. Remove repository secrets and sensitive source content from logs.

Report security-sensitive issues through the process in [SECURITY.md](SECURITY.md), not a public issue.
