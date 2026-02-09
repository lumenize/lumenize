import { describe, it, expect, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { waitForEmail, extractMagicLink } from './email-test-helpers';

// Real email delivery e2e test.
// Requires: RESEND_API_KEY and TEST_TOKEN in .dev.vars,
// deployed email-test Worker, Cloudflare Email Routing for lumenize.io.
//
// Uses Browser (cookie-aware fetch) → SELF.fetch → test-harness Worker →
// createAuthRoutes → routeDORequest → LumenizeAuth DO (in-process).
// This exercises the full production request path including cookie handling.
describe('Magic link e2e (real email delivery)', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('sends magic link via Resend, receives via EmailTestDO, completes auth flow', async () => {
    const testEmail = 'test@lumenize.io';

    // Browser with cookie jar — uses SELF.fetch (the test-harness Worker)
    const browser = new Browser();

    // 1. Set up WebSocket listener BEFORE triggering the email
    const waiter = waitForEmail({ testToken: env.TEST_TOKEN });
    cleanup = waiter.cleanup;

    // 2. Request magic link (NOT test mode — real email sent via Resend)
    const magicLinkResponse = await browser.fetch('http://localhost/auth/email-magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail }),
    });

    expect(magicLinkResponse.status).toBe(200);
    const magicLinkBody = await magicLinkResponse.json() as any;
    // In non-test mode, response doesn't include the magic link — just confirmation
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
    // Use redirect: 'manual' because Location is '/app' (a client-side route)
    const clickResponse = await browser.fetch(magicLinkUrl, { redirect: 'manual' });

    expect(clickResponse.status).toBe(302);
    expect(clickResponse.headers.get('Location')).toBe('/app');

    // Verify cookie was captured by the Browser's cookie jar
    const refreshTokenCookie = browser.getCookie('refresh-token');
    expect(refreshTokenCookie).toBeDefined();

    // Also verify raw Set-Cookie attributes
    const setCookie = clickResponse.headers.get('Set-Cookie');
    expect(setCookie).toContain('refresh-token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');

    // 6. Exchange refresh token for access token — Browser sends cookie automatically
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

    // 8. Verify refresh token rotation — cookie jar has new value
    const rotatedCookie = browser.getCookie('refresh-token');
    expect(rotatedCookie).toBeDefined();
    expect(rotatedCookie).not.toBe(refreshTokenCookie);

    cleanup();
  });

  it('magic link is single-use', async () => {
    const testEmail = 'test@lumenize.io';
    const browser = new Browser();

    // 1. Set up WebSocket listener and request magic link
    const waiter = waitForEmail({ testToken: env.TEST_TOKEN });
    cleanup = waiter.cleanup;

    await browser.fetch('http://localhost/auth/email-magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail }),
    });

    // 2. Wait for email and extract link
    const email = await waiter.emailPromise;
    const magicLinkUrl = extractMagicLink(email);

    // 3. First click — should succeed, cookie captured
    const firstClick = await browser.fetch(magicLinkUrl, { redirect: 'manual' });
    expect(firstClick.status).toBe(302);
    expect(firstClick.headers.get('Location')).toBe('/app');
    expect(browser.getCookie('refresh-token')).toBeDefined();

    // 4. Second click — should fail (token consumed)
    const secondClick = await browser.fetch(magicLinkUrl, { redirect: 'manual' });
    expect(secondClick.status).toBe(302);
    expect(secondClick.headers.get('Location')).toContain('error=invalid_token');

    cleanup();
  });
});
