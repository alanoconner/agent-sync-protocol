import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type ValidationOnFail = "reject_merge" | "warn_only";

export interface ValidationGateOptions {
  /** Shell command to run against the merged working tree — lint/typecheck/test, per spec Section 6. */
  command: string;
  onFail: ValidationOnFail;
  /** Directory the command runs in — the repo root, so it sees whatever was just flushed to disk. */
  cwd: string;
}

export interface ValidationOutcome {
  passed: boolean;
  /** Combined stdout+stderr, for the rejection message and for logging. */
  output: string;
}

/**
 * Runs the configured validation command (spec Section 6) and reports
 * pass/fail. Deliberately knows nothing about git, flushing, or the sync
 * layer — {@link DiskFlushService} is what decides what to do with the
 * result (commit, revert, warn); this class is just "run the command,
 * report what happened," so it's unit-testable with a plain shell command
 * and reusable outside a flush (e.g. a future `agent-sync validate` CLI).
 */
export class ValidationGateService {
  readonly command: string;
  readonly onFail: ValidationOnFail;
  private readonly cwd: string;

  constructor(options: ValidationGateOptions) {
    this.command = options.command;
    this.onFail = options.onFail;
    this.cwd = options.cwd;
  }

  async run(): Promise<ValidationOutcome> {
    try {
      const { stdout, stderr } = await execAsync(this.command, { cwd: this.cwd });
      return { passed: true, output: `${stdout}${stderr}` };
    } catch (err) {
      const failure = err as { stdout?: string; stderr?: string; message: string };
      const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      return { passed: false, output: output || failure.message };
    }
  }
}
