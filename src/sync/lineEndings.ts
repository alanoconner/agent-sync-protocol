export type LineEndingStyle = "lf" | "crlf";

/**
 * Canonicalizes any line-ending style to bare LF — the CRDT's only internal
 * representation (spec Section 6: "LF canonical internally"). Applied at the
 * single point content enters the sync layer (`SyncFileOps`), regardless of
 * which interception mechanism produced it, so two agents whose editors emit
 * different EOL styles never see a whole-file textual diff purely from that.
 */
export function toLf(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Converts canonical LF content to the requested on-disk line-ending style —
 * the inverse of `toLf`, applied only when flushing to disk, never inside the
 * CRDT. `.gitattributes`-driven style selection is Phase 7 territory; for now
 * the style is whatever `DiskFlushService` is configured with (default `lf`,
 * i.e. no conversion).
 */
export function fromLf(content: string, style: LineEndingStyle): string {
  if (style === "lf") return content;
  return content.replace(/\n/g, "\r\n");
}
