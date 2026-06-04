/**
 * Phase 1 smoke — verify the harness:
 *   - jsdom is the test environment (Alpine has a DOM to bind to)
 *   - globalSetup spawned wrangler-dev
 *   - `Browser` for cookie-aware fetch (auth)
 *   - Node's native `globalThis.WebSocket` (undici) for real WS to wrangler-dev
 *   - Spike's NebulaClient reaches `connected`
 *
 * See task file Phase -1 § 10 for the real-browser fidelity gap that this
 * harness does NOT close.
 */
import { describe, it, expect, vi, inject } from 'vitest';
import { Browser } from '@lumenize/testing';
import { NebulaClient } from '../../src/nebula-client';

const AUTH_PREFIX = '/auth';

async function bootstrapAdmin(browser: Browser, baseUrl: string, authScope: string, email: string): Promise<void> {
  const mlResp = await browser.fetch(`${baseUrl}${AUTH_PREFIX}/${authScope}/email-magic-link?_test=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(mlResp.status).toBe(200);
  const { magic_link } = await mlResp.json() as { magic_link: string };
  await browser.fetch(magic_link);
}

describe('Phase 1 smoke — Node + jsdom + Browser-class against wrangler-dev', () => {
  it('NebulaClient connects to wrangler-dev-served Star + jsdom has a DOM', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    const browser = new Browser();
    const authScope = `acme-${crypto.randomUUID().slice(0, 8)}`;
    const activeScope = `${authScope}.app.tenant-a`;

    await bootstrapAdmin(browser, baseUrl, authScope, 'admin@example.com');

    const ctx = browser.context(baseUrl);
    const client = new NebulaClient({
      baseUrl,
      authScope,
      activeScope,
      ontologyVersion: 'v1',
      fetch: browser.fetch,
      // Native (undici) WebSocket — `browser.WebSocket` routes through
      // SELF.fetch for vitest-pool-workers in-process testing only.
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
    });

    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });

    // jsdom env should give us a `document`.
    expect(typeof document).toBe('object');
    expect(document.body).toBeDefined();

    client[Symbol.dispose]();
  });
});
