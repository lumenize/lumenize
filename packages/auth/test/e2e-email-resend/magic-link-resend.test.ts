import { describe, it, expect, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { waitForEmail, extractMagicLink } from '../e2e-email/email-test-helpers';

// Resend e2e smoke test — keeps the Resend transport path exercised alongside
// the default Cloudflare transport path (see test/e2e-email/).
//
// Requires: RESEND_API_KEY and TEST_TOKEN in .dev.vars, test.lumenize.com
// verified as a Resend sending domain, deployed email-test Worker, Cloudflare
// Email Routing for lumenize.io.
describe('Magic link e2e (real email delivery via Resend)', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('sends magic link via Resend, receives via EmailTestDO, completes auth flow', async () => {
    const testEmail = 'test@lumenize.io';
    const browser = new Browser();

    // 45s email-wait window — wider than the 20s default because Resend's
    // HTTPS delivery is more variable than Cloudflare Email Sending's
    // in-process binding. The vitest project testTimeout is bumped to 60s to
    // hold this plus the click round-trip.
    const waiter = waitForEmail({ testToken: env.TEST_TOKEN, timeout: 45000 });
    cleanup = waiter.cleanup;

    const magicLinkResponse = await browser.fetch('http://localhost/auth/email-magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail }),
    });

    expect(magicLinkResponse.status).toBe(200);

    const email = await waiter.emailPromise;
    expect(email.subject).toBe('Your login link');
    expect(email.to?.[0]?.address).toBe(testEmail);
    expect(email.from?.address).toBe('auth@test.lumenize.com');

    const magicLinkUrl = extractMagicLink(email);
    expect(magicLinkUrl).toContain('one_time_token=');

    const clickResponse = await browser.fetch(magicLinkUrl, { redirect: 'manual' });
    expect(clickResponse.status).toBe(302);
    expect(clickResponse.headers.get('Location')).toBe('/app');
    expect(browser.getCookie('refresh-token')).toBeDefined();

    cleanup();
  });
});
