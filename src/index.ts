export { SyncClient } from "./client/SyncClient.js";
export type { ConnectionStatus, ReconnectOptions, SyncClientOptions } from "./client/SyncClient.js";
export {
  FileNotFoundError,
  LockDeniedError,
  RangeMismatchError,
  SyncFileOps,
  ValidationRejectedError,
} from "./sync/syncFileOps.js";
export type { SyncFileOpsOptions } from "./sync/syncFileOps.js";
export type { SyncedFileState } from "./sync/fileState.js";
