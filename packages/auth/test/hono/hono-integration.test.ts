import { describe, it, expect, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { waitForEmail, extractMagicLink } from '../e2e-email/email-test-helpers';

// Real email delivery e2e test — same flow as e2e-email but routed through Hono.
// Requires: RESEND_API_KEY and TEST_TOKEN in .dev.vars,
// deployed email-test Worker, Cloudflare Email Routing for lumenize.io.
//
// Uses Browser (cookie-aware fetch) → SELF.fetch → Hono app → createAuthRoutes →
// routeDORequest → LumenizeAuth DO (in-process).
describe('Hono integration (real email delivery)', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('sends magic link via Hono-routed auth, completes auth flow, then connects WebSocket', async () => {
    const testEmail = 'test@lumenize.io';

    // Browser with cookie jar — uses SELF.fetch (the Hono test-harness Worker)
    const browser = new Browser();

    // 1. Set up WebSocket listener BEFORE triggering the email
    const waiter = waitForEmail({ testToken: env.TEST_TOKEN });
    cleanup = waiter.cleanup;

    // 2. Request magic link through Hono middleware
    const magicLinkResponse = await browser.fetch('http://localhost/auth/email-magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail }),
    });

    expect(magicLinkResponse.status).toBe(200);
    const magicLinkBody = await magicLinkResponse.json() as any;
    expect(magicLinkBody.message).toBe('Check your email for the magic link');

    // 3. Wait for the email to arrive at the deployed EmailTestDO
    const email = await waiter.emailPromise;

    expect(email.subject).toBe('Your login link');
    expect(email.to?.[0]?.address).toBe(testEmail);
    expect(email.from?.address).toBe('auth@test.lumenize.com');

    // 4. Extract magic link URL from the email HTML
    const magicLinkUrl = extractMagicLink(email);
    expect(magicLinkUrl).toContain('one_time_token=');

    // 5. Click the magic link — Browser captures Set-Cookie into cookie jar
    const clickResponse = await browser.fetch(magicLinkUrl, { redirect: 'manual' });

    expect(clickResponse.status).toBe(302);
    expect(clickResponse.headers.get('Location')).toBe('/app');

    // Verify cookie was captured
    const refreshTokenCookie = browser.getCookie('refresh-token');
    expect(refreshTokenCookie).toBeDefined();

    const setCookie = clickResponse.headers.get('Set-Cookie');
    expect(setCookie).toContain('refresh-token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');

    // 6. Exchange refresh token for access token
    const refreshResponse = await browser.fetch('http://localhost/auth/refresh-token', {
      method: 'POST',
    });

    expect(refreshResponse.status).toBe(200);
    const tokenBody = await refreshResponse.json() as any;
    expect(tokenBody.access_token).toBeDefined();
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.expires_in).toBeGreaterThan(0);
    expect(tokenBody.sub).toBeDefined();

    // 7. Verify JWT structure
    const jwtParts = tokenBody.access_token.split('.');
    expect(jwtParts).toHaveLength(3);

    // 8. Verify refresh token rotation
    const rotatedCookie = browser.getCookie('refresh-token');
    expect(rotatedCookie).toBeDefined();
    expect(rotatedCookie).not.toBe(refreshTokenCookie);

    // 9. Open authenticated WebSocket through Hono — token in subprotocol
    const accessToken = tokenBody.access_token;
    const ws = new browser.WebSocket(
      'ws://localhost/ws/echo-test',
      ['lmz', `lmz.access-token.${accessToken}`],
    );

    // Wait for connection to open
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
      setTimeout(() => reject(new Error('WebSocket open timeout')), 5000);
    });

    // 10. Send a message and verify echo
    const echoPromise = new Promise<string>((resolve, reject) => {
      ws.addEventListener('message', (e: MessageEvent) => resolve(e.data as string));
      setTimeout(() => reject(new Error('Echo timeout')), 5000);
    });

    ws.send('hello from hono');
    const echoResponse = await echoPromise;
    expect(echoResponse).toBe('echo: hello from hono');

    ws.close();
    cleanup();
  });

  it('rejects WebSocket without auth token', async () => {
    // WebSocket upgrade with no token in subprotocol — should get 401
    const response = await SELF.fetch('http://localhost/ws/echo-test', {
      headers: {
        'Upgrade': 'websocket',
        'Sec-WebSocket-Protocol': 'lmz',
      },
    });

    expect(response.status).toBe(401);
  });

  it('returns 404 for non-auth routes', async () => {
    const response = await SELF.fetch('http://localhost/api/something');
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
  });
});
