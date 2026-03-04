/**
 * Admin active-scope switching tests
 *
 * Tests that universe admins can refresh with different activeScope values
 * and connect NebulaClients to different scopes.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { browserLogin, refreshToken } from '../../test-helpers';
import { NebulaClientTest } from './index';

describe('admin active-scope switching', () => {
  it('universe admin can refresh with different activeScope values', async () => {
    const browser = new Browser();
    const universe = `uni-${generateUuid().slice(0, 8)}`;
    const starA = `${universe}.app.tenant-a`;
    const starB = `${universe}.app.tenant-b`;

    // Bootstrap universe admin
    const { accessToken: adminToken, payload: adminPayload } = await browserLogin(
      browser, universe, 'admin@example.com', universe,
    );
    expect(adminPayload.access.authScopePattern).toContain(universe);
    expect(adminPayload.access.admin).toBe(true);

    // Admin refreshes with activeScope = starA
    const { accessToken: tokenA, payload: payloadA } = await refreshToken(browser, universe, starA);
    expect(payloadA.aud).toBe(starA);

    // Create client with starA scope, verify it connects and works
    const ctxA = browser.context('http://localhost');
    const clientA = new NebulaClientTest({
      baseUrl: 'http://localhost',
      authScope: universe,
      activeScope: starA,
      fetch: browser.fetch,
      WebSocket: browser.WebSocket,
      sessionStorage: ctxA.sessionStorage,
      BroadcastChannel: ctxA.BroadcastChannel,
    });
    await vi.waitFor(() => { expect(clientA.connectionState).toBe('connected'); });
    clientA[Symbol.dispose]();

    // Admin refreshes with activeScope = starB
    const { accessToken: tokenB, payload: payloadB } = await refreshToken(browser, universe, starB);
    expect(payloadB.aud).toBe(starB);

    // Verify the two tokens have different aud claims
    expect(payloadA.aud).not.toBe(payloadB.aud);

    // Create client with starB scope
    const ctxB = browser.context('http://localhost');
    const clientB = new NebulaClientTest({
      baseUrl: 'http://localhost',
      authScope: universe,
      activeScope: starB,
      fetch: browser.fetch,
      WebSocket: browser.WebSocket,
      sessionStorage: ctxB.sessionStorage,
      BroadcastChannel: ctxB.BroadcastChannel,
    });
    await vi.waitFor(() => { expect(clientB.connectionState).toBe('connected'); });
    clientB[Symbol.dispose]();
  });
});
