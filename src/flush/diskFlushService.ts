import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { DocHydratedEvent, DocUpdateEvent, SyncServer } from "../server/syncServer.js";
import { fromLf, type LineEndingStyle } from "../sync/lineEndings.js";
import type { SyncedFileState } from "../sync/fileState.js";
import { ValidationGateService } from "../validation/validationGateService.js";

export interface DiskFlushServiceOptions {
  server: SyncServer;
  /** Working tree root every doc name is resolved relative to — must already be a git repo (or one initialized by the caller). */
  repoRoot: string;
  /** Inactivity window after a doc's last edit before it's auto-flushed. Spec Section 6 suggests 2–5s: a direct tradeoff against time-to-feedback — validation (below) only runs at flush, so a longer window lets agents stack further edits on an already-broken merge before anything catches it. */
  debounceMs?: number;
  /** `.gitattributes`-driven style selection is Phase 7 territory; for now this is an explicit, per-instance choice. Defaults to "lf" (no conversion). */
  lineEndings?: LineEndingStyle;
  /** Set false to disable the debounce-timer auto-flush entirely and drive everything through flushPath()/flushAll() instead — mainly for tests that want deterministic control over when a flush happens. */
  autoFlush?: boolean;
  /** Inject a pre-configured SimpleGit (e.g. with committer identity already set) — mainly for tests. Defaults to `simpleGit(repoRoot)`. */
  git?: SimpleGit;
  /** Phase 5 (spec Section 6): configurable lint/typecheck/test gate run against the working tree between writing a flush to disk and committing it. Omit to keep Phase 4's unconditional-commit behavior. */
  validation?: ValidationGateService;
}

function isNothingToCommitError(err: unknown): boolean {
  return err instanceof Error && /nothing to commit/i.test(err.message);
}

function formatRejectionMessage(command: string): string {
  // Verbatim per spec Section 3.6's recommended template for EVALIDATE.
  return `Write rejected: the combined change failed validation (\`${command}\`). Re-read the current file state before retrying.`;
}

function sameState(a: SyncedFileState | undefined, b: SyncedFileState | undefined): boolean {
  return a?.exists === b?.exists && a?.content === b?.content;
}

/**
 * Debounced disk flush + git commit-per-flush (spec Section 6), with LF
 * content converted to the configured on-disk line-ending style at the
 * moment it's written, and — once `validation` is configured (Phase 5) — a
 * configurable lint/typecheck/test command gating the commit.
 *
 * Listens to `SyncServer`'s `docUpdate` event rather than opening its own
 * `SyncClient` per doc — the server already holds the canonical in-memory
 * content for every room, so a redundant client connection would just be
 * another network hop to reach data already in process.
 */
export class DiskFlushService {
  private readonly server: SyncServer;
  private readonly repoRoot: string;
  private readonly debounceMs: number;
  private readonly lineEndings: LineEndingStyle;
  private readonly autoFlush: boolean;
  private readonly git: SimpleGit;
  private readonly validation: ValidationGateService | undefined;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastFlushedState = new Map<string, SyncedFileState>();
  /** Logical state last seen via `docUpdate`, distinct from the last flushed state, so metadata-only document updates do not re-trigger validation forever. */
  private readonly lastSeenState = new Map<string, SyncedFileState>();
  private readonly onDocUpdate: (event: DocUpdateEvent) => void;
  private readonly onDocHydrated: (event: DocHydratedEvent) => void;
  /**
   * Serializes every flush (auto or manual) through one queue, regardless of
   * which doc it's for. Two docs' debounce timers can legitimately fire
   * moments apart; without this, their flushes would run the validation
   * command and `git commit` concurrently against the same working tree —
   * fine for Phase 4's instant commits, but validation can take seconds,
   * widening that race into a real "index.lock already exists" failure.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: DiskFlushServiceOptions) {
    this.server = options.server;
    this.repoRoot = resolve(options.repoRoot);
    this.debounceMs = options.debounceMs ?? 3000;
    this.lineEndings = options.lineEndings ?? "lf";
    this.autoFlush = options.autoFlush ?? true;
    this.git = options.git ?? simpleGit(this.repoRoot);
    this.validation = options.validation;

    this.onDocUpdate = ({ docName, exists, content }) => {
      const state = { exists, content };
      if (sameState(this.lastSeenState.get(docName), state)) return;
      this.lastSeenState.set(docName, state);
      if (this.autoFlush) this.scheduleFlush(docName);
    };
    this.server.on("docUpdate", this.onDocUpdate);

    // Hydrated content came *from* disk (see createDiskHydrator), so it is by
    // definition already flushed — prime both trackers so neither the first
    // `docUpdate` nor a manual `flushAll()` re-writes and re-commits the same
    // bytes. Whether that on-disk content was itself committed is not this
    // service's concern: the next real edit will `git add` the whole file.
    this.onDocHydrated = ({ docName, exists, content }) => {
      const state = { exists, content };
      this.lastSeenState.set(docName, state);
      this.lastFlushedState.set(docName, state);
    };
    this.server.on("docHydrated", this.onDocHydrated);
  }

  private scheduleFlush(docName: string): void {
    const existing = this.timers.get(docName);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(docName);
      this.flushPath(docName).catch((err) => {
        // A flush failure (disk/git) shouldn't crash the server, but shouldn't
        // vanish either — surface it the same way the rest of this codebase
        // surfaces async status (an Observable event), not a console.log.
        this.server.emit("flushError", [{ docName, error: err }]);
      });
    }, this.debounceMs);
    this.timers.set(docName, timer);
  }

  /**
   * Flushes one doc's current content to disk, gates it through the
   * validation command if one is configured, and commits it — cancelling
   * any pending debounce timer for it. Queued behind any flush already in
   * progress (see `queue` above). A no-op if the doc's content is identical
   * to what was last successfully flushed.
   */
  flushPath(docName: string): Promise<void> {
    const timer = this.timers.get(docName);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(docName);
    }
    const run = this.queue.then(
      () => this.doFlush(docName),
      () => this.doFlush(docName), // an earlier flush's rejection shouldn't jam the queue for this one
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doFlush(docName: string): Promise<void> {
    const state = this.server.getDocState(docName);
    if (state === undefined) return; // room no longer exists
    if (sameState(this.lastFlushedState.get(docName), state)) return;

    const absPath = this.resolveWithinRepo(docName);
    // Roll back exactly what this flush replaced, without touching Git's index.
    // Only ENOENT proves this was a new file; all other read errors abort.
    let previousContent: Buffer | undefined;
    try {
      previousContent = await readFile(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (state.exists) {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, fromLf(state.content, this.lineEndings), "utf8");
    } else {
      await rm(absPath, { force: true });
    }

    if (this.validation) {
      const result = await this.validation.run();
      if (!result.passed) {
        if (this.validation.onFail === "reject_merge") {
          // Restore the pre-flush disk state; the live CRDT remains untouched.
          await this.revertDiskWrite(absPath, previousContent);
          this.server.setValidationRejection(docName, formatRejectionMessage(this.validation.command));
          this.server.emit("validationRejected", [
            { docName, command: this.validation.command, output: result.output },
          ]);
          return;
        }
        // warn_only: commit anyway, but make sure the failure isn't silent.
        this.server.emit("validationWarning", [
          { docName, command: this.validation.command, output: result.output },
        ]);
      } else {
        this.server.clearValidationRejection(docName);
      }
    }

    const pathspec = `:(literal)${docName}`;
    await this.git.add(["--", pathspec]);
    try {
      // Commit-per-flush per spec Section 6, for traceability of which agent's
      // edit landed when — squashing/rebasing this history is a later concern.
      await this.git.commit(`agent-sync: ${state.exists ? "flush" : "delete"} ${docName}`, [pathspec], { "--only": null });
    } catch (err) {
      // The write above can still be a no-op from git's point of view (e.g.
      // content flushed once already got hand-committed outside this
      // service) — that's not a flush failure.
      if (!isNothingToCommitError(err)) throw err;
    }
    this.lastFlushedState.set(docName, state);
  }

  /** Undo only this flush, preserving pre-existing uncommitted content and staging. */
  private async revertDiskWrite(absPath: string, previousContent: Buffer | undefined): Promise<void> {
    if (previousContent === undefined) {
      await rm(absPath, { force: true });
    } else {
      await writeFile(absPath, previousContent);
    }
  }

  /** Flushes every currently active doc — the manual "CLI flush" path from spec Section 6. */
  async flushAll(): Promise<void> {
    for (const docName of this.server.getDocNames()) {
      await this.flushPath(docName);
    }
  }

  /** Docs whose live CRDT content has not reached a successful disk/Git flush yet. */
  getPendingDocNames(): string[] {
    return this.server.getDocNames().filter((docName) => !sameState(this.lastFlushedState.get(docName), this.server.getDocState(docName)));
  }

  private resolveWithinRepo(docName: string): string {
    const absPath = resolve(this.repoRoot, docName);
    const rel = relative(this.repoRoot, absPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`refusing to flush doc name "${docName}" outside the repo root`);
    }
    return absPath;
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.server.off("docUpdate", this.onDocUpdate);
    this.server.off("docHydrated", this.onDocHydrated);
  }
}
