/**
 * WS-disconnect tooling for the real-chromium harness (§5.3.7-v4).
 *
 * A test affordance to force-close the live client WebSocket so the
 * connection-lifecycle probes (mid-session drop → reconnect, mid-session
 * terminal, orgTree reconnect→re-subscribe) are capable-of-failing against a
 * REAL Star + REAL WebSocket — no mesh source change needed.
 *
 * Mechanism: a `WebSocket` subclass injected via the factory's `WebSocket`
 * config option (LumenizeClient does `new this.#WebSocketClass(url, protocols)`).
 * Each constructed socket is recorded, so a test can drop the live one.
 *
 * Why a *synthetic* close event rather than `ws.close(code)`: through the
 * vite→wrangler http-proxy WS tunnel a client-initiated `close()` never
 * completes the closing handshake — the socket sits in CLOSING and `onclose`
 * never fires, so the client never reconnects. Instead `drop()` dispatches a
 * `CloseEvent` on the recorded socket, which invokes the client's bound
 * `onclose` IDL handler → `#handleClose(code)` → reconnect, exactly as a real
 * server close would. It then neutralizes the orphaned socket (`onmessage` etc.
 * nulled + best-effort `close()`) so the abandoned connection can't keep
 * delivering fanout to the store while the client is "disconnected" — load-
 * bearing for the orgTree probe, which needs A genuinely deaf during the drop.
 *
 * Close-code semantics are deliberately NOT relied upon for the *terminal*
 * path: `#handleClose` routes every non-{4400,4403,4401} code to
 * `#scheduleReconnect`. So:
 *   - **transient drop** → `drop(TRANSIENT_DROP_CODE)`; reconnect fires.
 *   - **mid-session terminal** is driven by failing the *refresh* during that
 *     reconnect (see `refresh401AfterFlag`) — the real "session revoked
 *     mid-flight" path — independent of any close code.
 */

/** A clean application close code that maps to `#scheduleReconnect` (not auth). */
export const TRANSIENT_DROP_CODE = 4500;

export interface RecordingWebSocketHandle {
  /** Pass as the factory's `WebSocket` config option. */
  WebSocket: typeof WebSocket;
  /** The most-recently-constructed (live) socket. */
  current(): WebSocket | undefined;
  /** Force a mid-session drop of the live socket → drives `#handleClose`. */
  drop(code?: number, reason?: string): void;
  /** How many sockets have been constructed (initial + each reconnect). */
  count(): number;
}

/**
 * Build a `WebSocket` subclass that records every instance. Fresh per test so
 * the instance list doesn't bleed across tests.
 */
export function recordingWebSocket(): RecordingWebSocketHandle {
  const instances: WebSocket[] = [];
  class RecordingWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      instances.push(this);
    }
  }
  return {
    WebSocket: RecordingWebSocket as unknown as typeof WebSocket,
    current: () => instances[instances.length - 1],
    drop: (code = TRANSIENT_DROP_CODE, reason = 'simulated drop') => {
      const ws = instances[instances.length - 1];
      if (!ws) return;
      // Drive the client's #handleClose (it bound `ws.onclose = ...`).
      ws.dispatchEvent(new CloseEvent('close', { code, reason, wasClean: false }));
      // Silence + tear down the orphaned socket so it can't keep delivering.
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try { ws.close(code, reason); } catch { /* already closing/closed */ }
    },
    count: () => instances.length,
  };
}

// NOTE: a CDP `Network.emulateNetworkConditions offline` helper was tried here
// for a genuine server-side drop, but it's UNUSABLE in vitest-browser-playwright
// — going offline severs the browser↔vitest-server orchestration channel too, so
// the browser can never report results and the whole run hangs. The synthetic
// `drop()` above is the supported mechanism (it drives the client's reconnect
// state machine without touching the page's real network).

/**
 * A `fetch` wrapper that delegates to the browser's real fetch until `flag()`
 * returns true, after which any `/refresh-token` request returns 401. Used to
 * simulate a session revoked mid-session: the next reconnect's refresh fails
 * terminally → `LoginRequiredError` → `onLoginRequired` + 'disconnected'.
 */
export function refresh401AfterFlag(flag: () => boolean): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    if (flag() && typeof url === 'string' && url.includes('/refresh-token')) {
      return Promise.resolve(new Response('session revoked', { status: 401 }));
    }
    return fetch(input, init);
  }) as typeof fetch;
}
