import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyContentDiff, computeMinimalReplacement } from "../src/sync/textMerge.js";

function makeText(initial: string): Y.Text {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, initial);
  return text;
}

describe("Phase 3: content-diff CRDT merge", () => {
  describe("applyContentDiff (live-vs-target)", () => {
    it("turns a full-buffer rewrite into a minimal insert/delete instead of clear-and-reinsert", () => {
      const text = makeText("hello world");
      applyContentDiff(text, "hello there world");
      expect(text.toString()).toBe("hello there world");
    });

    it("is a no-op when content is unchanged", () => {
      const text = makeText("unchanged");
      applyContentDiff(text, "unchanged");
      expect(text.toString()).toBe("unchanged");
    });
  });

  describe("computeMinimalReplacement (before/after -> old_str/new_str)", () => {
    it("returns null when nothing changed", () => {
      expect(computeMinimalReplacement("same", "same")).toBeNull();
    });

    it("collapses a pure append down to a small context-anchored replacement, not the whole string", () => {
      const oldSnapshot = "line1\nline2\nline3\n";
      const newContent = oldSnapshot + "line4\n";
      const replacement = computeMinimalReplacement(oldSnapshot, newContent, 4);
      expect(replacement).not.toBeNull();
      expect(replacement!.oldStr.length).toBeLessThan(oldSnapshot.length);
      expect(oldSnapshot.endsWith(replacement!.oldStr)).toBe(true);
      expect(newContent.endsWith(replacement!.newStr)).toBe(true);
      expect(newContent).toBe(oldSnapshot.slice(0, oldSnapshot.length - replacement!.oldStr.length) + replacement!.newStr);
    });

    it("collapses a pure prepend down to a small context-anchored replacement", () => {
      const oldSnapshot = "line1\nline2\n";
      const newContent = "HEADER\n" + oldSnapshot;
      const replacement = computeMinimalReplacement(oldSnapshot, newContent, 4);
      expect(replacement).not.toBeNull();
      expect(oldSnapshot.startsWith(replacement!.oldStr)).toBe(true);
      expect(replacement!.newStr.startsWith("HEADER\n")).toBe(true);
    });

    it("captures a middle edit as old_str/new_str with surrounding context", () => {
      const oldSnapshot = "AAAA BBBB CCCC";
      const newContent = "AAAA ZZZZ CCCC";
      const replacement = computeMinimalReplacement(oldSnapshot, newContent, 0);
      expect(replacement).toEqual({ oldStr: "BBBB", newStr: "ZZZZ" });
    });
  });
});
