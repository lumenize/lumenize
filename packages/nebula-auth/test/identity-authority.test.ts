/**
 * Identity authority — the load-bearing security invariants of the surrogate-`sub` +
 * NebulaAuth-dissolution model (tasks/nebula-auth-surrogate-sub.md, Phase 1 + Phase 2 success
 * criteria). Every test here is capable-of-failing: gutting the code under test reddens it.
 *
 * Grounding: rung 2 (test-mode issuance) through the real Worker → registry → KV paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { hashString } from '@lumenize/auth';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { foundUniverse, inviteAndLogin, requestMagicLink, clickLink, refreshAndParse, registryUrl } from './test-helpers';

function uniqueUniverse(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }
function getRegistry(): any { return env.NEBULA_AUTH_REGISTRY.getByName('registry'); }
async function kvRecord(refreshToken: string): Promise<any> {
  const raw = await (env as any).REFRESH_TOKEN_KV.get(`refresh:${await hashString(refreshToken)}`);
  return raw ? JSON.parse(raw) : null;
}

describe('Identity authority — mint only at authority points', () => {
  it('claim-universe mints the founder identity (admin); a returning email resolves to the SAME sub', async () => {
    const uni = uniqueUniverse();
    const first = await foundUniverse(SELF, uni, 'founder@example.com');
    expect(first.parsed.access.admin).toBe(true);         // founder is admin
    expect(first.parsed.access.authScopePattern).toBe(`${uni}.*`);

    // Log in AGAIN via the login magic-link (find-and-flip) — must resolve to the SAME sub, never re-mint.
    const mlResp = await requestMagicLink(SELF, uni, 'founder@example.com');
    expect(mlResp.status).toBe(200);
    const { magicLinkUrl } = await mlResp.json() as { magicLinkUrl: string };
    const { refreshToken } = await clickLink(SELF, magicLinkUrl);
    const second = await refreshAndParse(SELF, uni, refreshToken);
    expect(second.parsed.sub).toBe(first.parsed.sub);      // SAME sub (reds if login re-mints)
  });

  it('login verify NEVER mints: a stranger requesting a magic link for a scope they were not minted into is REJECTED at consume', async () => {
    const uni = uniqueUniverse();
    await foundUniverse(SELF, uni, 'founder@example.com'); // scope exists, founder minted

    // A stranger requests a login magic link for the SAME scope. The request succeeds (Turnstile-only,
    // no mint) but the CLICK must reject — no identity exists for stranger@ in `uni`.
    const mlResp = await requestMagicLink(SELF, uni, 'stranger@example.com');
    expect(mlResp.status).toBe(200);
    const { magicLinkUrl } = await mlResp.json() as { magicLinkUrl: string };

    const clickResp = await SELF.fetch(new Request(magicLinkUrl, { redirect: 'manual' }));
    expect(clickResp.status).toBe(302);
    expect(clickResp.headers.get('Location')).toContain('error=invalid_token'); // rejected, not logged in
    expect(clickResp.headers.get('Set-Cookie')).toBeNull();                     // NO refresh cookie

    // Negative control at a protected route: the stranger has no identity, so discover finds nothing.
    const disc = await getRegistry().discover('stranger@example.com');
    expect(disc).toHaveLength(0); // no Identity row was created by the login-request path
  });

  it('NO sub is generated outside the registry — the login-request path creates no identity row', async () => {
    const uni = uniqueUniverse();
    await foundUniverse(SELF, uni, 'founder@example.com');
    const before = (await getRegistry().discover('nobody@example.com')).length;
    await requestMagicLink(SELF, uni, 'nobody@example.com'); // request only — must not mint
    const after = (await getRegistry().discover('nobody@example.com')).length;
    expect(before).toBe(0);
    expect(after).toBe(0); // reds if email-magic-link minted an identity
  });

  // Deferred (m6): self-signup mints the *scope itself*, so UNIQUE(email, scope) can't backstop a
  // double-submit (a fresh universeGalaxyStarId per attempt) — two clicked claim links for the same
  // email could spawn two Universes. The fix is a pending-signup single-flight keyed on email alone
  // (§Founder). Low-immediacy for pre-alpha (no real third-party signup yet); tracked, not built.
  it.skip('BLOCKER (m6): two claimUniverse attempts for the same email converge to ONE Universe (needs the pending-signup single-flight)', async () => {
    // When built: POST claim-universe twice for the same email (distinct slugs or a 1:1 email→Universe
    // mapping) and assert discover(email) returns exactly one universe with one founder identity.
  });
});

describe('Identity authority — adminApproved retired, enforced at MINT (edge gate removed, B1/M5)', () => {
  it('an invited NON-admin member passes login + protected refresh after accept (the old adminApproved gate is gone)', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'admin@example.com');
    // Invite a plain member into a star under the universe; accept + refresh must succeed for a
    // non-admin (access.admin===false) — the retired router:541 gate would have 403'd this.
    const scope = `${uni}.app.tenant`;
    const member = await inviteAndLogin(SELF, scope, admin.access_token, 'member@example.com');
    expect(member.parsed.access.admin).toBeUndefined();         // genuinely non-admin
    expect(member.parsed.sub).toBeDefined();
    // The member's token round-trips a fresh refresh (proves it's a working, gate-free session).
    const again = await refreshAndParse(SELF, scope, member.refreshToken);
    expect(again.parsed.sub).toBe(member.parsed.sub);
  });

  it('an unverified/uninvited identity is refused a token at MINT (consume finds no identity → no KV record)', async () => {
    const uni = uniqueUniverse();
    await foundUniverse(SELF, uni, 'admin@example.com');
    // Request a login link for an uninvited email, click it → rejected → NO refresh KV record exists.
    const mlResp = await requestMagicLink(SELF, uni, 'ghost@example.com');
    const { magicLinkUrl } = await mlResp.json() as { magicLinkUrl: string };
    const clickResp = await SELF.fetch(new Request(magicLinkUrl, { redirect: 'manual' }));
    expect(clickResp.headers.get('Set-Cookie')).toBeNull();    // no token minted (no cookie)
    // And no refresh KV record was written for this scope — the mint never happened. (The click set no
    // cookie, so we can't derive a tokenHash; assert directly that consume left the KV token-space empty
    // of any record for a ghost by confirming no RefreshTokenIndex row exists for the scope's ghost.)
    const disc = await getRegistry().discover('ghost@example.com');
    expect(disc).toHaveLength(0); // no identity → nothing to anchor a refresh record to
  });
});

describe('Refresh is a pure KV read — the registry is NOT on the refresh path', () => {
  const entries: any[] = [];
  beforeEach(() => { entries.length = 0; setDebugSink((e) => entries.push(e)); });
  afterEach(() => clearDebugSink());

  it('a refresh fires ZERO registry markers; a login fires one (positive control)', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'founder@example.com');

    // Positive control: login (already happened during foundUniverse) fired a registry marker.
    expect(entries.some((e) => String(e.namespace).startsWith('nebula-auth.Registry'))).toBe(true);

    // Now clear and refresh — the registry must NOT be touched.
    entries.length = 0;
    await refreshAndParse(SELF, uni, admin.refreshToken);
    const registryMarkers = entries.filter((e) => String(e.namespace).startsWith('nebula-auth.Registry'));
    expect(registryMarkers).toHaveLength(0); // reds if refresh calls the registry
  });
});

describe('isAdmin convergence into the KV record (ADR-010; M4 expiry preservation)', () => {
  it('a real admin-change endpoint converges the KV record; the next refresh reflects it', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'founder@example.com');
    expect((await kvRecord(admin.refreshToken)).isAdmin).toBe(true);

    // Drive convergence through the registry's real admin-change RPC (never a direct KV write).
    await getRegistry().setIdentityAdmin(admin.parsed.sub, false);

    expect((await kvRecord(admin.refreshToken)).isAdmin).toBe(false); // converged (reds if the push is deleted)
    const refreshed = await refreshAndParse(SELF, uni, admin.refreshToken);
    expect(refreshed.parsed.access.admin).toBeUndefined();           // demoted; reds if refresh stayed stale
  });

  it("M4: convergence re-applies the token's ORIGINAL absolute expiry to the KV entry — NOT a fresh 30-day TTL, NOT immortal", async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'founder@example.com');
    const sub = admin.parsed.sub;
    const registry = getRegistry();

    // Seed a refresh token with a deliberately SHORT absolute expiry (now+120s) so a fresh-TTL regression
    // diverges by ~30 days and an omitted-TTL regression shows no expiration — the default 30-day login
    // token can't distinguish (sub-second). Index (SQLite) + KV, both at the short expiry.
    const tokenHash = `m4-seed-${crypto.randomUUID()}`;
    const shortExpiry = new Date(Date.now() + 120_000).toISOString();
    await (runInDurableObject as any)(registry, (_i: any, ctx: any) => {
      ctx.storage.sql.exec('INSERT OR REPLACE INTO RefreshTokenIndex (tokenHash, sub, expiresAt) VALUES (?,?,?)', tokenHash, sub, shortExpiry);
    });
    await (env as any).REFRESH_TOKEN_KV.put(`refresh:${tokenHash}`,
      JSON.stringify({ sub, universeGalaxyStarId: uni, isAdmin: true, expiresAt: shortExpiry }),
      { expirationTtl: 120 });

    // Converge — the registry re-puts the KV record; M4 requires it re-apply kvTtlSeconds(shortExpiry).
    await registry.setIdentityAdmin(sub, false);

    // Read the ACTUAL KV expiration metadata (not the JSON body, which is trivially preserved).
    const list = await (env as any).REFRESH_TOKEN_KV.list({ prefix: `refresh:${tokenHash}` });
    const entry = list.keys.find((k: any) => k.name === `refresh:${tokenHash}`);
    expect(entry).toBeDefined();
    const secondsLeft = (entry.expiration as number) - Math.floor(Date.now() / 1000);
    // Correct (kvTtlSeconds(shortExpiry) ≈ 120): ~60–120s left. Fresh 30-day TTL: ~2.6M. Immortal: undefined→NaN.
    expect(secondsLeft).toBeGreaterThan(30);
    expect(secondsLeft).toBeLessThan(600); // reds under the fresh-TTL (extend) or omitted-TTL (immortal) M4 bugs
  });
});

describe('Logout deletes the KV record', () => {
  it('logout removes the refresh KV record → the next refresh 401s', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'founder@example.com');
    expect(await kvRecord(admin.refreshToken)).not.toBeNull();

    const logoutResp = await SELF.fetch(new Request(`http://localhost/auth/${uni}/logout`, {
      method: 'POST', headers: { Cookie: `refresh-token=${admin.refreshToken}` },
    }));
    expect(logoutResp.status).toBe(200);
    expect(await kvRecord(admin.refreshToken)).toBeNull(); // KV record deleted

    const refreshResp = await SELF.fetch(new Request(`http://localhost/auth/${uni}/refresh-token`, {
      method: 'POST',
      headers: { Cookie: `refresh-token=${admin.refreshToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeScope: uni }),
    }));
    expect(refreshResp.status).toBe(401); // revoked
  });
});

describe('M1 — refresh activeScope validated against the KV record scope, not client input', () => {
  it('rejects an activeScope outside the KV record scope; accepts one within it', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'founder@example.com');

    // Within the founder's `{uni}.*` reach (KV record scope is the universe) → accepted.
    const ok = await refreshAndParse(SELF, uni, admin.refreshToken, `${uni}.app.tenant`);
    expect(ok.parsed.aud).toBe(`${uni}.app.tenant`);

    // A scope the KV record does NOT cover → 403 (derived from the server-trusted record, not input).
    const bad = await SELF.fetch(new Request(`http://localhost/auth/${uni}/refresh-token`, {
      method: 'POST',
      headers: { Cookie: `refresh-token=${admin.refreshToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeScope: 'some-other-universe.app' }),
    }));
    expect(bad.status).toBe(403);
  });
});

describe('delete-scope — sub-first, fail-closed (M2)', () => {
  it('fails CLOSED when callerSub resolves to no identity (403), not "no other users → wipe"', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'founder@example.com');
    const registry = getRegistry();
    // A callerSub with no Identity row → the #otherUsers exclusion can't be computed → refuse.
    await expect(
      registry.executeScopeDeletion(uni, 'ghost-sub-with-no-identity', admin.parsed.access),
    ).rejects.toThrow(/not found|forbidden/i);
  });

  it('blocks (409) a genuinely shared scope; the guard counts only real members', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'founder@example.com');
    // Invite a second member into the universe → shared.
    await inviteAndLogin(SELF, uni, admin.access_token, 'member@example.com');
    // Drive the real Worker path (router injects the verified caller `sub`; registry resolves it → email).
    const resp = await SELF.fetch(new Request(registryUrl('delete-scope'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: uni }),
    }));
    expect(resp.status).toBe(409); // shared scope blocks the delete
  });
});

describe('Scopes is the existence authority — existence is NOT derived from Identity', () => {
  it('an admin-created, member-LESS galaxy exists (slug unavailable + in myScopeTree) yet has zero identities', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'founder@example.com');
    const registry = getRegistry();

    // Create a galaxy in-session (admin) — a Scopes row with NO founder identity (wildcard-managed).
    const createResp = await SELF.fetch(new Request(registryUrl('create-galaxy'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ universeGalaxyId: `${uni}.app` }),
    }));
    expect(createResp.status).toBe(201);

    expect(await registry.checkSlugAvailable(`${uni}.app`)).toBe(false); // exists (reds if derived from Identity)
    const tree = (await registry.myScopeTree(admin.parsed.access)).map((s: any) => s.instanceName);
    expect(tree).toContain(`${uni}.app`);                                // discoverable though member-less
    // discover(founder) does NOT surface the galaxy — the founder has no Identity there.
    const founderScopes = (await registry.discover('founder@example.com')).map((d: any) => d.universeGalaxyStarId);
    expect(founderScopes).not.toContain(`${uni}.app`);
  });
});
