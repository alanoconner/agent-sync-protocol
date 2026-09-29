import type * as Y from "yjs";

export const TOMBSTONE_MAP_NAME = "_file_tombstones";

export interface SyncedFileState {
  exists: boolean;
  content: string;
}

export function isFileDeleted(doc: Y.Doc): boolean {
  return doc.getMap<boolean>(TOMBSTONE_MAP_NAME).size > 0;
}

export function getSyncedFileState(doc: Y.Doc): SyncedFileState {
  if (isFileDeleted(doc)) return { exists: false, content: "" };
  return { exists: true, content: doc.getText("content").toString() };
}

export function clearObservedTombstones(doc: Y.Doc): void {
  const tombstones = doc.getMap<boolean>(TOMBSTONE_MAP_NAME);
  for (const key of tombstones.keys()) tombstones.delete(key);
}
