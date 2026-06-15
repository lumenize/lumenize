/**
 * createNebulaClient `ready` — real-Star connection-lifecycle probes (§5.3.8 / P10).
 *
 * Exercises the factory's `ready` Promise against a REAL Star + REAL nebula-auth.
 * The jsdom factory tests drive a MockClient; this is the no-mock backing the
 * test-fidelity obligation requires (tasks/nebula-frontend.md §5.3.7-v3). Covers
 * the three §5.3.8 **first-connect** `ready` probes (the lifecycle-matrix items
 * 524–526):
 *   - resolves on first connect (claims populated, `lmz.connection.state` 'connected')
 *   - REJECTS with `LoginRequiredError` on a first-connect TERMINAL auth failure
 *     (a logged-out visitor → the real refresh endpoint returns 401); `onLoginRequired`
 *     fires and `lmz.connection.state` is 'disconnected' (NOT swallowed into reconnect)
 *   - stays PENDING across a TRANSIENT first-connect failure (5xx), then resolves
 *
 * Scope: first-connect only. The *mid-session* terminal path (token expiry after
 * `ready` has already resolved → `onLoginRequired` fires but `ready` must NOT
 * re-settle — the factory's `readySettled` guard) is connection-lifecycle-matrix
 * path 5/6 and needs WS-disconnect tooling → §5.3.7-v4, not here.
 *
 * The reject probe is the no-mock proof that P9's first-connect classification works
 * for the REAL NebulaClient. NebulaClient supplies `refresh` as a *function* (so mesh's
 * string-endpoint classification in #refreshToken never runs); the function must itself
 * throw `LoginRequiredError` on 401/403 (nebula-client.ts) or #connectInternal swallows
 * the failure into unbounded reconnect and `ready` hangs forever. **Capable-of-failing:**
 * revert that nebula-client.ts classification and the reject probe times out (the client
 * goes 'reconnecting', `ready` never settles).
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { createNebulaClient } from '@lumenize/nebula/frontend';
import { LoginRequiredError } from '@lumenize/mesh/client';
import { browserLogin, ORIGIN } from '../../test-helpers';

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

describe('createNebulaClient ready (§5.3.8 connection lifecycle, real Star)', () => {
  it('resolves on first connect with claims populated + lmz.connection.state connected', async () => {
    const star = uniqueStar();
    const browser = new Browser();
    await browserLogin(browser, star, 'admin@example.com', star);
    const ctx = browser.context(ORIGIN);

    const { client, store, ready, dispose } = createNebulaClient({
      baseUrl: ORIGIN,
      authScope: star,
      activeScope: star,
      appVersion: 'v1',
      fetch: browser.fetch,
      WebSocket: browser.WebSocket,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
      onShouldRefreshUI: () => {},
    });

    await ready; // resolves on the first 'connected' transition

    expect(client.claims?.sub).toBeTruthy();
    await vi.waitFor(() => {
      expect(store.lmz.connection.state).toBe('connected');
    });
    expect(store.lmz.connection.connected).toBe(true);

    await dispose();
  });

  it('REJECTS with LoginRequiredError on a first-connect terminal auth failure (logged-out → real 401)', async () => {
    const star = uniqueStar();
    const browser = new Browser(); // NOT logged in → no refresh cookie → real endpoint 401
    const ctx = browser.context(ORIGIN);
    let loginErr: unknown = null;

    const { store, ready, dispose } = createNebulaClient({
      baseUrl: ORIGIN,
      authScope: star,
      activeScope: star,
      appVersion: 'v1',
      fetch: browser.fetch,
      WebSocket: browser.WebSocket,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
      onShouldRefreshUI: () => {},
      onLoginRequired: (e) => { loginErr = e; },
    });

    await expect(ready).rejects.toBeInstanceOf(LoginRequiredError);
    expect((loginErr as LoginRequiredError | null)?.name).toBe('LoginRequiredError');
    await vi.waitFor(() => {
      expect(store.lmz.connection.state).toBe('disconnected');
    });
    // Capable-of-failing: the pre-fix path went to 'reconnecting' and `ready` never rejected.
    expect(store.lmz.connection.state).not.toBe('reconnecting');

    await dispose();
  });

  it('REJECTS on a first-connect 403 too (guards the 403 operand of the classification)', async () => {
    // The fully-real logged-out path only yields 401 ("no refresh token"); a real
    // 403 needs a scope mismatch. A fetch override forcing 403 on the refresh
    // endpoint is the cheapest way to guard the `|| res.status === 403` operand of
    // NebulaClient's embedded-refresh classification at this layer.
    const star = uniqueStar();
    const browser = new Browser();
    const ctx = browser.context(ORIGIN);
    let loginErr: unknown = null;

    const forbiddenFetch = ((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (typeof url === 'string' && url.includes('/refresh-token')) {
        return Promise.resolve(new Response('forbidden', { status: 403 }));
      }
      return browser.fetch(input, init);
    }) as typeof fetch;

    const { ready, dispose } = createNebulaClient({
      baseUrl: ORIGIN,
      authScope: star,
      activeScope: star,
      appVersion: 'v1',
      fetch: forbiddenFetch,
      WebSocket: browser.WebSocket,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
      onShouldRefreshUI: () => {},
      onLoginRequired: (e) => { loginErr = e; },
    });

    await expect(ready).rejects.toBeInstanceOf(LoginRequiredError);
    expect((loginErr as LoginRequiredError | null)?.code).toBe(403);

    await dispose();
  });

  it('stays pending across a transient first-connect failure (5xx), then resolves', async () => {
    const star = uniqueStar();
    const browser = new Browser();
    await browserLogin(browser, star, 'admin@example.com', star);
    const ctx = browser.context(ORIGIN);

    // Fail the FIRST refresh with a 503 (transient), then delegate to the real
    // browser fetch so the reconnect-backoff retry succeeds.
    let refreshCalls = 0;
    const faultyFetch = ((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (typeof url === 'string' && url.includes('/refresh-token')) {
        refreshCalls++;
        if (refreshCalls === 1) {
          return Promise.resolve(new Response('upstream error', { status: 503 }));
        }
      }
      return browser.fetch(input, init);
    }) as typeof fetch;

    let rejected = false;
    const { store, ready, dispose } = createNebulaClient({
      baseUrl: ORIGIN,
      authScope: star,
      activeScope: star,
      appVersion: 'v1',
      fetch: faultyFetch,
      WebSocket: browser.WebSocket,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
      onShouldRefreshUI: () => {},
    });
    ready.catch(() => { rejected = true; });

    // Must NOT reject on the transient failure; resolves after the backoff retry
    // hits the real (200) refresh.
    await ready;
    expect(rejected).toBe(false);
    expect(refreshCalls).toBeGreaterThanOrEqual(2); // first 503, retry succeeded
    await vi.waitFor(() => {
      expect(store.lmz.connection.state).toBe('connected');
    });

    await dispose();
  }, 15000);
});
