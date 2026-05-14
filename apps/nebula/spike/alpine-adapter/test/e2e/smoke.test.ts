/**
 * Phase 0b smoke test — minimal end-to-end:
 *   - spin up real DOs via vitest-pool-workers
 *   - bootstrap an admin
 *   - instantiate the spike's NebulaClient + factory
 *   - verify connection state surfaces at store.lmz.connection.*
 *
 * Larger tests (transaction round-trip, fanout, auto-subscribe) come after
 * this proves the harness works.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { NebulaClient } from '../../src/nebula-client';
import { createNebulaClient } from '../../src/create-nebula-client';
import { adaptNebulaClient } from '../../src/nebula-client-adapter';

const ORIGIN = 'http://localhost';
const AUTH_PREFIX = '/auth';

async function bootstrapAdmin(browser: Browser, authScope: string, email: string): Promise<void> {
  const mlResp = await browser.fetch(`${ORIGIN}${AUTH_PREFIX}/${authScope}/email-magic-link?_test=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(mlResp.status).toBe(200);
  const { magic_link } = await mlResp.json() as { magic_link: string };
  expect(magic_link).toBeDefined();
  await browser.fetch(magic_link);
}

describe('Phase 0b smoke — harness + factory + real NebulaClient', () => {
  it('factory mirrors connection state when connecting to real Star', async () => {
    const browser = new Browser();
    const authScope = `acme-${crypto.randomUUID().slice(0, 8)}`;
    const activeScope = `${authScope}.app.tenant-a`;
    const email = 'admin@example.com';

    await bootstrapAdmin(browser, authScope, email);

    // Instantiate spike's NebulaClient
    const ctx = browser.context(ORIGIN);
    const client = new NebulaClient({
      baseUrl: ORIGIN,
      authScope,
      activeScope,
      ontologyVersion: 'v1',
      fetch: browser.fetch,
      WebSocket: browser.WebSocket,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
    });

    // Wrap with factory via adapter
    const factory = createNebulaClient(adaptNebulaClient(client), { unsubscribeGraceMs: 100 });

    // Wait for connection
    await vi.waitFor(() => {
      expect(client.connectionState).toBe('connected');
    });

    // The factory should have mirrored the connection state via the
    // adapter's onConnectionStateChange wiring.
    await vi.waitFor(() => {
      expect(factory.store.lmz.connection.state).toBe('connected');
      expect(factory.store.lmz.connection.connected).toBe(true);
    });

    client[Symbol.dispose]();
  });
});
