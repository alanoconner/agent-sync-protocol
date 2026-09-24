# Repository Guidelines

## Project Structure & Module Organization

This repository implements a TypeScript synchronization layer for concurrent coding agents using Yjs and WebSockets. Source lives in `src/`: `server/` and `client/` handle transport and presence; `sync/` provides shared file operations; `mcp/` and `fuse/` adapt file access; `flush/` and `validation/` manage persistence and validation. Configuration, wire messages, and CLI commands live in `config/`, `protocol/`, and `cli/`.

Tests live in `test/*.test.ts`. `examples/` contains the demo client, Claude Code hook bridge, and configuration examples. Treat `agent-sync-dev-spec.md` as the design source of truth; consult `README.md`, `CLAUDE.md`, and `CHANGELOG.md` for usage, architecture, and implementation history.

## Build, Test, and Development Commands

- `npm install`: install dependencies; native FUSE support requires platform prerequisites.
- `npm run build`: compile source and emit JavaScript, declarations, and source maps to `dist/`.
- `npx tsc --noEmit -p .`: check source types without emitting files.
- `npm test`: run the Vitest suite once.
- `npx vitest run test/convergence.test.ts`: run a focused test file.
- `npm run server`: start the default in-memory server on port 4600.
- `npm run demo -- shared.txt alice`: connect an interactive demo client.
- `npm run cli -- init`: generate `.agent-sync.yml`.

## Coding Style & Naming Conventions

Follow existing strict TypeScript and ESM conventions: two-space indentation, double quotes, semicolons, and `.js` extensions in relative imports. Use PascalCase for classes and interfaces, camelCase for functions and variables, and uppercase constants for protocol identifiers. Match nearby filenames, such as `SyncClient.ts` and `diskFlushService.ts`. No dedicated formatter or lint script is configured.

## Testing Guidelines

Use Vitest with descriptive `describe` and `it` blocks in `test/<feature>.test.ts`. Cover observable behavior, especially convergence, rejected edits, reconnects, and persistence. Clean up sockets, clients, servers, timers, and temporary repositories. Run focused tests during development and the full suite plus build before submitting. No numerical coverage threshold is configured.

## Commit & Pull Request Guidelines

Existing commits use short subjects (`init`, `documentation`, `phase 7`); no formal commit convention is established. Use concise, descriptive subjects. PRs should explain the problem, behavior changes, relevant spec sections or issues, and verification performed. Update documentation when configuration or guarantees change.

## Persistence & Configuration

Use a disposable repository when testing disk flush: enabling a repository root writes files and creates Git commits. Validation commands execute shell code; configure them explicitly. Keep CRDT text normalized to LF and preserve exact-match-or-reject edit semantics.
