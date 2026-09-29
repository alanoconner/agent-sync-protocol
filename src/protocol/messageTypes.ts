// Wire protocol message types — the outer envelope byte. Each type wraps a
// payload with its own sub-format (see y-protocols/sync and
// y-protocols/awareness respectively); this byte just routes to the right
// decoder before any of that inner structure is read.
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
/**
 * Phase 6's lock service (spec Section 4/10): a genuinely new concern (a
 * request/response lease protocol), not a variant of sync or awareness, so it
 * gets its own envelope type rather than being stuffed into either existing
 * one — exactly the extensibility this two-layer framing was built for (see
 * the module doc above). Payload is a JSON-encoded {@link LockRequestPayload}
 * / {@link LockResponsePayload} from `src/protocol/lockMessages.ts`, wrapped
 * with `encoding.writeVarString`/`decoding.readVarString` — no need for
 * y-protocols' binary encoders here, since lock messages are low-frequency
 * request/response, not high-throughput CRDT state.
 */
export const MESSAGE_LOCK = 2;
/** Ordered client→server persistence barrier and server→client result. */
export const MESSAGE_DURABILITY = 3;
