export {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_YAML,
  loadAgentSyncConfigFile,
  loadAgentSyncConfigOrDefault,
  parseAgentSyncConfig,
  resolveSyncFileOpsOptions,
  writeDefaultConfig,
} from "./config/agentSyncConfig.js";
export type {
  AgentSyncConfig,
  LineEndingStyle,
  SymbolIndexEnforcement,
  SyncFileOpsOverrides,
} from "./config/agentSyncConfig.js";
