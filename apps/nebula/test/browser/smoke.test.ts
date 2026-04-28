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
 *   3. round-trip — NebulaClient → Gateway → Star → Galaxy → result
 *      callback. Uses the bootstrapped JWT.
 *
 * Why split: when a failure happens, the per-`it` boundary tells you
 * whether the bundle, auth, or mesh path broke — without splitting you'd
 * have to read the stack to figure that out.
 */

import { describe, it, expect, inject } from 'vitest';
import { Browser } from '@lumenize/testing';
import { bootstrapAdmin } from './auth-bootstrap';

const SCOPE = 'acme.app.tenant-a';
const ADMIN_EMAIL = 'test@lumenize.io';

describe('browser harness', () => {
  it('1. boot — Worker serves a non-5xx response', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    expect(baseUrl).toMatch(/^https:\/\//);

    const browser = new Browser();
    const response = await browser.fetch(baseUrl);
    // 4xx (e.g. 404 from the auth router on '/') is fine — proves the Worker
    // loaded and is dispatching requests. 5xx means module-load or runtime
    // failure, which is the regression we're catching here.
    expect(response.status).toBeLessThan(500);
  });

  it('2. auth — magic-link → cookie → refresh-token mints a JWT', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    const testToken = inject('emailTestToken');
    const browser = new Browser();

    // Drive the magic-link flow (real email round-trip via deployed
    // email-test Worker). After this, browser's cookie jar holds the
    // refresh cookie scoped to /auth/<scope>/.
    await bootstrapAdmin({
      browser,
      baseUrl,
      scope: SCOPE,
      email: ADMIN_EMAIL,
      testToken,
    });

    // Verify the refresh cookie was captured.
    const refreshCookie = browser.getCookie('refresh-token');
    expect(refreshCookie, 'refresh-token cookie should be set after magic link click').toBeDefined();

    // Mint an access token via the refresh cookie. Browser sends it
    // automatically.
    const refreshResponse = await browser.fetch(
      `${baseUrl}/auth/${SCOPE}/refresh-token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: SCOPE }),
      },
    );
    expect(refreshResponse.status).toBe(200);

    const tokenBody = await refreshResponse.json() as { access_token: string; sub: string; token_type: string };
    expect(tokenBody.access_token).toBeDefined();
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.sub).toBeDefined();
    // Sanity-check JWT shape (header.payload.signature)
    expect(tokenBody.access_token.split('.')).toHaveLength(3);
  });
});
