import { startAgentSyncServer } from "./bootstrap.js";
import type { ValidationOnFail } from "../validation/validationGateService.js";

// Config-file-driven setup (.agent-sync.yml, Phase 7) is what `agent-sync
// server` uses (see ../cli/index.ts). This binary predates that file and
// stays env-var-driven so `npm run server` keeps working standalone with no
// config file needed — both paths funnel into the same startAgentSyncServer.
const port = Number(process.env.PORT ?? 4600);
const repoRoot = process.env.AGENT_SYNC_REPO_ROOT;
const flushDebounceMs = process.env.AGENT_SYNC_FLUSH_DEBOUNCE_MS ? Number(process.env.AGENT_SYNC_FLUSH_DEBOUNCE_MS) : undefined;
const validateCommand = process.env.AGENT_SYNC_VALIDATE_COMMAND;
const onFail: ValidationOnFail = process.env.AGENT_SYNC_VALIDATE_ON_FAIL === "warn_only" ? "warn_only" : "reject_merge";

startAgentSyncServer({
  port,
  repoRoot,
  flushDebounceMs,
  validation: validateCommand ? { command: validateCommand, onFail } : undefined,
});
