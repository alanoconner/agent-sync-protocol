import { describe, expect, it } from "vitest";
import { fromLf, toLf } from "../src/sync/lineEndings.js";

describe("Phase 4: line-ending normalization (Section 6)", () => {
  describe("toLf", () => {
    it("converts CRLF to LF", () => {
      expect(toLf("line1\r\nline2\r\n")).toBe("line1\nline2\n");
    });

    it("converts bare CR to LF", () => {
      expect(toLf("line1\rline2\r")).toBe("line1\nline2\n");
    });

    it("leaves LF-only content untouched", () => {
      expect(toLf("line1\nline2\n")).toBe("line1\nline2\n");
    });

    it("handles mixed line endings in the same string", () => {
      expect(toLf("a\r\nb\nc\rd")).toBe("a\nb\nc\nd");
    });
  });

  describe("fromLf", () => {
    it("leaves content untouched for the lf style", () => {
      expect(fromLf("a\nb\n", "lf")).toBe("a\nb\n");
    });

    it("converts LF to CRLF for the crlf style", () => {
      expect(fromLf("a\nb\n", "crlf")).toBe("a\r\nb\r\n");
    });
  });

  it("round-trips through toLf then fromLf('crlf') without double-converting", () => {
    const original = "a\r\nb\rc\nd";
    expect(fromLf(toLf(original), "crlf")).toBe("a\r\nb\r\nc\r\nd");
  });
});
