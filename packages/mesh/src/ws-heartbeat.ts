/**
 * Client→gateway WebSocket keepalive protocol.
 *
 * A long, *quiet* turn (e.g. a multi-minute codegen) sends no frames on the client↔gateway WS while
 * the client awaits the result — and Cloudflare's edge closes a frameless WS after ~100s (the
 * `cf-long-stream-limits` ~70–140s idle window). The dropped socket means a completed turn's reply can
 * never be delivered, so the UI hangs ("Studio is thinking…" forever) even though the work finished.
 *
 * Fix: the client sends `WS_HEARTBEAT_PING` every `WS_HEARTBEAT_INTERVAL_MS` (well under the idle
 * window), keeping frames flowing so the edge won't close it. The gateway registers a hibernation
 * **auto-response** (`setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))`) so each
 * ping is answered at the runtime level WITHOUT waking the hibernated gateway DO — no per-ping wall-clock
 * cost. The client ignores the `PONG` in its message handler.
 *
 * Plain strings (not JSON): `setWebSocketAutoResponse` matches the request by EXACT string equality.
 * Shared here (no deps) so the browser client and the server gateway agree without the client bundle
 * importing server code.
 */
export const WS_HEARTBEAT_PING = 'lmz:ping';
export const WS_HEARTBEAT_PONG = 'lmz:pong';

/** Ping cadence — comfortably under the ~70–140s CF idle-eviction window, with margin for jitter. */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;
