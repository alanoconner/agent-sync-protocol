import { diffChars } from "diff";
import type * as Y from "yjs";

/**
 * Applies `newContent` onto `ytext` as a minimal set of insert/delete ops derived
 * from a char-level diff against `ytext`'s *current live* content, rather than
 * clearing and reinserting the whole text. Used when the caller has no record of
 * what it last read (a blind full-buffer write) — there's no way to distinguish
 * "the writer meant to delete this" from "someone else's concurrent edit", so a
 * concurrent edit inside the writer's replaced range can still be lost.
 */
export function applyContentDiff(ytext: Y.Text, newContent: string): void {
  const oldContent = ytext.toString();
  if (oldContent === newContent) return;
  const doc = ytext.doc;
  if (!doc) throw new Error("Y.Text is not attached to a document");
  const parts = diffChars(oldContent, newContent);
  doc.transact(() => {
    let index = 0;
    for (const part of parts) {
      if (part.added) {
        ytext.insert(index, part.value);
        index += part.value.length;
      } else if (part.removed) {
        ytext.delete(index, part.value.length);
      } else {
        index += part.value.length;
      }
    }
  });
}

const DEFAULT_CONTEXT_MARGIN = 8;

export interface MinimalReplacement {
  oldStr: string;
  newStr: string;
}

/**
 * Diffs `oldSnapshot` (what a writer believed the content was) against
 * `newContent` (what it wants now) and collapses the result to the smallest
 * `{ oldStr, newStr }` replacement that captures the writer's actual edit, by
 * trimming the common prefix/suffix down to an initial context margin, then
 * expanding only as far as needed to make `oldStr` unique in the snapshot.
 * This is exactly a `range_replace`-style `old_str`/`new_str` pair (Section
 * 3.2), derived automatically instead of coming from an explicit tool argument.
 *
 * Kept as a plain string function (not touching any Y.Text) so it can be
 * unit-tested in isolation and reused by anything that needs to turn a
 * before/after snapshot into a match-or-reject edit — currently the FUSE
 * write path (Section 3.3a), which has an honest snapshot from its own
 * open()-to-flush() lifecycle but no explicit old_str argument the way an MCP
 * range_replace tool call does.
 *
 * Returns `null` if the two strings are identical (nothing to replace).
 */
export function computeMinimalReplacement(
  oldSnapshot: string,
  newContent: string,
  contextMargin = DEFAULT_CONTEXT_MARGIN,
): MinimalReplacement | null {
  if (oldSnapshot === newContent) return null;

  const maxCommon = Math.min(oldSnapshot.length, newContent.length);
  let prefix = 0;
  while (prefix < maxCommon && oldSnapshot[prefix] === newContent[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = maxCommon - prefix;
  while (
    suffix < maxSuffix &&
    oldSnapshot[oldSnapshot.length - 1 - suffix] === newContent[newContent.length - 1 - suffix]
  ) {
    suffix++;
  }

  const replacementAt = (margin: number): MinimalReplacement => {
    const leftContext = Math.min(prefix, margin);
    const rightContext = Math.min(suffix, margin);
    return {
      oldStr: oldSnapshot.slice(prefix - leftContext, oldSnapshot.length - suffix + rightContext),
      newStr: newContent.slice(prefix - leftContext, newContent.length - suffix + rightContext),
    };
  };
  const isUniqueInSnapshot = (replacement: MinimalReplacement, margin: number): boolean => {
    if (replacement.oldStr === "") return false;
    const expectedIndex = prefix - Math.min(prefix, margin);
    const firstIndex = oldSnapshot.indexOf(replacement.oldStr);
    return firstIndex === expectedIndex && oldSnapshot.indexOf(replacement.oldStr, firstIndex + 1) === -1;
  };

  if (oldSnapshot === "") return { oldStr: "", newStr: newContent };

  const maxMargin = Math.max(prefix, suffix);
  const requestedMargin = Number.isFinite(contextMargin) ? Math.floor(contextMargin) : DEFAULT_CONTEXT_MARGIN;
  let currentMargin = Math.min(maxMargin, Math.max(0, requestedMargin));
  let replacement = replacementAt(currentMargin);
  if (isUniqueInSnapshot(replacement, currentMargin)) return replacement;

  let lastAmbiguousMargin = currentMargin;
  while (currentMargin < maxMargin) {
    currentMargin = Math.min(maxMargin, Math.max(currentMargin + 1, currentMargin * 2));
    replacement = replacementAt(currentMargin);
    if (isUniqueInSnapshot(replacement, currentMargin)) break;
    lastAmbiguousMargin = currentMargin;
  }

  let low = lastAmbiguousMargin + 1;
  let high = currentMargin;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (isUniqueInSnapshot(replacementAt(middle), middle)) high = middle;
    else low = middle + 1;
  }
  return replacementAt(low);
}
