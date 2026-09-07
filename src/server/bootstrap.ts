import { SyncServer } from "./syncServer.js";
import { DiskFlushService } from "../flush/diskFlushService.js";
import { ValidationGateService, type ValidationOnFail } from "../validation/validationGateService.js";

export interface StartServerOptions {
  port: number;
  /** When set, wires up Phase 4's disk flush (and Phase 5's validation gate, if `validation` is also set) against this directory. Omitted means zero persistence, matching every phase before Phase 4. */
  repoRoot?: string;
  flushDebounceMs?: number;
  validation?: { command: string; onFail: ValidationOnFail };
  log?: (message: string) => void;
}

/**
 * Builds a `SyncServer` and, if `repoRoot` is given, wires `DiskFlushService`
 * (+ `ValidationGateService`) in front of it — the same setup `npm run
 * server`'s env-var-driven binary ([index.ts](index.ts)) and the Phase 7 CLI's
 * `agent-sync server` (config-file-driven) both need, so it lives here once
 * rather than being duplicated between them.
 */
export function startAgentSyncServer(options: StartServerOptions): SyncServer {
  const log = options.log ?? console.log;
  const server = new SyncServer(options.port);
  log(`agent-sync server listening on ws://localhost:${options.port}`);

  if (!options.repoRoot) return server;

  const validation = options.validation
    ? new ValidationGateService({ command: options.validation.command, onFail: options.validation.onFail, cwd: options.repoRoot })
    : undefined;

  new DiskFlushService({ server, repoRoot: options.repoRoot, debounceMs: options.flushDebounceMs, validation });
  log(`agent-sync: flushing to ${options.repoRoot} (debounce ${options.flushDebounceMs ?? 3000}ms)`);
  if (validation) log(`agent-sync: validation gate "${options.validation!.command}" (on_fail: ${options.validation!.onFail})`);

  server.on("flushError", ({ docName, error }: { docName: string; error: unknown }) => {
    console.error(`agent-sync: flush failed for "${docName}":`, error);
  });
  server.on("validationRejected", ({ docName, command, output }: { docName: string; command: string; output: string }) => {
    console.error(`agent-sync: validation rejected flush of "${docName}" (${command}):\n${output}`);
  });
  server.on("validationWarning", ({ docName, command, output }: { docName: string; command: string; output: string }) => {
    console.warn(`agent-sync: validation failed for "${docName}" (${command}) but committing anyway (warn_only):\n${output}`);
  });

  return server;
}
