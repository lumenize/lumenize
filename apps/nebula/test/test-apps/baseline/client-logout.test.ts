/**
 * client.logout() — real-Star sign-out (§5.3.8 connection-lifecycle path 6).
 *
 * Exercises the full sign-out against a REAL Star + REAL nebula-auth:
 *   - POST /auth/{authScope}/logout revokes + clears the path-scoped refresh cookie
 *   - the in-memory access token + claims are dropped (LumenizeClient.clearAccessToken)
 *   - disconnect() → the factory mirrors store.lmz.connection.state = 'disconnected'
 *
 * Both deps verified present 2026-06-15: the mesh token-clear (P9 `clearAccessToken`)
 * + the nebula-auth `/logout` endpoint (already shipped + tested — the earlier
 * "phantom endpoint" deferral was stale).
 *
 * Capable-of-failing, per assertion: a subsequent refresh with the same browser
 * returns 401 (cookie cleared + refresh token revoked) — proving logout actually
 * hit the endpoint (drop the POST → the refresh succeeds 200); `client.claims` is
 * null (drop `clearAccessToken` → claims survive); state goes 'disconnected' (drop
 * `disconnect` → it stays 'connected').
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { createNebulaClient } from '@lumenize/nebula/frontend';
import { browserLogin, ORIGIN } from '../../test-helpers';

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

describe('client.logout (§5.3.8 path 6, real Star)', () => {
  it('revokes the session, drops the in-memory token, and disconnects', async () => {
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

    await ready;
    expect(client.claims?.sub).toBeTruthy();

    await client.logout();

    // In-memory token + claims dropped.
    expect(client.claims).toBeNull();
    // disconnect() → the factory mirrors the connection state.
    await vi.waitFor(() => {
      expect(store.lmz.connection.state).toBe('disconnected');
    });

    // Session revoked server-side: a fresh refresh with the same browser now 401s
    // (cookie cleared + refresh token revoked). Without logout's endpoint call the
    // still-valid cookie would refresh successfully (200).
    const resp = await browser.fetch(`${ORIGIN}/auth/${star}/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeScope: star }),
    });
    expect(resp.status).toBe(401);

    await dispose();
  });
});
