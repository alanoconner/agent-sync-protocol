import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { load } from "js-yaml";
import type { ValidationOnFail } from "../validation/validationGateService.js";
import type { SyncFileOpsOptions } from "../sync/syncFileOps.js";

export type LineEndingStyle = "lf" | "crlf";
export type SymbolIndexEnforcement = "advisory" | "blocking";

export interface AgentSyncConfig {
  server: string;
  paths: {
    exclusive: string[];
    ignore: string[];
  };
  lineEndings: LineEndingStyle;
  flush: {
    debounceMs: number;
  };
  worktrees: {
    autoInstall: boolean;
    setupCommand?: string;
  };
  /** Absent means "no validation gate configured" — Phase 5's `DiskFlushService` behavior with no `validation` option passed at all. */
  validation?: {
    command: string;
    onFail: ValidationOnFail;
  };
  symbolIndex: {
    enabled: boolean;
    language: string;
    enforcement: SymbolIndexEnforcement;
  };
}

export const CONFIG_FILE_NAME = ".agent-sync.yml";

export const DEFAULT_CONFIG: AgentSyncConfig = {
  server: "ws://localhost:4600",
  paths: { exclusive: [], ignore: ["node_modules/**", "dist/**"] },
  lineEndings: "lf",
  flush: { debounceMs: 3000 },
  worktrees: { autoInstall: true, setupCommand: undefined },
  validation: undefined,
  symbolIndex: { enabled: false, language: "typescript", enforcement: "advisory" },
};

/**
 * What `agent-sync init` writes. `validation` is left commented out rather
 * than filled with a guessed command (e.g. "npm test") — unlike the rest of
 * this config, a wrong guess here doesn't just fall back to a sane default,
 * it's a shell command that would actually run against the repo on every
 * flush, so it needs an explicit opt-in.
 */
export const DEFAULT_CONFIG_YAML = `# agent-sync configuration (see agent-sync-dev-spec.md Section 7)
server: ${DEFAULT_CONFIG.server}

paths:
  # Files that go through the lock service instead of relying on CRDT merge
  # alone — reserve for files where textual merging is likely to produce
  # garbage (shared config, generated schema files, lockfiles).
  exclusive: []
  ignore:
    - "node_modules/**"
    - "dist/**"

line_endings: ${DEFAULT_CONFIG.lineEndings}

flush:
  debounce_ms: ${DEFAULT_CONFIG.flush.debounceMs}

worktrees:
  # Install dependencies in each managed worktree when a known lockfile is present.
  auto_install: true
  # setup_command: "npm ci"   # Overrides lockfile detection when set.

# Uncomment and set a real command to gate commits behind lint/typecheck/test.
# validation:
#   command: "npm run lint && npm run typecheck && npm test"
#   on_fail: reject_merge   # reject_merge | warn_only

symbol_index:
  enabled: false   # flip on once Phase 8 (Section 5) is built and validated
  language: typescript
  enforcement: advisory   # advisory | blocking
`;

function readObject(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = raw[key];
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`"${key}" must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function readString(raw: Record<string, unknown>, key: string, fallback: string): string {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) throw new Error(`"${key}" must be a non-empty string`);
  return value;
}

function readNumber(raw: Record<string, unknown>, key: string, fallback: number): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`"${key}" must be a number`);
  return value;
}

function readBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`"${key}" must be a boolean`);
  return value;
}

function readStringArray(raw: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`"${key}" must be a list of strings`);
  }
  return value as string[];
}

function readEnum<T extends string>(raw: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T): T {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`"${key}" must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function parseValidation(raw: unknown): AgentSyncConfig["validation"] {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`"validation" must be a mapping with a "command"`);
  const v = raw as Record<string, unknown>;
  const command = readString(v, "command", "");
  if (command === "") throw new Error(`"validation.command" must be a non-empty string`);
  const onFail = readEnum(v, "on_fail", ["reject_merge", "warn_only"] as const, "reject_merge");
  return { command, onFail };
}

function readOptionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`"${key}" must be a non-empty string`);
  return value;
}

/**
 * Parses a `.agent-sync.yml`-shaped document (Section 7). Unlike
 * `.agent-sync-mcp-map.yml` (Section 3.2), every field here has a sane
 * default that `agent-sync init` itself writes — a missing field just means
 * "use the suggested default," never an ambiguous guess about tool
 * behavior — so a partial, hand-edited config is fine. A field that's present
 * but wrong-typed is still a hard error rather than silently ignored.
 */
export function parseAgentSyncConfig(yamlText: string): AgentSyncConfig {
  const parsed = yamlText.trim() === "" ? {} : (load(yamlText) ?? {});
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("agent-sync config must be a YAML mapping");
  const raw = parsed as Record<string, unknown>;

  const pathsRaw = readObject(raw, "paths");
  const flushRaw = readObject(raw, "flush");
  const worktreesRaw = readObject(raw, "worktrees");
  const symbolIndexRaw = readObject(raw, "symbol_index");

  return {
    server: readString(raw, "server", DEFAULT_CONFIG.server),
    paths: {
      exclusive: readStringArray(pathsRaw, "exclusive", DEFAULT_CONFIG.paths.exclusive),
      ignore: readStringArray(pathsRaw, "ignore", DEFAULT_CONFIG.paths.ignore),
    },
    lineEndings: readEnum(raw, "line_endings", ["lf", "crlf"] as const, DEFAULT_CONFIG.lineEndings),
    flush: { debounceMs: readNumber(flushRaw, "debounce_ms", DEFAULT_CONFIG.flush.debounceMs) },
    worktrees: {
      autoInstall: readBoolean(worktreesRaw, "auto_install", DEFAULT_CONFIG.worktrees.autoInstall),
      setupCommand: readOptionalString(worktreesRaw, "setup_command"),
    },
    validation: parseValidation(raw.validation),
    symbolIndex: {
      enabled: readBoolean(symbolIndexRaw, "enabled", DEFAULT_CONFIG.symbolIndex.enabled),
      language: readString(symbolIndexRaw, "language", DEFAULT_CONFIG.symbolIndex.language),
      enforcement: readEnum(symbolIndexRaw, "enforcement", ["advisory", "blocking"] as const, DEFAULT_CONFIG.symbolIndex.enforcement),
    },
  };
}

export function loadAgentSyncConfigFile(path: string): AgentSyncConfig {
  return parseAgentSyncConfig(readFileSync(path, "utf8"));
}

/** Loads `path` if it exists, otherwise returns the same defaults `agent-sync init` would write. */
export function loadAgentSyncConfigOrDefault(path: string): AgentSyncConfig {
  return existsSync(path) ? loadAgentSyncConfigFile(path) : DEFAULT_CONFIG;
}

/** The explicit, in-code half of a `SyncFileOps` setup — what `McpSyncProxyOptions`/`MountOptions`/the hook bridge each accept alongside an optional parsed `.agent-sync.yml`. */
export interface SyncFileOpsOverrides {
  /** Sync server URL. Required when no `config` is given; otherwise overrides `config.server`. */
  syncServerUrl?: string;
  /** Replaces (does not merge with) `config.paths.exclusive` when given. */
  exclusivePaths?: string[];
  ownerId?: string;
  lockLeaseMs?: number;
}

/**
 * The one place `.agent-sync.yml` is turned into `SyncFileOps` options, so
 * the MCP proxy, the FUSE mount, and the hook bridge all read `server` and
 * `paths.exclusive` the same way rather than each open-coding it. Explicit
 * overrides win over the config; the config wins over nothing (a missing
 * `config` just means every field must come from `overrides`). A server URL
 * from neither source is a hard error, not a guessed `localhost:4600` — that
 * default belongs to `DEFAULT_CONFIG`, and a caller that wants it should pass
 * `DEFAULT_CONFIG` (or `loadAgentSyncConfigOrDefault`'s result) explicitly.
 */
export function resolveSyncFileOpsOptions(config: AgentSyncConfig | undefined, overrides: SyncFileOpsOverrides = {}): SyncFileOpsOptions {
  const serverUrl = overrides.syncServerUrl ?? config?.server;
  if (!serverUrl) {
    throw new Error(`no sync server URL: pass syncServerUrl explicitly or a parsed ${CONFIG_FILE_NAME} config with "server" set`);
  }
  return {
    serverUrl,
    exclusivePaths: overrides.exclusivePaths ?? config?.paths.exclusive ?? [],
    ownerId: overrides.ownerId,
    lockLeaseMs: overrides.lockLeaseMs,
  };
}

/** Writes the default config to `path` — `agent-sync init`. Refuses to clobber an existing file unless `force`. */
export function writeDefaultConfig(path: string, force = false): { written: boolean } {
  if (existsSync(path) && !force) return { written: false };
  writeFileSync(path, DEFAULT_CONFIG_YAML, "utf8");
  return { written: true };
}
