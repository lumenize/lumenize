/**
 * Smoke test — end-to-end probes of the browser harness pipeline.
 *
 * Three discrete `it` blocks for triage clarity:
 *
 *   1. boot — Worker boots and serves a non-5xx. Catches the
 *      ts-runtime-parser-validator deps-bundle crash regression.
 *   2. auth — Real magic-link flow via deployed email-test Worker.
 *      Exercises Cloudflare Email Sending → Email Routing → WebSocket push
 *      → Browser cookie jar → /auth/<scope>/refresh-token.
 *   3. round-trip — NebulaClient → Gateway → Star → Galaxy → Star → result
 *      callback. Uses the real magic-link flow, then fires an ontology
 *      registration on Galaxy and a transaction on Star.
 *
 * Why split: when a failure happens, the per-`it` boundary tells you whether
 * the bundle, auth, or mesh path broke without reading the stack trace.
 *
 * About `WebSocket`: the config omits `WebSocket`, so LumenizeClient falls
 * back to `globalThis.WebSocket` (Node 22's native). Browser's WebSocket
 * shim won't work here — its fetch-based upgrade relies on the Cloudflare
 * Workers / miniflare convention where the response carries a `webSocket`
 * property, which a real-network undici fetch doesn't provide. The access
 * JWT rides in the `lmz.access-token.<jwt>` subprotocol either way, so we
 * don't need cookie-aware WS for our auth model. See backlog.md (Testing &
 * Quality) for the option to upgrade the websocket-shim later.
 */

import { describe, it, expect, inject, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { NebulaClient, ROOT_NODE_ID } from '@lumenize/nebula/client';
import { bootstrapAdmin } from './auth-bootstrap';

const ADMIN_EMAIL = 'test@lumenize.io';
const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

/** Star DO state persists in .wrangler/state across runs — use a unique scope per test run. */
function uniqueStar(): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `acme-${suffix}.app.tenant-a`;
}

/**
 * Test-side NebulaClient. The Star round-trip uses the public
 * `client.resources.transaction()` API (Promise-returning, framework-managed
 * eTag) — no `@mesh()` overrides needed for that path. The Galaxy ontology
 * registration still goes through the test-initiator pattern because
 * `appendOntologyVersion` is admin-only and has no public-API surface.
 */
class HarnessNebulaClient extends NebulaClient {
  lastResult: any = undefined;
  lastError: string | undefined = undefined;
  callCompleted = false;

  resetResults(): void {
    this.lastResult = undefined;
    this.lastError = undefined;
    this.callCompleted = false;
  }

  // Generic handler for callXxx initiators that explicitly forward via
  // `this.ctn().handleResult(remote)` — Galaxy ontology registration uses
  // this pattern.
  handleResult(value: any): void {
    if (value instanceof Error) {
      this.lastError = value.message;
      this.lastResult = undefined;
    } else {
      this.lastResult = value;
      this.lastError = undefined;
    }
    this.callCompleted = true;
  }

  callGalaxyAppendOntologyVersion(galaxyName: string, versionConfig: { version: string; types: string }): void {
    this.resetResults();
    const remote = (this.ctn() as any).appendOntologyVersion(versionConfig);
    this.lmz.call('GALAXY', galaxyName, remote, (this.ctn() as any).handleResult(remote));
  }
}

describe('browser harness', () => {
  it('1. boot — Worker serves a non-5xx response', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    expect(baseUrl).toMatch(/^https:\/\//);

    const browser = new Browser();
    const response = await browser.fetch(baseUrl);
    expect(response.status).toBeLessThan(500);
  });

  it('2. auth — magic-link → cookie → refresh-token mints a JWT', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    const testToken = inject('emailTestToken');
    const browser = new Browser();
    const scope = uniqueStar();

    await bootstrapAdmin({ browser, baseUrl, scope, email: ADMIN_EMAIL, testToken });

    expect(browser.getCookie('refresh-token'), 'refresh cookie should be set').toBeDefined();

    const refreshResponse = await browser.fetch(
      `${baseUrl}/auth/${scope}/refresh-token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: scope }),
      },
    );
    expect(refreshResponse.status).toBe(200);
    const tokenBody = await refreshResponse.json() as { access_token: string; sub: string; token_type: string };
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.access_token.split('.')).toHaveLength(3);
  });

  it('3. round-trip — NebulaClient → Gateway → Star → Galaxy → result', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    const testToken = inject('emailTestToken');
    const browser = new Browser();
    const scope = uniqueStar();
    const galaxyName = scope.split('.').slice(0, 2).join('.');

    // 1. Bootstrap admin via real magic-link → cookie captured
    await bootstrapAdmin({ browser, baseUrl, scope, email: ADMIN_EMAIL, testToken });

    // 2. Construct NebulaClient — its internal refresh() uses browser.fetch
    //    (carries the cookie) to mint access JWTs. WebSocket comes from
    //    globalThis.WebSocket (Node native) — see file header.
    const ctx = browser.context(baseUrl);
    const client = new HarnessNebulaClient({
      baseUrl,
      authScope: scope,
      activeScope: scope,
      ontologyVersion: 'v1',
      fetch: browser.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
    });

    try {
      // 3. Wait for WS connection
      await vi.waitFor(() => {
        expect(client.connectionState).toBe('connected');
      });

      // 4. Register an ontology version on the Galaxy. Bootstrap admin email
      //    becomes founder/admin at first instance, which is required for
      //    appendOntologyVersion (gated by requireAdmin).
      client.callGalaxyAppendOntologyVersion(galaxyName, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
      });
      expect(client.lastError, 'ontology registration should not error').toBeUndefined();

      // 5. Fire a transaction creating a single resource on the Star, using
      //    the public `client.resources.transaction()` API. Resolves with a
      //    discriminated union — assert `resolution === 'committed'`.
      const resourceId = crypto.randomUUID();
      const outcome = await client.resources.transaction({
        [resourceId]: {
          op: 'create',
          typeName: 'TestResource',
          nodeId: ROOT_NODE_ID,
          value: { title: 'smoke-test resource' },
        },
      });
      expect(outcome.resolution).toBe('committed');
      if (outcome.resolution === 'committed') {
        expect(outcome.eTag).toBeDefined();
        expect(typeof outcome.eTag).toBe('string');
      }
    } finally {
      // Dispose the client so the WS closes and the test process can exit.
      (client as any)[Symbol.dispose]?.();
    }
  });
});
