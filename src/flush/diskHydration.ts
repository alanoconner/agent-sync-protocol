import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { toLf } from "../sync/lineEndings.js";

export type Hydrator = (docName: string) => string | undefined;

/**
 * Disk→CRDT hydration (the direction Phase 4's `DiskFlushService` never
 * covered). Returns a `SyncServer` `hydrate` callback that, when a room is
 * first created, seeds it with the current working-tree content of
 * `<repoRoot>/<docName>` — so the first agent to touch an already-existing
 * file sees that file, not an empty doc. Lives next to `DiskFlushService`
 * because it shares the exact same convention ("a doc name is a path relative
 * to `repoRoot`") and the same refusal to step outside that root; the
 * `SyncServer` itself stays agnostic about what a doc name means and just
 * calls whatever `hydrate` it was handed.
 *
 * Content is normalized with `toLf` on the way in — this is a *write entry
 * point into the CRDT*, exactly like `SyncFileOps`'s write methods, and the
 * invariant that the CRDT never holds anything but LF (spec Section 6) has to
 * hold for content that arrives from disk too. It is not a third line-ending
 * policy: disk-side style still lives only in `DiskFlushService`'s `fromLf`.
 *
 * Returns `undefined` (room starts empty, as before) when the file doesn't
 * exist, isn't a regular file, or the doc name would escape `repoRoot`.
 */
export function createDiskHydrator(repoRoot: string): Hydrator {
  const root = resolve(repoRoot);
  return (docName) => {
    const absPath = resolve(root, docName);
    const rel = relative(root, absPath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    try {
      return toLf(readFileSync(absPath, "utf8"));
    } catch {
      // ENOENT, EISDIR, permission errors — all mean "nothing on disk to seed from."
      return undefined;
    }
  };
}
