# Your first synchronized coding-agent session

This guide starts two coding agents in isolated Git worktrees, watches their synchronization state, and safely brings the result back to your original branch.

## Before you start

Use a repository whose current branch and commit you are comfortable using as the session base. ASL requires the original checkout to be clean:

```bash
git status --short
git config user.name
git config user.email
```

Commit or stash existing changes before proceeding. Also confirm that at least one supported coding-agent CLI is installed:

```bash
codex --version
# or
claude --version
```

See [Installation](installation.md) if `asl` is not installed yet.

## Optional: create project configuration

ASL works with defaults, so this step is optional:

```bash
asl init
```

Review `.agent-sync.yml` before the first launch. In particular:

- Put lockfiles or generated files that should never be text-merged in `paths.exclusive`.
- Confirm the automatically detected dependency setup or set `worktrees.setup_command`.
- Add a validation command only when you want it executed against synchronized changes.

Example:

```yaml
paths:
  exclusive:
    - "package-lock.json"
  ignore:
    - "node_modules/**"
    - "dist/**"

worktrees:
  auto_install: true

validation:
  command: "npm run typecheck && npm test"
  on_fail: reject_merge
```

Repository-defined setup and validation commands execute shell code. ASL shows the effective commands and asks for confirmation before running them for the first time. Re-review the prompt whenever the configuration changes.

## Start the first agent

From the original checkout:

```bash
asl codex --name primary
```

For Claude Code instead:

```bash
asl claude --name primary
```

ASL will:

1. Create an integration branch and integration worktree.
2. Install dependencies when configured.
3. Start a loopback-only synchronization daemon.
4. Create a separate worktree and branch for the agent.
5. Inject the compiled synchronization hooks.
6. Launch the coding agent inside its worktree.

On first use with Codex, open `/hooks`, inspect the ASL hook definition, and trust it. The coding agent remains responsible for its normal authentication and model configuration.

## Add another agent

Open a second terminal in the same original checkout and run:

```bash
asl claude --name reviewer
```

You can use two Codex agents, two Claude Code agents, or one of each. Every launch receives its own worktree while sharing the same integration daemon.

Agent CLI arguments must follow `--`:

```bash
asl codex --name tests -- --full-auto
```

ASL owns the working directory and hook configuration, so it rejects forwarded arguments that would replace those values.

## Observe the session

From another terminal:

```bash
asl status
```

For machine-readable output:

```bash
asl status --json
```

For a live room/peer view:

```bash
asl dashboard
```

Hook processes connect only for the duration of tool calls, so peer presence can appear briefly or show no connected peer between operations. The shared room state remains available.

## What happens when agents edit

Covered tools refresh shared files before operating. After a tool changes the workspace, the hook publishes its before/after snapshot through the synchronization layer.

If two agents change independent regions, Yjs merges the operations. If the second write is stale, overlaps a concurrent change, or has an ambiguous text anchor, ASL rejects it, restores the current shared state in that worktree, and tells the agent to re-read and retry.

A rejected write is expected coordination behavior. It is not evidence that the daemon lost the edit.

## Pause without finishing

Exit the coding-agent processes, then run:

```bash
asl stop
```

This flushes pending state and stops the daemon while retaining the integration and agent worktrees. Start another agent command later to resume the session:

```bash
asl codex --name followup
```

## Finish the session

Exit every ASL-launched coding-agent process, then run:

```bash
asl finish
```

ASL refuses to finish if the original checkout is dirty, moved to another branch or commit, or already has another Git operation in progress.

On success, changes are staged as an uncommitted merge in the original checkout. Review them:

```bash
git status
git diff --cached
```

Accept the result:

```bash
git commit
```

Or reject the whole prepared merge:

```bash
git merge --abort
```

ASL does not create the final commit for you.

## Clean managed worktrees

After finishing:

```bash
asl clean
```

Safe cleanup removes agent worktrees and branches while retaining the integration branch for recovery. It refuses to discard worktree changes that are not represented in integration state.

## Start over destructively

```bash
asl reset
```

`reset` stops recorded processes, removes every session-owned worktree and branch, aborts an ASL-prepared merge when present, and deletes repository-scoped ASL state. Unmatched or unflushed work inside managed worktrees is intentionally discarded.

Use `reset` only when that data loss is the desired outcome.

## Recover disk/CRDT divergence

After a crash, ASL can detect a three-way mismatch between the last flushed checkpoint, durable CRDT state, and the integration worktree. The server refuses to guess.

Resolve in favor of durable shared state:

```bash
asl recover path/to/file.ts --use-crdt
```

Or explicitly accept the integration-worktree version:

```bash
asl recover path/to/file.ts --use-disk
```

Restart the session after recovery.

## Troubleshooting

### “Original checkout must be clean”

Commit or stash changes in the checkout where you invoked ASL. Managed sessions deliberately do not start from an ambiguous source state.

### Codex edits are not synchronizing

Open `/hooks` in Codex and verify that the project hook is present and trusted. Restart Codex after changing hook configuration.

### ASL cannot find Claude Code's shell on Windows

Install Git for Windows. For a portable or nonstandard installation, set `CLAUDE_CODE_GIT_BASH_PATH` to the full `bash.exe` path.

### Dependency setup is wrong for this project

Set `worktrees.setup_command` in `.agent-sync.yml`, or launch with `--skip-setup` and prepare each worktree manually.

### Validation repeatedly rejects changes

Run the configured command in the integration worktree shown by `asl status --json`. Fix the underlying failure, then let the agent re-read current state before retrying.

### A process edited files after the tool returned

Background processes that outlive the covered tool call are outside snapshot/diff coverage. Stop the process and make the intended changes through a covered operation.

For every command and safety rule, see the [ASL CLI reference](asl-cli.md).
