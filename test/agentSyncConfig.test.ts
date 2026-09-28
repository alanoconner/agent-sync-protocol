import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_YAML,
  loadAgentSyncConfigFile,
  loadAgentSyncConfigOrDefault,
  parseAgentSyncConfig,
  resolveSyncFileOpsOptions,
  writeDefaultConfig,
} from "../src/config/agentSyncConfig.js";

describe("Phase 7: .agent-sync.yml config (Section 7)", () => {
  it("an empty document parses to the same defaults agent-sync init writes", () => {
    expect(parseAgentSyncConfig("")).toEqual(DEFAULT_CONFIG);
  });

  it("the exact file agent-sync init writes parses back to the defaults", () => {
    expect(parseAgentSyncConfig(DEFAULT_CONFIG_YAML)).toEqual(DEFAULT_CONFIG);
  });

  it("parses a fully-specified config", () => {
    const yaml = `
server: ws://sync.internal:5000
paths:
  exclusive:
    - "package.json"
    - "src/schema.ts"
  ignore:
    - "node_modules/**"
line_endings: crlf
flush:
  debounce_ms: 2000
worktrees:
  auto_install: false
  setup_command: "corepack pnpm install --frozen-lockfile"
validation:
  command: "npm run lint && npm test"
  on_fail: warn_only
symbol_index:
  enabled: true
  language: python
  enforcement: blocking
`;
    expect(parseAgentSyncConfig(yaml)).toEqual({
      server: "ws://sync.internal:5000",
      paths: { exclusive: ["package.json", "src/schema.ts"], ignore: ["node_modules/**"] },
      lineEndings: "crlf",
      flush: { debounceMs: 2000 },
      worktrees: { autoInstall: false, setupCommand: "corepack pnpm install --frozen-lockfile" },
      validation: { command: "npm run lint && npm test", onFail: "warn_only" },
      symbolIndex: { enabled: true, language: "python", enforcement: "blocking" },
    });
  });

  it("validation.on_fail defaults to reject_merge when omitted", () => {
    const config = parseAgentSyncConfig(`validation:\n  command: "npm test"\n`);
    expect(config.validation).toEqual({ command: "npm test", onFail: "reject_merge" });
  });

  it("rejects an unrecognized line_endings value", () => {
    expect(() => parseAgentSyncConfig("line_endings: crlf-ish")).toThrow(/line_endings/);
  });

  it("rejects a non-numeric flush.debounce_ms", () => {
    expect(() => parseAgentSyncConfig("flush:\n  debounce_ms: soon\n")).toThrow(/debounce_ms/);
  });

  it("validates worktree setup configuration", () => {
    expect(() => parseAgentSyncConfig("worktrees:\n  auto_install: yes\n")).toThrow(/auto_install/);
    expect(() => parseAgentSyncConfig("worktrees:\n  setup_command: ''\n")).toThrow(/setup_command/);
  });

  it("rejects a non-list paths.exclusive", () => {
    expect(() => parseAgentSyncConfig("paths:\n  exclusive: schema.ts\n")).toThrow(/exclusive/);
  });

  it("rejects validation with no command", () => {
    expect(() => parseAgentSyncConfig("validation:\n  on_fail: warn_only\n")).toThrow(/command/);
  });

  it("rejects an unrecognized validation.on_fail", () => {
    expect(() => parseAgentSyncConfig('validation:\n  command: "npm test"\n  on_fail: maybe\n')).toThrow(/on_fail/);
  });

  it("rejects a document that isn't a mapping", () => {
    expect(() => parseAgentSyncConfig("- just\n- a\n- list\n")).toThrow(/mapping/);
  });
});

describe("Phase 7: config file read/write helpers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-sync-config-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writeDefaultConfig creates the file, then refuses to overwrite without --force", () => {
    const path = join(dir, ".agent-sync.yml");
    expect(writeDefaultConfig(path)).toEqual({ written: true });
    expect(loadAgentSyncConfigFile(path)).toEqual(DEFAULT_CONFIG);

    expect(writeDefaultConfig(path)).toEqual({ written: false });
    expect(writeDefaultConfig(path, true)).toEqual({ written: true });
  });

  it("loadAgentSyncConfigOrDefault falls back to defaults when the file doesn't exist", () => {
    const path = join(dir, "does-not-exist.yml");
    expect(loadAgentSyncConfigOrDefault(path)).toEqual(DEFAULT_CONFIG);
  });
});

describe("resolveSyncFileOpsOptions — .agent-sync.yml → SyncFileOps options (Phase 7 wiring)", () => {
  const config = parseAgentSyncConfig(`
server: ws://sync.internal:5000
paths:
  exclusive: ["package.json"]
`);

  it("takes the server URL and exclusive paths from the config when nothing is overridden", () => {
    expect(resolveSyncFileOpsOptions(config)).toEqual({
      serverUrl: "ws://sync.internal:5000",
      exclusivePaths: ["package.json"],
      ownerId: undefined,
      lockLeaseMs: undefined,
    });
  });

  it("explicit overrides win over the config, and exclusivePaths replaces rather than merges", () => {
    const resolved = resolveSyncFileOpsOptions(config, {
      syncServerUrl: "ws://localhost:1",
      exclusivePaths: ["src/schema.ts"],
      ownerId: "agent-x",
      lockLeaseMs: 500,
    });
    expect(resolved).toEqual({ serverUrl: "ws://localhost:1", exclusivePaths: ["src/schema.ts"], ownerId: "agent-x", lockLeaseMs: 500 });
  });

  it("works with no config at all when the URL is given explicitly (the pre-Phase-7 calling convention)", () => {
    expect(resolveSyncFileOpsOptions(undefined, { syncServerUrl: "ws://localhost:2" })).toEqual({
      serverUrl: "ws://localhost:2",
      exclusivePaths: [],
      ownerId: undefined,
      lockLeaseMs: undefined,
    });
  });

  it("refuses to guess a server URL when neither source provides one", () => {
    expect(() => resolveSyncFileOpsOptions(undefined, {})).toThrow(/sync server URL/);
  });
});
