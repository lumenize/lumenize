/**
 * Bootstrap-ARRAY (`*` super-admin) — the comma-separated `NEBULA_AUTH_BOOTSTRAP_EMAIL` list.
 *
 * In the dissolved-DO model (tasks/nebula-auth-surrogate-sub.md) bootstrap is **scope-gated to
 * `nebula-platform`** and is the ONLY email-magic-link mint (§Blast radius). This targets what the
 * ARRAY widening adds: a SECOND listed email (beyond index 0), with a leading space + mixed case in
 * the config, is recognized ONLY because the getter normalizes PER ELEMENT — a raw `String.includes`
 * on the joined value, or a scalar index-0 getter, reds these.
 *
 * vitest.config sets `NEBULA_AUTH_BOOTSTRAP_EMAIL='bootstrap-admin@example.com, Second-Bootstrap@Example.com'`.
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { requestMagicLink, clickLink, refreshAndParse } from './test-helpers';
import { PLATFORM_INSTANCE_NAME } from '../src/types';

const SECOND_BOOTSTRAP = 'second-bootstrap@example.com'; // the config entry is mixed-case + leading space

/** Log in at nebula-platform via the bootstrap mint → parsed JWT payload. */
async function platformLogin(email: string) {
  const ml = await requestMagicLink(SELF, PLATFORM_INSTANCE_NAME, email);
  expect(ml.status).toBe(200);
  const { magicLinkUrl } = await ml.json() as { magicLinkUrl: string };
  const { refreshToken } = await clickLink(SELF, magicLinkUrl);
  return refreshAndParse(SELF, PLATFORM_INSTANCE_NAME, refreshToken);
}

describe('Bootstrap-array (* super-admin) at nebula-platform', () => {
  it('the SECOND listed bootstrap email → a `*` platform admin (array membership, per-element normalized)', async () => {
    const { parsed } = await platformLogin(SECOND_BOOTSTRAP);
    // Reds if the getter honors only index 0, or does a raw String.includes on the joined value
    // ('…, Second-Bootstrap@Example.com' does NOT contain 'second-bootstrap@example.com').
    expect(parsed.access.authScopePattern).toBe('*');
    expect(parsed.access.admin).toBe(true);
  });

  it('the FIRST listed bootstrap email → a `*` platform admin', async () => {
    const { parsed } = await platformLogin('bootstrap-admin@example.com');
    expect(parsed.access.authScopePattern).toBe('*');
    expect(parsed.access.admin).toBe(true);
  });

  it('a NON-listed email at nebula-platform is NOT minted → login rejected (control: bootstrap ≠ open)', async () => {
    const ml = await requestMagicLink(SELF, PLATFORM_INSTANCE_NAME, 'random@example.com');
    expect(ml.status).toBe(200);
    const { magicLinkUrl } = await ml.json() as { magicLinkUrl: string };
    const clickResp = await SELF.fetch(new Request(magicLinkUrl, { redirect: 'manual' }));
    expect(clickResp.headers.get('Location')).toContain('error=invalid_token'); // no identity minted
    expect(clickResp.headers.get('Set-Cookie')).toBeNull();
  });
});
