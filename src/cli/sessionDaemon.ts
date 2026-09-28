import { createServer, type ServerResponse } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createAgentSyncRuntime } from "../server/bootstrap.js";
import { CONFIG_FILE_NAME, loadAgentSyncConfigOrDefault } from "../config/agentSyncConfig.js";
import { daemonPath, knownDocsPath, readSession, writeJsonAtomic, type DaemonState } from "./sessionState.js";
import { join } from "node:path";

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export async function runSessionDaemon(stateDir: string): Promise<void> {
  const session = readSession(stateDir);
  if (!session) throw new Error(`no ASL session manifest at ${stateDir}`);
  const config = loadAgentSyncConfigOrDefault(join(session.integrationWorktree, CONFIG_FILE_NAME));
  const runtime = createAgentSyncRuntime({
    port: 0,
    host: "127.0.0.1",
    repoRoot: session.integrationWorktree,
    flushDebounceMs: config.flush.debounceMs,
    lineEndings: config.lineEndings,
    validation: config.validation,
  });
  await runtime.server.whenListening();

  if (existsSync(knownDocsPath(stateDir))) {
    try { runtime.server.preloadDocNames(JSON.parse(readFileSync(knownDocsPath(stateDir), "utf8")) as string[]); }
    catch { /* a corrupt cache must not prevent session recovery */ }
  }

  let closing = false;
  const persistKnownDocs = () => writeJsonAtomic(knownDocsPath(stateDir), runtime.server.getDocNames());
  const knownDocsTimer = setInterval(persistKnownDocs, 1000);
  knownDocsTimer.unref();

  const control = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${session.controlToken}`) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method === "GET" && req.url === "/status") {
      json(res, 200, { sessionId: session.sessionId, pid: process.pid, pending: [] });
      return;
    }
    if (req.method === "POST" && req.url === "/flush") {
      try {
        const result = await runtime.flushAll();
        persistKnownDocs();
        json(res, result.pending.length === 0 ? 200 : 409, result);
      } catch (error) { json(res, 500, { error: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (req.method === "POST" && req.url === "/shutdown") {
      if (closing) { json(res, 409, { error: "shutdown already in progress" }); return; }
      closing = true;
      try {
        const result = await runtime.close({ flush: true });
        persistKnownDocs();
        if (result.pending.length > 0) {
          closing = false;
          json(res, 409, result);
          return;
        }
        clearInterval(knownDocsTimer);
        rmSync(daemonPath(stateDir), { force: true });
        res.once("finish", () => control.close(() => process.exit(0)));
        json(res, 200, result);
      } catch (error) {
        closing = false;
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    json(res, 404, { error: "not found" });
  });
  control.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    if (control.listening) resolve();
    else { control.once("listening", resolve); control.once("error", reject); }
  });
  const address = control.address();
  if (!address || typeof address === "string") throw new Error("ASL control server did not bind a TCP port");
  const daemon: DaemonState = {
    pid: process.pid,
    serverUrl: `ws://127.0.0.1:${runtime.server.port}`,
    controlUrl: `http://127.0.0.1:${address.port}`,
    startedAt: new Date().toISOString(),
  };
  writeJsonAtomic(daemonPath(stateDir), daemon);

  process.on("SIGTERM", () => {
    fetch(`${daemon.controlUrl}/shutdown`, { method: "POST", headers: { Authorization: `Bearer ${session.controlToken}` } }).catch(() => undefined);
  });
}
