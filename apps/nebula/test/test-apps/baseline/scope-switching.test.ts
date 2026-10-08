/**
 * Admin active-scope switching tests
 *
 * Tests that universe admins can refresh with different activeScope values
 * and connect NebulaClients to different scopes.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { foundAndLogin, refreshToken, ORIGIN, pageOf } from '../../test-helpers';
import { NebulaClientTest } from './index';

describe('admin active-scope switching', () => {
  it('universe admin can refresh with different activeScope values', async () => {
    const browser = new Browser();
    const universe = `uni-${crypto.randomUUID().slice(0, 8)}`;
    const starA = `${universe}.app.tenant-a`;
    const starB = `${universe}.app.tenant-b`;

    // Bootstrap universe admin
    const { accessToken: adminToken, payload: adminPayload } = await foundAndLogin(
      browser, universe, 'admin@example.com', universe,
    );
    expect(adminPayload.access.authScope).toContain(universe);
    expect(adminPayload.access.scopeAdmin).toBe(true);

    // Admin refreshes with activeScope = starA
    const { accessToken: tokenA, payload: payloadA } = await refreshToken(browser, starA);
    expect(payloadA.aud).toBe(starA);

    // Create client with starA scope, verify it connects and works
    const ctxA = browser.context(pageOf(starA));
    const clientA = new NebulaClientTest({
      baseUrl: pageOf(starA),
      platformOrigin: ORIGIN,
      ontologyVersion: 'v1',
      fetch: ctxA.fetch,
      WebSocket: ctxA.WebSocket,
      sessionStorage: ctxA.sessionStorage,
      BroadcastChannel: ctxA.BroadcastChannel,
    });
    await vi.waitFor(() => { expect(clientA.connectionState).toBe('connected'); });
    clientA[Symbol.dispose]();

    // Admin refreshes with activeScope = starB
    const { accessToken: tokenB, payload: payloadB } = await refreshToken(browser, starB);
    expect(payloadB.aud).toBe(starB);

    // Verify the two tokens have different aud claims
    expect(payloadA.aud).not.toBe(payloadB.aud);

    // Create client with starB scope
    const ctxB = browser.context(pageOf(starB));
    const clientB = new NebulaClientTest({
      baseUrl: pageOf(starB),
      platformOrigin: ORIGIN,
      ontologyVersion: 'v1',
      fetch: ctxB.fetch,
      WebSocket: ctxB.WebSocket,
      sessionStorage: ctxB.sessionStorage,
      BroadcastChannel: ctxB.BroadcastChannel,
    });
    await vi.waitFor(() => { expect(clientB.connectionState).toBe('connected'); });
    clientB[Symbol.dispose]();
  });
});
