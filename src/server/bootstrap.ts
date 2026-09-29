import { SyncServer } from "./syncServer.js";
import { DiskFlushService } from "../flush/diskFlushService.js";
import { createDiskHydrator } from "../flush/diskHydration.js";
import type { LineEndingStyle } from "../sync/lineEndings.js";
import { ValidationGateService, type ValidationOnFail } from "../validation/validationGateService.js";
import { CrdtStore, defaultCrdtPersistenceDir } from "../persistence/crdtStore.js";

export interface StartServerOptions {
  port: number;
  host?: string;
  /** When set, wires up Phase 4's disk flush (and Phase 5's validation gate, if `validation` is also set) against this directory. Omitted means zero persistence, matching every phase before Phase 4. */
  repoRoot?: string;
  flushDebounceMs?: number;
  /** On-disk line-ending style at flush time (`.agent-sync.yml`'s `line_endings`). Defaults to "lf". */
  lineEndings?: LineEndingStyle;
  validation?: { command: string; onFail: ValidationOnFail };
  /** Overrides the durable CRDT store location. Repo-backed servers enable persistence automatically. */
  persistenceDir?: string;
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
  return createAgentSyncRuntime(options).server;
}

export interface AgentSyncRuntime {
  server: SyncServer;
  flushAll(): Promise<{ pending: string[] }>;
  close(options?: { flush?: boolean }): Promise<{ pending: string[] }>;
}

/** Lifecycle-aware variant used by the managed ASL daemon. */
export function createAgentSyncRuntime(options: StartServerOptions): AgentSyncRuntime {
  const log = options.log ?? console.log;
  const persistence = options.repoRoot
    ? new CrdtStore(options.persistenceDir ?? defaultCrdtPersistenceDir(options.repoRoot))
    : undefined;
  // With a repo root, a room's first creation seeds it from the working tree
  // (disk→CRDT); without one, rooms start empty, as in every phase before 4.
  const server = new SyncServer(options.port, {
    host: options.host,
    hydrate: options.repoRoot ? createDiskHydrator(options.repoRoot) : undefined,
    persistence,
  });

  if (!options.repoRoot) {
    log(`agent-sync server listening on ws://localhost:${options.port}`);
    return {
      server,
      flushAll: async () => ({ pending: [] }),
      close: async () => {
        await server.close();
        return { pending: [] };
      },
    };
  }

  const validation = options.validation
    ? new ValidationGateService({ command: options.validation.command, onFail: options.validation.onFail, cwd: options.repoRoot })
    : undefined;

  const flush = new DiskFlushService({
    server,
    repoRoot: options.repoRoot,
    debounceMs: options.flushDebounceMs,
    lineEndings: options.lineEndings,
    validation,
  });
  try {
    server.preloadPersistedDocNames();
  } catch (error) {
    flush.close();
    void server.close().catch(() => persistence?.close());
    throw error;
  }
  log(`agent-sync server listening on ws://localhost:${options.port}`);
  log(`agent-sync: hydrating rooms from and flushing to ${options.repoRoot} (debounce ${options.flushDebounceMs ?? 3000}ms, line endings ${options.lineEndings ?? "lf"})`);
  log(`agent-sync: durable CRDT snapshots at ${persistence!.root}`);
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

  return {
    server,
    flushAll: async () => {
      await flush.flushAll();
      return { pending: flush.getPendingDocNames() };
    },
    close: async ({ flush: shouldFlush = true } = {}) => {
      if (shouldFlush) await flush.flushAll();
      const pending = flush.getPendingDocNames();
      if (shouldFlush && pending.length > 0) return { pending };
      flush.close();
      await server.close();
      return { pending };
    },
  };
}
