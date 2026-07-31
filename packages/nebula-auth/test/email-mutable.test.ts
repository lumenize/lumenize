/**
 * Phase 3 — `email` is a mutable attribute (the surrogate `sub` is the identity key), so an
 * email-change is a single one-row update with no cascade / re-key / token re-issue, and `discover`
 * stays `sub`-free. Capable-of-failing (tasks/nebula-auth-surrogate-sub.md Phase 3).
 */
import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { hashString } from '@lumenize/crypto';
import { foundUniverse, requestMagicLink, clickLink, refreshAndParse } from './test-helpers';

function uni(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }
function getRegistry(): any { return env.NEBULA_AUTH_REGISTRY.getByName('registry'); }
async function kvRecord(refreshToken: string): Promise<any> {
  const raw = await (env as any).REFRESH_TOKEN_KV.get(`refresh:${await hashString(refreshToken)}`);
  return raw ? JSON.parse(raw) : null;
}

describe('email as a mutable attribute + safe email-change flow', () => {
  it('an email change is one row: same sub, new address resolves, old does not, tokens stay valid', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'old@example.com');
    const sub = admin.parsed.sub;
    const registry = getRegistry();

    // The sub's refresh token is anchored to `sub`, not email.
    expect((await kvRecord(admin.refreshToken)).sub).toBe(sub);

    // Change the email — a single-row update.
    expect(await registry.changeEmail(sub, 'new@example.com')).toBe(true);

    // discover: the NEW address resolves to the scope; the OLD no longer does.
    expect((await registry.discover('new@example.com')).map((d: any) => d.universeGalaxyStarId)).toEqual([u]);
    expect(await registry.discover('old@example.com')).toEqual([]);

    // The sub's refresh token is STILL valid (KV record is sub-anchored, not email) — refresh works.
    const refreshed = await refreshAndParse(SELF, u, admin.refreshToken);
    expect(refreshed.parsed.sub).toBe(sub);

    // Logging in with the NEW address (find-and-flip) resolves to the SAME sub.
    const ml = await requestMagicLink(SELF, u, 'new@example.com');
    const { magicLinkUrl } = await ml.json() as { magicLinkUrl: string };
    const { refreshToken } = await clickLink(SELF, magicLinkUrl);
    const viaNew = await refreshAndParse(SELF, u, refreshToken);
    expect(viaNew.parsed.sub).toBe(sub);

    // Logging in with the OLD address is rejected (no identity resolves there anymore).
    const oldMl = await requestMagicLink(SELF, u, 'old@example.com');
    const { magicLinkUrl: oldUrl } = await oldMl.json() as { magicLinkUrl: string };
    const oldClick = await SELF.fetch(new Request(oldUrl, { redirect: 'manual' }));
    expect(oldClick.headers.get('Set-Cookie')).toBeNull(); // rejected — old email no longer an identity
  });

  it('changeEmail returns false for an unknown sub', async () => {
    expect(await getRegistry().changeEmail('no-such-sub', 'x@example.com')).toBe(false);
  });

  it('discover is sub-FREE and reads the UNIQUE(email, scope) index', async () => {
    const u = uni();
    await foundUniverse(SELF, u, 'disc@example.com');
    const entries = await getRegistry().discover('disc@example.com');
    expect(entries).toEqual([{ universeGalaxyStarId: u, isAdmin: true }]);
    expect(entries[0]).not.toHaveProperty('sub');
  });
});
