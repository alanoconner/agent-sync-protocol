# Agent Sync Protocol — Development Specification

## 1. What we're building

A low-level synchronization layer that sits between coding agents and the codebase they edit, so multiple agents can work on the same repository concurrently. It has three jobs, in increasing order of difficulty:

1. **Convergent saves (guaranteed)** — when two agents edit the same file concurrently, both edits are preserved and merged automatically via CRDT. No lost writes, no manual conflict markers.
2. **Presence awareness (guaranteed)** — every agent (or an observing dashboard) can see who's editing what, in real time.
3. **Dependency-change awareness (best-effort)** — if Agent A is about to call a method that Agent B has just changed elsewhere in the codebase, the system can surface that before Agent A commits to a stale assumption.

**Explicitly out of scope for v1:** task orchestration/dispatch logic, full AST-aware semantic merging. The validation gate (Section 6) and the symbol index (Section 5) are the mitigations for semantic risk, not full solutions — see Section 9 for what this system does and does not guarantee.

---

## 2. Non-negotiable design decisions

- **No single interception mechanism covers every agent — pick per agent type, not one default for all.** MCP-based tool calls, framework-native tool registration, and OS-level virtual filesystems (FUSE/WinFsp) are three different interception points for three different categories of agent — see Section 3, which now leads with a decision table rather than a single default. This is what makes the system cross-platform (Linux/macOS/Windows) without silently failing to cover important agents.
- **Agents must not need special instructions to use the sync layer's core guarantee.** File edits and reads should be transparently rewired to route through our layer instead of disk — the agent keeps calling its normal `write_file`/`edit_file`/`read_file` tools exactly as it always has. See Section 3. Agent instructions are only needed for the smaller set of things that are genuine *decisions*, not mechanics — see Section 8.
- **CRDT-based merge, not locks, for the default path.** Use an existing, battle-tested library (Yjs or Automerge). Do not hand-roll CRDT algorithms.
- **Locks are opt-in, lease-based, for declared hot files only** (e.g. shared config, schema files). Always TTL-based expiry, never graceful-unlock-only — an agent process can die mid-edit exactly like a thread can die holding a monitor.
- **The sync server is the single source of truth for in-flight edits.** Disk is a periodic flushed snapshot, not the live truth — reads should also be transparently redirected (Section 3) so agents never see stale disk content while a merge is in flight elsewhere.
- **A validation gate runs after every merge, before it reaches the trunk branch/commit.** Textually-correct merges of code can still be semantically broken; this is the backstop for that, not a formality.
- **Errors from our layer must look like ordinary file-system errors to the agent.** If the underlying tool call would normally throw/return a particular shape on failure, a rejected edit (conflict, lock denial, validation failure) must come back in that same shape — never a custom protocol-specific response the agent was never told to expect. See Section 3.5.

---

## 3. Transparent tool interception (core mechanism)

This is the most important architectural decision in the system: **the agent never knows this layer exists.** It keeps calling whatever file-edit/read mechanism it already uses; we swap out what actually runs underneath.

### 3.0 There is no single interception point — pick per agent category

Different agents reach the filesystem through genuinely different paths, and each path needs a different interception mechanism. Getting this wrong (assuming one mechanism covers everything) means silently failing to cover major targets like Claude Code or Codex.

| Agent category | How it reaches files | Interception mechanism | Section |
|---|---|---|---|
| Custom/framework agents that expose file ops as MCP tools | MCP tool calls | Generic MCP proxy | 3.2 |
| Frameworks with a clean tool-registration API (LangChain-style `Tool(name=..., func=...)`) | In-process function call bound to a tool name | Direct rebinding of the registered function | 3.3 |
| **CLI coding agents with a pre/post-tool hook API — Claude Code (`PreToolUse`/`PostToolUse`), Codex (`PreToolUse`/`PostToolUse` on `apply_patch`), and others that expose an equivalent** | Compiled-in tool calls straight to OS filesystem syscalls, but the CLI itself fires a hook immediately before/after the call | **Hook-based sync — sync disk to latest merged state before the tool runs, push the resulting edit after** | 3.3b |
| CLI coding agents with **no** hook API and no rebindable registry | Compiled-in tool calls straight to OS filesystem syscalls, no interception point exposed at all | Virtual filesystem (FUSE / WinFsp) | 3.3a |
| Frameworks with hardcoded file tools and no plugin hook, not covered above | Varies | Monkey-patch as last resort | 3.3 |

Audit which category each target agent falls into before assuming the MCP proxy or tool-registration approach applies. For CLI coding agents specifically: check for a hook API first (3.3b) — it's zero-install, avoids the directory-navigation gap FUSE currently has (3.3a), and for agents like Claude Code whose built-in Edit tool does its own content matching, it improves correctness of that matching almost for free (see 3.3b). Reach for FUSE (3.3a) only when no hook mechanism exists for that agent.

### 3.1 How rebinding works (for categories where a registry exists)

Every agent framework with a tool-registration API has a layer where a tool's *name* is bound to an actual *function implementation*. The model only emits "call `write_file` with these args" — it has no visibility into what code executes. Replace the registered implementation; leave the tool's name, description, and argument shape untouched.

```
Before:  agent emits write_file(path, content) → framework calls fs.writeFileSync(path, content)
After:   agent emits write_file(path, content) → framework calls agentSyncClient.editFile(path, content)
```

Apply the same swap to the read path: `read_file` should return the sync server's current merged CRDT state for that file, not disk content, so an agent never acts on stale data while another agent's edit hasn't been flushed yet. Disk is downstream of the sync server, not the thing tools read from directly.

**This only works when a rebindable registry exists.** CLI coding agents with compiled-in file tools have no such registry — see 3.3a.

### 3.2 Generic MCP proxy — support any MCP server without touching core logic

For MCP-based agents, do not build a bespoke MCP server hardcoded to one specific tool's semantics. Build a **generic pass-through proxy** instead, so that supporting a new MCP server is a config change, never new core code.

**How it works:** the proxy sits between the agent and whatever real MCP server it would normally talk to (a filesystem server, Claude Code's built-in tools, a custom coding-agent server). On startup it connects *as an MCP client* to the real server, fetches its `tools/list`, and re-exposes that exact tool list downstream to the agent — same names, same schemas, same descriptions, so the agent never knows a proxy exists (same guarantee as Section 3.1).

```
Agent ──(MCP)──▶ Proxy MCP server ──(MCP client)──▶ Real MCP server (filesystem, etc.)
                       │
                       ▼ (only for mapped file-edit/read tools)
                 Client SDK → Sync server
```

Most tool calls are pure pass-through: request in, forward to the real server, response back out, untouched. Only calls matching an entry in a small **mapping config** get diverted into `editFile`/`readFile` against the sync layer:

```yaml
# .agent-sync-mcp-map.yml
mappings:
  - tool: "write_file"
    op: write
    path_param: "path"
    content_param: "content"
    mode: full_replace
  - tool: "str_replace_based_edit_tool"
    op: write
    path_param: "path"
    content_param: "new_str"
    mode: range_replace
    range_params: ["old_str"]
  - tool: "read_file"
    op: read
    path_param: "path"
```

The proxy shapes the *response* back into whatever format that specific tool would normally return, so a mapped call's success response looks exactly like the real server's — extending the Section 3.5 error-shape-preservation principle to success responses too.

**Why this protects core logic:** the CRDT engine, awareness channel, symbol index, and validation gate only ever see normalized `editFile(path, content)` / `readFile(path)` calls. They have no dependency on which MCP server or tool name produced that call. Supporting a server no one's tested against yet means writing a mapping entry, not touching the sync engine — unmapped tools pass through by default rather than breaking, so an unrecognized server degrades to "no sync for this tool" instead of failing outright.

Ship a small built-in library of mapping presets for common cases (a generic filesystem MCP server, Claude Code's tool names) so most setups need zero config; let anyone add an entry for something custom.

**Two things this doesn't solve automatically:**
- **Edit semantics vary** (full overwrite vs. range/diff-style replace vs. patch). The `mode` field needs to cover whatever conventions exist, since the SDK must convert each into CRDT operations correctly — a bounded set of cases, but real work per mode, not free from the mapping config alone.
- **`range_replace` match failure is a rejection, never a fuzzy match.** If `old_str` isn't found verbatim in the current CRDT state (because another agent's edit merged in since this agent last read the file), the SDK must reject with `EAGAIN` (Section 3.6) — never attempt to fuzzy-match `old_str` against nearby-but-not-identical current content. Exact-match-or-fail is the real tool's actual contract (the agent's `old_str` is its proof of having seen current content); fuzzy-matching would silently apply an edit to a different block than the one the agent reasoned about, succeeding without any signal that anything went wrong. A silent wrong-location write is strictly worse than a rejection — it defeats the validation gate's ability to catch it, since nothing marks the result as suspect.
- **Ambiguous or composite tools** (a call that both reads and writes, or a rename that's really delete+write) need an explicit `mode` rather than auto-detection from the tool's name or description — guessing risks misclassifying a destructive tool as harmless, which is exactly the silent-failure class this system exists to prevent. Require an explicit mapping entry for anything the built-in presets don't already cover.

### 3.3 Non-MCP frameworks with a rebindable registry

1. **Frameworks with a clean tool-registration API** (LangChain-style `Tool(name=..., func=...)`, most custom tool-calling loops) — register the SDK's functions under the exact tool names the agent already expects. This is a config/wiring change.
2. **Frameworks with a plugin/middleware hook** that runs before a built-in file tool executes — hook in there if direct rebinding isn't exposed.
3. **Last resort, no hook of any kind** — monkey-patch the framework's file I/O module at the process level. Brittle across framework versions; avoid unless 1–2 are unavailable and 3.3a doesn't apply.

### 3.3a Virtual filesystem (FUSE / WinFsp) — mechanism for CLI agents with no hook API

Use this only when a target CLI coding agent exposes neither a rebindable tool registry (3.1) nor a pre/post-tool hook mechanism (3.3b). Prefer 3.3b wherever it's available — it's zero-install and avoids the directory-navigation gap noted below.

**How it works:** mount a virtual filesystem (FUSE on Linux/macOS, WinFsp on Windows) at the path the agent treats as its working directory. When the agent's built-in file tool executes its normal syscall, that syscall resolves against the virtual mount instead of a real directory. The FUSE/WinFsp driver is what actually talks to the sync server on the other end — the agent's binary does exactly what it always does; only where "the filesystem" physically resolves has changed.

```
Agent's built-in Write tool → fs.writeFile() syscall → FUSE/WinFsp mount → sync server
                                                        (agent has zero awareness of this)
```

**Implementation notes:**
- Reads (`open`/`read` syscalls against the mount) should return current CRDT-merged content, same principle as Section 3.1's read-path swap.
- Writes (`write`/`close` syscalls) should be translated into `editFile` calls against the sync server, going through the same `range_replace`-vs-`full_replace` and match-or-reject logic as Section 3.2, since the underlying semantics (does this edit still apply to current content) don't change based on which interception mechanism delivered it.
- Error responses need to come back as real POSIX/Windows filesystem error codes (`EBUSY`, `EAGAIN`, etc.) at the syscall level — Section 3.6's message-embedding approach still applies, since these agents read tool-call error output the same way any agent does.
- This needs one implementation per OS (libfuse on Linux, macFUSE on macOS, WinFsp on Windows) — unlike 3.1–3.3, this is real OS-specific engineering work, not a config/wiring change. Budget for it accordingly; do not treat it as equivalent effort to the MCP proxy or the hook mechanism.

**Known current limitations (do not treat this path as production-ready until resolved):**
- **Requires a real system-security change from the end user** — on macOS, macFUSE needs its kernel extension enabled via System Settings, which this codebase deliberately does not (and should not) do on the user's behalf, and may require a reboot. This is real installation friction, not a config step — weigh it against 3.3b for any agent where a hook alternative exists.
- **Directory operations are commonly the last syscalls implemented, and their absence blocks real usage.** A driver that only implements `open`/`read`/`write`/`truncate`/`flush`/`release`/`unlink` — enough to prove per-file merge semantics in tests — has no `readdir`/`mkdir`/`rename`. Without those, `ls`, `Glob`, and any directory browsing on the mount fail, which blocks real multi-file project navigation even though single-file read/write already works. Treat directory-op support as a hard requirement before this path is usable on an actual project, not a later polish item.

### 3.3b Pre/post-tool hooks — mechanism for CLI agents that expose one (Claude Code, Codex, and similar)

**Recommended default for Claude Code and any CLI agent with an equivalent hook API**, ahead of FUSE (3.3a) — no system install, no kernel extension, no reboot, and it sidesteps the directory-navigation gap in 3.3a entirely, since real disk stays real disk for everything except the one file actively being edited.

**How it works, using Claude Code's `PreToolUse`/`PostToolUse` hooks as the concrete example:**
- **`PreToolUse`** (on Edit/Write, and ideally Read): before the built-in tool runs, pull the current merged content from the sync server and write it to the real file on disk. The built-in tool then executes against genuinely current content.
- **`PostToolUse`**: read the resulting disk content, diff it against the pre-image the hook just wrote (this diff is precisely this agent's edit, since nothing else should write to that file in the gap between the two hooks), convert the diff to a CRDT operation, and send it to the sync server.

```
Claude Code Edit tool call
   → PreToolUse hook: pull merged state from sync server, write to disk
   → Edit tool runs normally against disk (old_str match now checked against current content)
   → PostToolUse hook: diff pre/post disk state, send as CRDT op to sync server
```

**Why this is not just a stopgap for 3.3a's current gaps — it's arguably the better long-term mechanism for this category:**
- Directory operations (`ls`, `Glob`) need no special handling at all, since the filesystem is never virtualized — only the one file being actively edited needs syncing, right before and after the tool call that touches it.
- Claude Code's built-in Edit tool does its own `old_str`-style content matching against whatever's on disk at call time. Because the `PreToolUse` hook guarantees disk reflects the latest merged state immediately before that match happens, this mechanism achieves the exact-match-or-reject correctness goal from Section 3.2's `range_replace` rule largely for free, rather than needing a custom match implementation.
- Fully consistent with the "agent needs zero instructions, zero awareness" principle (Section 2) — Claude Code keeps calling Edit/Write/Read exactly as it always has.

**Implementation notes:**
- This is per-CLI-agent config (a hook script registered with that agent's hook system), not a generic mechanism — verify against each target agent's current hook documentation before assuming coverage; fall back to 3.3a only for agents that expose neither a hook API nor a registry.
- The pre/post diff needs to become a real CRDT operation (insert/delete), not a full-file overwrite sent to the sync server — a full overwrite would discard the operation-level granularity CRDT merge depends on.
- Error handling: if the sync server rejects the resulting operation (lock denial, validation failure), the `PostToolUse` hook has already let the built-in tool "succeed" against local disk — the rejection has to be surfaced back to the agent through a subsequent tool call's error (e.g. the next `PreToolUse` pull fails, or a following action on that file returns the rejection) rather than being invisible. Design this failure path explicitly rather than assuming it falls out naturally from the hook sequence.

**Codex (confirmed against Codex's published hooks reference; verify the installed runtime before deployment):**
- Codex's file-edit tool is `apply_patch`, and it's covered by both `PreToolUse` and `PostToolUse` (matchable as `apply_patch`, `Edit`, or `Write`). Same pre-sync-then-diff pattern applies: `PreToolUse` refreshes disk to the latest merged state before `apply_patch` runs; `PostToolUse` diffs the result and sends it to the sync server.
- **Codex's `PreToolUse` supports outright denial** (`permissionDecision: "deny"` with a reason), which is stronger than Claude Code's pattern as described above — instead of only refreshing disk and relying on `apply_patch`'s own patch-context matching to fail on a stale edit, the hook can proactively check the sync server and block the call before it touches disk at all when a real conflict exists.
- `apply_patch` operates on unified-diff-style patch text rather than Claude Code's `old_str`/`new_str` replace — its own patch-context matching plays the same role as the `range_replace` exact-match rule in Section 3.2 once disk is pre-synced to current state, so this still doesn't need a custom match implementation.
- **Reference adapter:** `examples/codexHook.ts` handles canonical `apply_patch` and `Bash` events by pulling all active rooms and taking a command-agnostic workspace snapshot before the tool, then diffing and publishing changed/new text files afterward. It deliberately does not parse patch paths. `apply_patch` deletion operations are denied during `PreToolUse` because the current protocol has no file tombstone; silently applying a local-only deletion would violate the synchronization guarantee.
- **Real gap, not yet resolved: Codex's documented tool-coverage table does not list a hook path for plain file reads** — only `Bash`, `apply_patch`, MCP tools, and a small set of other named local function tools are covered. This means the "pre-sync disk before a read" half of the pattern (Section 3.1's read-path swap) may not be achievable for Codex the way it is for agents with a rebindable registry or an MCP proxy in front of them. Confirm directly against a running Codex instance before assuming read freshness is guaranteed; if it isn't, Codex agents may act on disk content that's stale relative to what's already merged elsewhere until the next flush.

### 3.4 Reference integration

Ship the generic MCP proxy (3.2) and the hook-based driver (3.3b) as the two primary reference integrations — the first covers custom/framework agents, the second covers CLI coding agents like Claude Code and Codex, which are likely priority targets and are both confirmed to expose a usable hook API. Add one non-MCP tool-registration example (3.3, tier 1) so the wiring pattern is copy-pasteable for frameworks that don't speak MCP either. Treat 3.3a (FUSE/WinFsp) as needed only if a target CLI agent turns out to expose neither a hook API nor a registry.

### 3.5 Error shape preservation

Whatever error/exception shape the *original* tool implementation would produce on failure (e.g. a permission error, a not-found error) is the shape our layer must produce for its own failures:

- Merge conflict that can't auto-resolve → surfaced as if it were an ordinary write failure.
- Lock denial on an exclusive file → surfaced as if the file were locked/in-use at the OS level.
- Validation gate rejection → surfaced as if the write itself failed.

Do not invent a new response shape the agent was never told to expect — that silently reintroduces the "agent needs special instructions" problem this whole approach exists to avoid, just relocated from "which tool to call" to "how to interpret a novel response."

### 3.6 Self-describing rejection messages

The error *type/shape* stays conventional (Section 3.5), but the error *message text* should carry the actionable instruction, since agents already read and act on error message content as a matter of course — this is a cheap way to fold most of Section 8's guidance into the protocol itself rather than into a separate instruction file.

Reuse standard OS-style error codes where a natural fit exists, since many agent frameworks already have generic retry/backoff behavior wired to common codes (e.g. `EBUSY`, `EAGAIN`) — this means some rejections get sensible agent behavior "for free," with no instruction needed at all, custom or otherwise.

Recommended templates:

| Rejection reason | Suggested code | Message text |
|---|---|---|
| Concurrent edit couldn't auto-merge | `EAGAIN` | "File was modified concurrently and could not be automatically merged. Re-read the file before retrying your edit." |
| Exclusive file currently locked | `EBUSY` | "File is currently locked by another process. Wait briefly and retry." |
| Validation gate rejected the merged result | `EVALIDATE` (custom code, conventional shape) | "Write rejected: the combined change failed validation (`<command that failed>`). Re-read the current file state before retrying." |
| Symbol referenced in this edit changed elsewhere since last read | `ESTALE` | "Write rejected: `<symbol name>` was modified in `<file path>` after your last read of it. Re-read its current definition before proceeding." |

Guidelines for writing these:
- Keep them short, specific, and action-oriented — say what to do next (re-read, wait-and-retry), not just what went wrong.
- Include concrete identifiers (file path, symbol name, failing command) wherever available — a generic "validation failed" message is far less useful than one naming what failed.
- Don't overload the message with protocol internals (CRDT terms, server jargon) — write it the way a normal file-system error would read, just more specific.
- This does not replace Section 8 entirely — it shrinks it. Genuinely novel situations (e.g. how to behave under a *pattern* of repeated conflicts, not just a single one) may still need explicit instructions; a single rejection's immediate next step generally should not.

---

## 4. High-level architecture

```
Agent A ── (native file tools, rewired) ──┐        ┌── (native file tools, rewired) ── Agent B
                                            ▼        ▼
                                     ┌──────────────────┐
                                     │   Client SDK      │   (invisible to agent —
                                     │   (tool impl swap) │    bound under the tool's
                                     └──────────────────┘    original name)
                                            │
                        ┌───────────────────┴───────────────────┐
                        ▼                                       ▼
              ┌─────────────────────┐               ┌───────────────────────┐
              │     Sync server      │               │      Symbol index      │
              │  CRDT merge +        │               │  cross-file dependency │
              │  presence awareness  │               │  graph (best-effort)   │
              └─────────────────────┘               └───────────────────────┘
                        └───────────────────┬───────────────────┘
                                            ▼
                                 ┌─────────────────────┐
                                 │  Validation gate      │
                                 │  lint, typecheck,     │
                                 │  tests                │
                                 └─────────────────────┘
                                            │
                                            ▼
                                 ┌─────────────────────┐
                                 │     Disk + git         │
                                 │  flushed file, commit  │
                                 └─────────────────────┘
```

### Components to build, in order

1. Sync server (CRDT merge engine + presence awareness + lock service)
2. Client SDK + transparent tool-binding swap (Section 3)
3. Disk flush + git integration
4. Validation gate
5. Symbol index / dependency-change awareness (best-effort, Section 5)
6. CLI (`agent-sync init`, config, dashboard)

---

## 5. Symbol index / dependency-change awareness (best-effort subsystem)

**Problem it addresses:** presence awareness alone can't tell Agent A that a method it's about to call was just changed by Agent B in a different file — there's no file-open event for A to observe, since A never opens file B.

**What it requires (real scope increase — treat as its own subsystem, not an extension of presence broadcasting):**
- A lightweight per-language parser/call-graph pass (start with one language — do not attempt to be generic in v1) that extracts symbol definitions and references from each file as it's edited.
- A registry of "recently changed symbols" with enough history to be useful (not just live presence — Agent B may have already finished by the time Agent A gets there).
- A way for the client SDK to check this registry transparently — ideally server-side, automatically, as part of `editFile`/`readFile`, rather than requiring the agent to explicitly ask (see Section 8 on why enforcement beats instruction-based cooperation).
- A decision on enforcement strength: advisory (flag it, let validation/tests catch real breakage) vs. blocking (refuse the write until acknowledged). Defaults to advisory — set via `symbol_index.enforcement` in `.agent-sync.yml` (Section 7), not hard-coded, so this stays a per-project choice rather than an implicit decision baked into the Phase 8 implementation.

**Do not build this before Phases 1–4 (core CRDT sync, transparent tool wiring, flush, validation gate) are proven.** It is the single largest scope item in the project — closer to a lightweight incremental language server than to a sync protocol — and should be explicitly sequenced as a later phase (Section 7).

---

## 6. Disk flush, git integration, validation gate

- Flush triggers: explicit save event, debounce timer (2–5s inactivity), or manual CLI flush. Debounce length is a direct tradeoff against time-to-feedback: since validation only runs at flush, a longer window lets an agent stack further edits on top of an already-broken intermediate merge before anything catches it (Section 12) — don't tune this purely for commit noise.
- Normalize line endings explicitly at this layer (LF canonical internally; convert on flush per `.gitattributes`).
- Git commit boundary: after a successful flush **and** a passing validation gate. Start with commit-per-flush for traceability.
- Validation gate runs a configurable command (lint/typecheck/test) against the merged working tree before allowing a commit:
  - On failure with `reject_merge`: revert the flush, surface the failure back through the agent's normal tool-error path (Section 3.5), leave pre-flush state active so agents can retry against current reality.
  - On failure with `warn_only`: commit anyway but flag it — useful only during early development of the system itself, not for production use.
- Run the full test suite where feasible, not just checks scoped to the changed file — cross-file breakage (Agent A changes a signature, Agent B's file calls the old one) is exactly the failure mode a file-scoped check misses.

---

## 7. Config & partitioning

CLI command: `agent-sync init`, run once per repo. Produces `.agent-sync.yml`:

```yaml
server: ws://localhost:4600
paths:
  exclusive:
    - "package.json"
    - "src/schema.ts"
  ignore:
    - "node_modules/**"
    - "dist/**"
line_endings: lf
flush:
  debounce_ms: 3000
validation:
  command: "npm run lint && npm run typecheck && npm test"
  on_fail: reject_merge   # options: reject_merge | warn_only
symbol_index:
  enabled: false   # flip on once Phase 8 (Section 5) is built and validated
  language: typescript
  enforcement: advisory   # options: advisory | blocking — see Section 5. Explicit here so
                           # advisory-vs-blocking is a per-project config choice, not an
                           # implicit decision baked into the Phase 8 implementation.
```

- `exclusive` paths go through the lock service instead of pure CRDT merge — reserve for files where textual merging is likely to produce garbage.
- Everything else defaults to CRDT sync.
- `symbol_index.enforcement` defaults to `advisory` (flag a stale reference, let validation/tests catch real breakage) — set to `blocking` only once Phase 8 has been validated enough to trust rejecting a write outright, since `blocking` couples agent timing together in ways that fight the async spirit of the rest of the system (Section 5).

---

## 8. What still needs to go in agent instructions

Transparent tool rewiring (Section 3) removes the need to tell agents *which tool to call*. Self-describing rejection messages (Section 3.5) remove most of the need to tell agents *what a specific rejection means* — that guidance now travels inside the error text itself, in the same place the agent already looks. What's left, genuinely, is smaller than it first appeared:

- **Confirm, don't assume, that message-embedded guidance is sufficient.** Test whether agents reliably act on the instruction inside an `EAGAIN`/`ESTALE`-style message without any separate prompt guidance before writing anything custom — this may turn out to need nothing at all.
- **Patterns of repeated rejection, not a single one.** A single conflict's next step lives in the message. What to do after the *same* edit is rejected three times in a row (stop and escalate, vs. keep retrying blindly) is a judgment call the message can't carry and may warrant one line of instruction.
- **Symbol index findings, while `symbol_index.enforcement: advisory`** (Section 5, Section 7) — once flipped to `blocking`, a stale reference simply becomes an `ESTALE` rejection per Section 3.6 and this bullet no longer applies. Until then, an explicit instruction may be needed: "if a dependency-change notice is surfaced, re-verify the referenced symbol's current definition before proceeding."

Prefer moving each of these into enforced, automatic behavior in the SDK/server over time rather than growing this instruction list — an agent that must remember an instruction is a weaker guarantee than one that physically cannot bypass the check, and one that must decode an error message it already reads is weaker still than one that never sees an error, but far cheaper than either its own hand-written instruction file or a bypassable convention.

---

## 9. What this system guarantees vs. does not

**Guaranteed:**
- No lost writes — CRDT convergence ensures every replica reaches the same state regardless of operation order.
- No crashes/corruption from concurrent access.
- No manual merge-conflict markers — merges are automatic and deterministic.

**Not guaranteed — mitigated, not solved:**
- **Semantic correctness of merged code.** CRDT merge has no concept of meaning; two individually valid edits can combine into broken logic. Mitigated by the validation gate (Section 6), bounded by test coverage.
- **Cross-file consistency.** Mitigated by the symbol index (Section 5, best-effort) and by running the full test suite in the validation gate, not solved outright.
- **Logical/business-intent conflicts.** Two agents can each write reasonable code that, combined, implements contradictory intent. No merge algorithm detects this — only sufficient test coverage or a review step can.

State this section's contents plainly in any product documentation or README — this system solves the mechanical concurrency problem with a hard guarantee, and reduces (does not eliminate) the semantic-conflict problem.

---

## 10. Build phases (suggested order)

**Phase 1 — Core CRDT sync, single file, two test clients, no persistence, no real agents yet.** Prove convergence before building anything else.

**Phase 2 — Multi-file + presence awareness.** Arbitrary file paths, awareness channel, client reconnect/backoff.

**Phase 3 — Transparent tool interception + one real agent integration (Section 3).** Build and validate at least one MCP-based integration (3.2) and the hook-based mechanism (3.3b) for at least one CLI coding agent (Claude Code and/or Codex — both are confirmed to expose a usable `PreToolUse`/`PostToolUse` hook API, though tool names and payload shapes differ per agent). Hooks are the recommended default for these agents (zero install, no directory-navigation gap) and should ship before FUSE (3.3a), which is only needed for CLI agents with neither a hook API nor a rebindable registry. Treat 3.2 and 3.3b as two distinct mechanisms to prove in this phase, not one; scope 3.3a to a later phase unless a target agent genuinely requires it.

**Phase 4 — Disk flush + git commit + line-ending normalization.**

**Phase 5 — Validation gate.** Configurable lint/typecheck/test command, accept/reject flow, error-shape preservation (Section 3.5).

**Phase 6 — Lock service for declared exclusive files.**

**Phase 7 — CLI + config + dashboard.** `agent-sync init`, `.agent-sync.yml`, a basic "who's editing what" view from the awareness channel.

**Phase 8 — Symbol index / dependency-change awareness (Section 5).** Single language first. Do not start before Phases 1–5 are proven against real multi-agent usage.

**Phase 9 — Cross-platform packaging.** Single binary per OS (Node SEA or `pkg`), npm-published client SDK, install docs.

Do not start Phase 6 or Phase 8 until Phases 1–3 are proven against a real (not simulated) multi-agent scenario — both the CRDT merge behavior on actual code and the transparent tool-swap are the highest-risk unknowns and should be validated early.

---

## 11. Tech stack summary

| Piece | Recommendation | Why |
|---|---|---|
| Sync server | Node.js + Yjs | Most mature reference implementation of this pattern |
| Transport | WebSocket | Simple, cross-platform |
| Tool interception | MCP proxy for MCP-based agents (3.2); framework-native rebinding where a registry exists (3.3); pre/post-tool hooks for CLI agents that expose one, e.g. Claude Code (3.3b); FUSE/WinFsp only for CLI agents with neither (3.3a) | Four mechanisms for four agent categories, not one default with fallbacks — see 3.0. Hooks preferred over FUSE wherever both are technically possible. |
| Client SDK (v1) | TypeScript/npm | Matches most current agent frameworks |
| Client SDK (v2) | Python/PyPI | Second most common agent framework language |
| Git integration | `simple-git` (Node) or shell to system `git` | Consistent across OSes |
| Symbol index (Phase 8) | Language-specific parser (start with TypeScript's compiler API) | Needed for cross-file reference tracking; not generic across languages in v1 |
| Packaging | Node SEA or `pkg` | One binary per OS, no runtime dependency |

---

## 12. Known risks / open questions

- **Textual CRDT merge can produce syntactically valid but semantically wrong code.** Validation gate is the v1 mitigation; symbol index (Phase 8) reduces but doesn't eliminate this.
- **Debounce tuning matters — and affects more than commit noise.** In-memory CRDT merge correctness doesn't depend on flush timing, but the validation gate (Section 6) only runs *at* flush. A long debounce window means agents can keep editing on top of an already-broken intermediate merge for the entire window before validation ever runs and catches it — so debounce is really tuning *time-to-feedback* on semantic breakage, not just commit/validation-run frequency. Too eager causes excessive commits/validation runs; too long widens both the staleness window (Section 12, other agents seeing current state) and the window where broken state can accumulate further edits before anyone finds out. Consider a bound on this independent of debounce — e.g. always flush-and-validate before a symbol-index-flagged file gets a second edit — rather than relying on debounce timing alone to catch it promptly.
- **Presence/symbol-index data is advisory unless explicitly enforced server-side.** Nothing stops an agent from acting before checking it; the CRDT merge must stay correct regardless of whether any agent ever looks at awareness data.
- **Lock TTL sizing** — too short causes false expiry mid-edit; too long blocks unnecessarily on a crashed peer. Make configurable per project.
- **Framework coverage for transparent interception varies by category, not by maturity — see Section 3.0's decision table.** The generic MCP proxy (3.2) covers agents that expose file ops as MCP tools. LangChain-style tool registration (3.3) covers frameworks with a rebindable registry. CLI coding agents with a pre/post-tool hook API — Claude Code (`PreToolUse`/`PostToolUse` on Edit/Write), Codex (`PreToolUse`/`PostToolUse` on `apply_patch`), and any equivalent — are covered by the hook mechanism (3.3b); prefer this over FUSE, since it needs no system install and has no directory-navigation gap. Codex's `PreToolUse` additionally supports outright denial, which is stronger than a passive pre-sync; but Codex's documented tool coverage has no listed hook path for plain file reads, a real gap worth confirming before assuming read-freshness parity with Claude Code (3.3b). Only CLI agents with neither a hook API nor a registry need the FUSE/WinFsp driver (3.3a), which as of this writing has two real blockers to production readiness: it requires the end user to enable a kernel extension (macFUSE) via a system-security setting, and the driver only implements the syscalls needed to prove per-file merge semantics (`open`/`read`/`write`/`truncate`/`flush`/`release`/`unlink`) — no `readdir`/`mkdir`/`rename` yet, so directory browsing on the mount currently fails. Audit target agents against the 3.0 table early, and confirm each agent's current hook documentation directly rather than assuming parity across agents.
