import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import * as Y from "yjs";
import { loadAgentSyncConfigOrDefault, CONFIG_FILE_NAME } from "../config/agentSyncConfig.js";
import { createDiskHydrator } from "../flush/diskHydration.js";
import { CrdtStore, defaultCrdtPersistenceDir } from "../persistence/crdtStore.js";
import { getSyncedFileState, TOMBSTONE_MAP_NAME, type SyncedFileState } from "../sync/fileState.js";
import { fromLf } from "../sync/lineEndings.js";
import { processAlive } from "./platform.js";
import { readDaemon, readSession } from "./sessionState.js";

export type RecoveryChoice = "crdt" | "disk";

function sameState(a: SyncedFileState, b: SyncedFileState): boolean {
  return a.exists === b.exists && a.content === b.content;
}

function normalizeDocName(repoRoot: string, value: string): string {
  const absolute = resolve(repoRoot, value);
  const rel = relative(repoRoot, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`recovery path must stay inside ${repoRoot}`);
  return rel.split(sep).join("/");
}

function docFromState(state: SyncedFileState): Y.Doc {
  const doc = new Y.Doc();
  if (state.exists) {
    if (state.content) doc.getText("content").insert(0, state.content);
  } else {
    doc.getMap<boolean>(TOMBSTONE_MAP_NAME).set("recovered-from-disk", true);
  }
  return doc;
}

/** Resolves a restart-time three-way recovery conflict while the daemon is offline. */
export async function recoverRoom(
  stateDir: string,
  repositoryRoot: string,
  path: string,
  choice: RecoveryChoice,
  persistenceDirOverride?: string,
): Promise<{ docName: string; choice: RecoveryChoice; repoRoot: string }> {
  const daemon = readDaemon(stateDir);
  if (daemon && processAlive(daemon.pid)) throw new Error("stop the ASL daemon before resolving durable CRDT state");

  const session = readSession(stateDir);
  const managedStore = resolve(stateDir, "crdt");
  const useManaged = Boolean(session && existsSync(managedStore));
  const repoRoot = useManaged ? session!.integrationWorktree : repositoryRoot;
  const persistenceDir = persistenceDirOverride ?? (useManaged ? managedStore : defaultCrdtPersistenceDir(repoRoot));
  const docName = normalizeDocName(repoRoot, path);
  const store = new CrdtStore(persistenceDir);
  try {
    const persisted = store.load(docName);
    if (!persisted) throw new Error(`no durable CRDT state exists for "${docName}"`);
    const recoveredDoc = new Y.Doc();
    try {
      Y.applyUpdate(recoveredDoc, persisted.update);
      const recovered = getSyncedFileState(recoveredDoc);
      const disk = createDiskHydrator(repoRoot)(docName);
      if (!disk) throw new Error(`cannot read repository state for "${docName}"`);
      if (sameState(disk, persisted.flushedState) || sameState(disk, recovered)) {
        throw new Error(`"${docName}" no longer has a three-way recovery conflict`);
      }

      if (choice === "crdt") {
        const absolute = resolve(repoRoot, docName);
        if (recovered.exists) {
          const config = loadAgentSyncConfigOrDefault(resolve(repoRoot, CONFIG_FILE_NAME));
          mkdirSync(dirname(absolute), { recursive: true });
          writeFileSync(absolute, fromLf(recovered.content, config.lineEndings), "utf8");
        } else {
          rmSync(absolute, { force: true });
        }
      } else {
        const replacement = docFromState(disk);
        try { await store.replace(docName, Y.encodeStateAsUpdate(replacement), disk); }
        finally { replacement.destroy(); }
      }
      return { docName, choice, repoRoot };
    } finally {
      recoveredDoc.destroy();
    }
  } finally {
    store.close();
  }
}
