/**
 * Bootstrap-ARRAY (the `_platform` superuser) — the comma-separated `AUTH_BOOTSTRAP_EMAIL` list.
 *
 * Bootstrap membership is minted at CONSUME by the shared registry consume — behind mailbox proof,
 * gated on the ADDRESS being configured, and left UNACCEPTED. The link REQUEST mints nothing at all,
 * and what bounds the blast radius is that the membership mints no token until it is accepted.
 * This targets what the
 * ARRAY widening adds: a SECOND listed email (beyond index 0), with a leading space + mixed case in
 * the config, is recognized ONLY because the getter normalizes PER ELEMENT — a raw `String.includes`
 * on the joined value, or a scalar index-0 getter, reds these.
 *
 * vitest.config sets `AUTH_BOOTSTRAP_EMAIL='bootstrap-admin@example.com, Second-Bootstrap@Example.com'`.
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { requestMagicLink, platformLogin, expectNoSession, consumeLink } from './test-helpers';
import { PLATFORM_SCOPE } from '../../src/auth/types';

const SECOND_BOOTSTRAP = 'second-bootstrap@example.com'; // the config entry is mixed-case + leading space

// `platformLogin` was the file-local helper here; it is now shared (test-helpers.ts) because the
// impersonation mint's tests need the same rung-1 platform principal for their widest-path case.

describe('Bootstrap-array (* super-admin) at _platform', () => {
  it('the SECOND listed bootstrap email → a platform admin (array membership, per-element normalized)', async () => {
    const { parsed } = await platformLogin(SELF, SECOND_BOOTSTRAP);
    // Reds if the getter honors only index 0, or does a raw String.includes on the joined value
    // ('…, Second-Bootstrap@Example.com' does NOT contain 'second-bootstrap@example.com').
    expect(parsed.access.authScope).toBe('_platform');
    expect(parsed.access.scopeAdmin).toBe(true);
  });

  it('the FIRST listed bootstrap email → a platform admin', async () => {
    const { parsed } = await platformLogin(SELF, 'bootstrap-admin@example.com');
    expect(parsed.access.authScope).toBe('_platform');
    expect(parsed.access.scopeAdmin).toBe(true);
  });

  it('a NON-listed email at _platform is NOT minted → login rejected (control: bootstrap ≠ open)', async () => {
    const ml = await requestMagicLink(SELF, 'random@example.com');
    expect(ml.status).toBe(200);
    const { magicLinkUrl } = await ml.json() as { magicLinkUrl: string };
    // The click proves their mailbox and mints NOTHING — the `#bootstrapEmails` conjunct is the whole
    // gate. A proved address with no memberships is a new user, so they land on signup; what this
    // control asserts is the absent membership and the absent session.
    const clickResp = await consumeLink(SELF, magicLinkUrl);
    expect((await clickResp.clone().json() as { redirect: string }).redirect).toBe('/auth/signup');
    expectNoSession(clickResp);
  });
});
