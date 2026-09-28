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

    it("represents creation from an empty snapshot without inventing an anchor", () => {
      expect(computeMinimalReplacement("", "created\n")).toEqual({ oldStr: "", newStr: "created\n" });
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

    it("expands repetitive context until the intended snapshot span is unique", () => {
      const repeated = "12345678VALUE87654321";
      const oldSnapshot = `first block\n${repeated}\nsecond block\n${repeated}\n`;
      const target = oldSnapshot.lastIndexOf("VALUE");
      const newContent = `${oldSnapshot.slice(0, target)}CHANGED${oldSnapshot.slice(target + "VALUE".length)}`;

      const replacement = computeMinimalReplacement(oldSnapshot, newContent);

      expect(replacement).not.toBeNull();
      expect(replacement!.oldStr.length).toBeGreaterThan("12345678VALUE87654321".length);
      expect(oldSnapshot.indexOf(replacement!.oldStr)).toBe(oldSnapshot.lastIndexOf(replacement!.oldStr));
      expect(oldSnapshot.replace(replacement!.oldStr, replacement!.newStr)).toBe(newContent);
    });

    it("uses the full snapshot as an exact anchor when repetition extends to the file boundaries", () => {
      const oldSnapshot = "aaaaaaaaaaaaaaaa";
      const newContent = "aaaaaaaaXaaaaaaaa";
      expect(computeMinimalReplacement(oldSnapshot, newContent)).toEqual({ oldStr: oldSnapshot, newStr: newContent });
    });

    it("represents deletion with an exact anchored replacement", () => {
      const oldSnapshot = "prefix REMOVE suffix";
      const newContent = "prefix  suffix";
      const replacement = computeMinimalReplacement(oldSnapshot, newContent);
      expect(replacement).not.toBeNull();
      expect(oldSnapshot.replace(replacement!.oldStr, replacement!.newStr)).toBe(newContent);
    });
  });
});
