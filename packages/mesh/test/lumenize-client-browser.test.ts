/**
 * Real-browser smoke for `@lumenize/mesh/client`.
 *
 * **Why this exists**: when `@lumenize/debug` started doing
 * `await import('cloudflare:workers')` (lazy import + try/catch), the regression
 * silently passed through every test tier — vitest-pool-workers and tsx both
 * resolve dynamic imports at runtime, so the broken specifier never tripped.
 * Real Vite (and the bundlers downstream users actually use) resolves
 * `'cloudflare:workers'` at bundle time and refuses; users couldn't bundle
 * a NebulaClient at all. See tasks/playwright-test-template.md.
 *
 * This test runs in a real chromium browser via `@vitest/browser-playwright`,
 * which means Vite has to bundle `@lumenize/mesh/client` for the browser
 * before the test can even start. The IMPORT line below is the primary
 * assertion — if Vite can't resolve a transitive dep, this file fails to
 * load and the test errors out at bundle time.
 *
 * The runtime assertions then catch a different class of regressions:
 * environment-specific API access (`process.env`, `__dirname`, etc.) that
 * would survive bundling but throw at instantiation.
 */
import { describe, it, expect } from 'vitest';
import {
  LumenizeClient,
  mesh,
  getOrCreateTabId,
  type ConnectionState,
  type LumenizeClientConfig,
} from '../src/client-index';

// Minimal stub WebSocket: lets the constructor's eager `connect()` complete
// the synchronous portion without attempting a real network call. We assert
// on the initial state, not on what `connect()` does next.
class StubWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = StubWebSocket.CONNECTING;
  url: string;
  protocol = '';
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(url: string | URL, _protocols?: string | string[]) {
    this.url = url.toString();
  }
  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {}
  close(_code?: number, _reason?: string): void {
    this.readyState = StubWebSocket.CLOSED;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean { return false; }
}

class TestClient extends LumenizeClient {}

describe('@lumenize/mesh/client (real-browser bundle)', () => {
  it('imports cleanly under Vite + chromium', () => {
    // If this file loaded, vite resolved every transitive import for the
    // browser. That's the primary signal. The remaining `expect`s document
    // what the import surface should look like so accidental removals get
    // caught as test failures rather than silent breakage.
    expect(typeof LumenizeClient).toBe('function');
    expect(typeof mesh).toBe('function');
    expect(typeof getOrCreateTabId).toBe('function');
  });

  it('constructs without throwing and reports a valid initial connectionState', () => {
    const config: LumenizeClientConfig = {
      baseUrl: 'wss://example.invalid',
      WebSocket: StubWebSocket as unknown as typeof WebSocket,
      // Don't supply a refresh URL — the client won't try to refresh during
      // the synchronous constructor; the stubbed WS prevents any real I/O.
    };

    const client = new TestClient(config);

    // ConnectionState is a known discriminated union; the constructor's
    // eager `connect()` should leave us in 'connecting' (or 'disconnected'
    // if the connect path bails early). Either is "valid initial state".
    const validStates: ConnectionState[] = [
      'connecting', 'connected', 'reconnecting', 'disconnected',
    ];
    expect(validStates).toContain(client.connectionState);

    // Tear down so we don't leak handles between tests.
    (client as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
  });

  it('generates a tab ID using browser-native sessionStorage + BroadcastChannel', async () => {
    // `getOrCreateTabId` is the canonical place `@lumenize/mesh/client` touches
    // browser-specific APIs (sessionStorage, BroadcastChannel). If a future
    // change accidentally references `process` or `node:*` from this path,
    // the test will throw a ReferenceError instead of returning a string.
    const tabId = await getOrCreateTabId({
      sessionStorage: globalThis.sessionStorage,
      BroadcastChannel: globalThis.BroadcastChannel,
    });
    expect(typeof tabId).toBe('string');
    expect(tabId.length).toBeGreaterThan(0);
  });
});
