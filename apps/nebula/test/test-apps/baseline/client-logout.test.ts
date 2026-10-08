/**
 * client.logout() — real-Star sign-out (§5.3.8 connection-lifecycle path 6).
 *
 * Every session's cookies live on the platform host, so a page cannot end them itself: `logout()`
 * drops the in-memory token and claims, disconnects, and sends the top-level page to the platform
 * host's logout page, whose own `POST` ends every session the browser holds. Exercised against a
 * REAL Star + REAL nebula-auth:
 *   - the in-memory access token + claims are dropped (LumenizeClient.clearAccessToken)
 *   - disconnect() → the factory mirrors store.lmz.connection.state = 'disconnected'
 *   - a top-level page goes to `/auth/logout` on the platform host, `?everywhere=1` when asked
 *   - the client itself sends no request: the browser's cookie still mints until that page posts
 *
 * Under vitest-plugin there is no `window`, so the navigation is observed through a stubbed one —
 * the only observable the client has, since the logout it sends a page to is the page's to post.
 *
 * Capable-of-failing, per assertion: `client.claims` is null (drop `clearAccessToken` → claims
 * survive); state goes 'disconnected' (drop `disconnect` → it stays 'connected'); the stub sees
 * the logout page's URL (drop the navigation → it sees nothing); the refresh still answers 200
 * (post the logout from the client → it 401s).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Browser } from '@lumenize/testing';
import { createNebulaClient } from '@lumenize/resources/frontend';
import { foundAndLogin, ORIGIN, pageOf } from '../../test-helpers';

function uniqueStar(): string {
  return `acme-${crypto.randomUUID().slice(0, 8)}.app.tenant-a`;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('client.logout (§5.3.8 path 6, real Star)', () => {
  it.each([[false, `${ORIGIN}/auth/logout`], [true, `${ORIGIN}/auth/logout?everywhere=1`]])(
    'everywhere=%s: drops the token, disconnects, and sends the page to the logout page — sending nothing itself',
    async (everywhere, expected) => {
      const star = uniqueStar();
      const browser = new Browser();
      await foundAndLogin(browser, star, 'admin@example.com', star);
      const ctx = browser.context(pageOf(star));

      const { client, store, ready, dispose } = createNebulaClient({
        baseUrl: pageOf(star), platformOrigin: ORIGIN,
        ontologyVersion: 'v1',
        fetch: ctx.fetch,
        WebSocket: ctx.WebSocket,
        sessionStorage: ctx.sessionStorage,
        BroadcastChannel: ctx.BroadcastChannel,
        onShouldRefreshUI: () => {},
      });

      await ready;
      expect(client.claims?.sub).toBeTruthy();

      // A top-level page, whose navigation the stub records.
      const assign = vi.fn();
      const page = { location: { assign } } as { location: { assign: typeof assign }; top?: unknown; self?: unknown };
      page.top = page;
      page.self = page;
      vi.stubGlobal('window', page);
      await client.logout({ everywhere });
      vi.unstubAllGlobals();

      expect(client.claims).toBeNull();
      await vi.waitFor(() => {
        expect(store.lmz.connection.state).toBe('disconnected');
      });
      expect(assign).toHaveBeenCalledWith(expected);

      // The client sent nothing: the browser's cookie still mints until the logout page posts.
      const resp = await ctx.fetch(`${ORIGIN}/auth/refresh-token`, { method: 'POST' });
      expect(resp.status).toBe(200);

      await dispose();
    },
  );
});
