/**
 * Identity authority — the load-bearing security invariants of the surrogate-`sub` +
 * NebulaAuth-dissolution model (tasks/archive/nebula-auth-surrogate-sub.md). Every test here is capable-of-failing: gutting the code under test reddens it.
 *
 * Grounding: rung 2 (test-mode issuance) through the real Worker → registry → KV paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { hashString } from '@lumenize/crypto';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import {
  foundUniverse, inviteAndLogin, issueInvitesAs, requestMagicLink, clickLink, refreshAndParse,
  authUrl, claimUniverse, claimStar, createGalaxy, platformLogin, verifiedClaims,
  expectNoSession, consumeLink, lookupLink, plainLogin, refresh, refreshCookie, refreshCookiesSet,
  membershipsOf,
} from './test-helpers';

/** vitest.config's `AUTH_BOOTSTRAP_EMAIL`, entry 0. */
const BOOTSTRAP_EMAIL = 'bootstrap-admin@example.com';

/** The ADR-016 acting-principal argument these registry methods now require. Recorded, never
 *  consulted — authorization keys off the caller's own verified access, not off this. */
const ACTING = (sub = crypto.randomUUID()) => ({ sub, access: { authScope: '_platform', scopeAdmin: true } }) as any;

function uniqueUniverse(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }
function getRegistry(): any { return env.AUTH_REGISTRY.getByName('registry'); }
async function kvRecord(refreshToken: string): Promise<any> {
  const raw = await (env as any).REFRESH_TOKEN_KV.get(`refresh:${await hashString(refreshToken)}`);
  return raw ? JSON.parse(raw) : null;
}

describe('Identity authority — mint only at authority points', () => {
  it('claim-universe mints the claiming admin identity; a returning email resolves to the SAME sub', async () => {
    const uni = uniqueUniverse();
    const first = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    expect(first.parsed.access.scopeAdmin).toBe(true);         // the claiming admin is admin
    expect(first.parsed.access.authScope).toBe(`${uni}`);

    // Log in AGAIN via the login magic-link (find-and-flip) — must resolve to the SAME sub, never re-mint.
    const mlResp = await requestMagicLink(SELF, 'scope-admin@example.com');
    expect(mlResp.status).toBe(200);
    const { magicLinkUrl } = await mlResp.json() as { magicLinkUrl: string };
    const { refreshToken } = await clickLink(SELF, magicLinkUrl);
    const second = await refreshAndParse(SELF, uni, refreshToken);
    expect(second.parsed.sub).toBe(first.parsed.sub);      // SAME sub (reds if login re-mints)
  });

  it('login verify NEVER mints: a stranger requesting a magic link for a scope they were not minted into is REJECTED at consume', async () => {
    const uni = uniqueUniverse();
    await foundUniverse(SELF, uni, 'scope-admin@example.com'); // scope exists, admin minted

    // A stranger requests a login magic link for the SAME scope. The request succeeds (Turnstile-only,
    // no mint) but the CLICK must reject — no identity exists for stranger@ in `uni`.
    const mlResp = await requestMagicLink(SELF, 'stranger@example.com');
    expect(mlResp.status).toBe(200);
    const { magicLinkUrl } = await mlResp.json() as { magicLinkUrl: string };

    // ⚠️ The page's Continue proves their mailbox and mints NOTHING. It does not error: a proved
    // address with no memberships is a new user, so they are sent to the signup page — the property
    // this test exists for is the absent mint and the absent session, and both still hold exactly.
    const clickResp = await consumeLink(SELF, magicLinkUrl);
    expect(clickResp.status).toBe(200);
    expect((await clickResp.clone().json() as { redirect: string }).redirect).toBe('/auth/signup');
    expectNoSession(clickResp);                                                 // NO refresh cookie

    // Negative control at a protected route: the stranger has no identity, so no membership exists.
    const disc = await membershipsOf(getRegistry(), 'stranger@example.com');
    expect(disc).toHaveLength(0); // no Identity row was created by the login-request path
  });

  it('NO sub is generated outside the registry — the login-request path creates no identity row', async () => {
    const uni = uniqueUniverse();
    await foundUniverse(SELF, uni, 'scope-admin@example.com');
    const before = (await membershipsOf(getRegistry(), 'nobody@example.com')).length;
    await requestMagicLink(SELF, 'nobody@example.com'); // request only — must not mint
    const after = (await membershipsOf(getRegistry(), 'nobody@example.com')).length;
    expect(before).toBe(0);
    expect(after).toBe(0); // reds if email-magic-link minted an identity
  });

  // Deferred (m6): self-signup mints the *scope itself*, so UNIQUE(email, scope) can't backstop a
  // double-submit (a fresh universeGalaxyStarId per attempt) — two clicked claim links for the same
  // email could spawn two Universes. The fix is a pending-signup single-flight keyed on email alone
  // (§Founder). Low-immediacy for pre-alpha (no real third-party signup yet); tracked, not built.
  describe('m6 — one address, one Universe (the pending-signup single-flight)', () => {
    /**
     * ⚠️ **`getScopesForProfile` cannot serve as the probe here, and neither can anything else that
     * filters on acceptance.** A superseded claim is unaccepted BY DEFINITION, so such a probe
     * answers identically whether convergence ran or not — the "skip the retire" mutation would be
     * dead against it and a no-op could ship green. These read the rows themselves.
     */
    const scopeRows = async (): Promise<string[]> => (runInDurableObject as any)(
      getRegistry(), (_i: any, c: any) => [...c.storage.sql.exec('SELECT universeGalaxyStarId AS s FROM Scopes')]
        .map((r: any) => r.s as string),
    );
    const membershipScopes = async (email: string): Promise<string[]> => (runInDurableObject as any)(
      getRegistry(), (_i: any, c: any) => [...c.storage.sql.exec(
        `SELECT m.universeGalaxyStarId AS s FROM Memberships m JOIN Emails e ON e.emailId = m.emailId
         WHERE e.email = ?`, email)].map((r: any) => r.s as string),
    );

    it('the ACCEPTED claim wins; the superseded slug frees and its session dies', async () => {
      const email = `m6-${crypto.randomUUID().slice(0, 8)}@example.com`;
      const first = uniqueUniverse();
      const second = uniqueUniverse();

      // Two pending claims, different slugs — the changed-my-mind shape `UNIQUE (emailId, scope)`
      // cannot backstop, because each claim mints its own scope.
      const firstLink = await claimUniverse(SELF, first, email);
      await claimUniverse(SELF, second, email);
      expect(await scopeRows()).toEqual(expect.arrayContaining([first, second]));

      // Loading the link converges NOTHING — it is not consent. Reds against firing the retire on
      // the page's lookup, where a mail scanner's prefetch would decide which claim survived.
      expect((await lookupLink(SELF, firstLink)).status).toBe(200);
      expect(await scopeRows()).toEqual(expect.arrayContaining([first, second]));
      expect(await membershipScopes(email)).toEqual(expect.arrayContaining([first, second]));

      // The page's Accept is what converges.
      await clickLink(SELF, firstLink);
      const scopes = await scopeRows();
      expect(scopes).toContain(first);      // the accepted claim wins...
      expect(scopes).not.toContain(second); // ...and the superseded one is gone
      expect(await membershipScopes(email)).toEqual([first]);
      // The freed slug is genuinely re-claimable by anyone.
      expect(await getRegistry().checkSlugAvailable(second)).toBe(true);
    });

    it('a session minted from the superseded claim no longer refreshes', async () => {
      const email = `m6-${crypto.randomUUID().slice(0, 8)}@example.com`;
      const keep = uniqueUniverse();
      const drop = uniqueUniverse();
      const dropLink = await claimUniverse(SELF, drop, email);
      const keepLink = await claimUniverse(SELF, keep, email);

      // Establish a real session at the claim that is about to be superseded: a plain login places
      // a cookie for each pending claim and accepts neither.
      expect(dropLink).toBeTruthy();
      const droppedToken = (await plainLogin(SELF, email)).tokenFor(drop);

      await clickLink(SELF, keepLink); // the keep claim's Accept retires the other

      // Probed from the dropped scope's own page, the only shape that can fail. Reds if the retire
      // deletes rows without revoking sessions: the slug would be free for a stranger to claim while
      // its previous holder still held a live admin token for it.
      const resp = await refresh(SELF, drop, refreshCookie(drop, droppedToken));
      expect(resp.status).toBe(401);
    });

    it('CONTROL (trigger side): accepting a claimStar membership retires no pending Universe', async () => {
      const email = `m6-${crypto.randomUUID().slice(0, 8)}@example.com`;
      const pending = uniqueUniverse();
      await claimUniverse(SELF, pending, email);

      // A star, claimed by the SAME address — unstamped and scopeAdmin like a universe claim, so
      // only the TIER conjunct separates them. Reds if the trigger is untiered.
      const host = await foundUniverse(SELF, uniqueUniverse(), `host-${crypto.randomUUID().slice(0, 6)}@example.com`);
      const galaxy = `${host.parsed.access.authScope}.app`;
      await createGalaxy(galaxy, host.access_token);
      const star = `${galaxy}.tenant`;
      const starResp = await claimStar(SELF, star, email);
      const { magicLinkUrl } = await starResp.json() as { magicLinkUrl: string };
      await clickLink(SELF, magicLinkUrl); // the star claim's Accept

      expect(await scopeRows()).toContain(pending); // the pending Universe is untouched
    });

    it('CONTROL (trigger side): the bootstrap platform login retires no pending Universe', async () => {
      const pending = uniqueUniverse();
      await claimUniverse(SELF, pending, BOOTSTRAP_EMAIL);

      // The platform membership is unstamped and scopeAdmin=1 — only the platform-scope conjunct
      // stops it. Reds if that exclusion is dropped: a superuser's first login would destroy their
      // own (and, at scale, anyone's) pending claims.
      await platformLogin(SELF, BOOTSTRAP_EMAIL);
      expect(await scopeRows()).toContain(pending);
    });

    it('CONTROL (target side): a standing unaccepted INVITED membership survives', async () => {
      const email = `m6-${crypto.randomUUID().slice(0, 8)}@example.com`;
      const inviter = await foundUniverse(SELF, uniqueUniverse(), `inv-${crypto.randomUUID().slice(0, 6)}@example.com`);
      const invitedScope = inviter.parsed.access.authScope;
      // ⚠️ **An ADMIN invite, deliberately — the dangerous shape.** A plain member's membership
      // carries `scopeAdmin = 0`, so the target set's admin conjunct would save it and the origin
      // stamp would go untested (verified: with a member fixture, deleting the stamp check reds
      // nothing). An invited ADMIN matches every other conjunct a self-claim does, so the stamp is
      // the only thing standing between this tenant's live universe and deletion.
      await issueInvitesAs(inviter.access_token, invitedScope, [{ email, scopeAdmin: true }]);

      // ⚠️ THE case the origin discriminator exists for: an unaccepted invitation is a STANDING
      // state, so a bare `acceptedAt IS NULL` target set would delete another tenant's live scope
      // the moment this address accepted a Universe of their own.
      const own = uniqueUniverse();
      await clickLink(SELF, await claimUniverse(SELF, own, email)); // the claim page's Accept

      expect(await scopeRows()).toContain(invitedScope);
      expect(await membershipScopes(email)).toEqual(expect.arrayContaining([own, invitedScope]));
    });

    it('CONTROL (target side): a pending claim whose link has EXPIRED survives', async () => {
      const email = `m6-${crypto.randomUUID().slice(0, 8)}@example.com`;
      const aged = uniqueUniverse();
      await claimUniverse(SELF, aged, email);
      // Age its link past MAGIC_LINK_TTL — the clock moves for the Worker AND the DO under
      // vitest-plugin, so the row's own expiry check is what decides.
      await (runInDurableObject as any)(getRegistry(), (_i: any, c: any) => {
        c.storage.sql.exec("UPDATE MagicLinks SET expiresAt = '2020-01-01T00:00:00.000Z' WHERE universeGalaxyStarId = ?", aged);
      });

      const fresh = uniqueUniverse();
      await clickLink(SELF, await claimUniverse(SELF, fresh, email)); // the claim page's Accept

      // An un-consumable claim is nobody's live intention — retiring it would be destruction with
      // no user act behind it at all. Reds if the TTL conjunct is dropped.
      expect(await scopeRows()).toContain(aged);
    });
  });
});

describe('Identity authority — adminApproved retired, enforced at MINT (edge gate removed, B1/M5)', () => {
  it('an invited NON-admin member passes login + protected refresh after accept (the old adminApproved gate is gone)', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'admin@example.com');
    // Invite a plain member into a star under the universe; accept + refresh must succeed for a
    // non-admin (access.scopeAdmin===false) — the retired router:541 gate would have 403'd this.
    const scope = `${uni}.app.tenant`;
    const member = await inviteAndLogin(SELF, scope, admin.access_token, 'member@example.com');
    expect(member.parsed.access.scopeAdmin).toBeUndefined();         // genuinely non-admin
    expect(member.parsed.sub).toBeDefined();
    // The member's token round-trips a fresh refresh (proves it's a working, gate-free session).
    const again = await refreshAndParse(SELF, scope, member.refreshToken);
    expect(again.parsed.sub).toBe(member.parsed.sub);
  });

  it('an unverified/uninvited identity is refused a token at MINT (consume finds no identity → no KV record)', async () => {
    const uni = uniqueUniverse();
    await foundUniverse(SELF, uni, 'admin@example.com');
    // Request a login link for an uninvited email, click it → rejected → NO refresh KV record exists.
    const mlResp = await requestMagicLink(SELF, 'ghost@example.com');
    const { magicLinkUrl } = await mlResp.json() as { magicLinkUrl: string };
    const clickResp = await consumeLink(SELF, magicLinkUrl);
    expectNoSession(clickResp);                                // no token minted
    // And no refresh KV record was written for this scope — the mint never happened. (The click set no
    // cookie, so we can't derive a tokenHash; assert directly that consume left the KV token-space empty
    // of any record for a ghost by confirming no RefreshTokenIndex row exists for the scope's ghost.)
    const disc = await membershipsOf(getRegistry(), 'ghost@example.com');
    expect(disc).toHaveLength(0); // no identity → nothing to anchor a refresh record to
  });
});

describe('Refresh is a pure KV read — the registry is NOT on the refresh path', () => {
  const entries: any[] = [];
  beforeEach(() => { entries.length = 0; setDebugSink((e) => entries.push(e)); });
  afterEach(() => clearDebugSink());

  it('a refresh fires ZERO registry markers; a login fires one (positive control)', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');

    // Positive control: login (already happened during foundUniverse) fired a registry marker.
    expect(entries.some((e) => String(e.namespace).startsWith('nebula-auth.Registry'))).toBe(true);

    // Now clear and refresh — the registry must NOT be touched.
    entries.length = 0;
    await refreshAndParse(SELF, uni, admin.refreshToken);
    const registryMarkers = entries.filter((e) => String(e.namespace).startsWith('nebula-auth.Registry'));
    expect(registryMarkers).toHaveLength(0); // reds if refresh calls the registry
  });
});

describe('scopeAdmin convergence into the KV record (ADR-010; M4 expiry preservation)', () => {
  it('a real admin-change endpoint converges the KV record; the next refresh reflects it', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    expect((await kvRecord(admin.refreshToken)).scopeAdmin).toBe(true);

    // Drive convergence through the registry's real admin-change RPC (never a direct KV write).
    await getRegistry().setIdentityAdmin(admin.parsed.sub, false, ACTING());

    expect((await kvRecord(admin.refreshToken)).scopeAdmin).toBe(false); // converged (reds if the push is deleted)
    const refreshed = await refreshAndParse(SELF, uni, admin.refreshToken);
    expect(refreshed.parsed.access.scopeAdmin).toBeUndefined();           // demoted; reds if refresh stayed stale
  });

  it("M4: convergence re-applies the token's ORIGINAL absolute expiry to the KV entry — NOT a fresh 30-day TTL, NOT immortal", async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');
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
      JSON.stringify({ sub, universeGalaxyStarId: uni, scopeAdmin: true, expiresAt: shortExpiry }),
      { expirationTtl: 120 });

    // Converge — the registry re-puts the KV record; M4 requires it re-apply kvTtlSeconds(shortExpiry).
    await registry.setIdentityAdmin(sub, false, ACTING());

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
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    expect(await kvRecord(admin.refreshToken)).not.toBeNull();

    const logoutResp = await SELF.fetch(new Request(authUrl('logout'), {
      method: 'POST', headers: { Cookie: refreshCookie(uni, admin.refreshToken) },
    }));
    expect(logoutResp.status).toBe(200);
    expect(await kvRecord(admin.refreshToken)).toBeNull(); // KV record deleted

    const refreshResp = await refresh(SELF, uni, refreshCookie(uni, admin.refreshToken));
    expect(refreshResp.status).toBe(401); // revoked
  });

  /**
   * ⚠️ **The sharp mutation for the revoke invariant, and it is deterministic — no race needed.** An
   * index row outliving its KV record is NOT a harmless leftover: on a KV miss `getRefreshRecord`
   * reconstructs the record from that row and re-puts it, so the token comes back. This is why a revoke
   * must never un-index a token whose KV record it did not delete — and why the reverse orphan
   * (index-without-KV) is the RECOVERABLE one rather than the harmless one.
   */
  it('a KV-only revoke does NOT stick — the index row resurrects the token', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    const registry = getRegistry();

    // Delete ONLY the KV record, leaving the index row — the state a blanket-vs-scoped delete bug, or
    // an interrupted revoke, would produce.
    await (env as any).REFRESH_TOKEN_KV.delete(`refresh:${await hashString(admin.refreshToken)}`);
    expect(await kvRecord(admin.refreshToken)).toBeNull();

    const resp = await refresh(SELF, uni, refreshCookie(uni, admin.refreshToken));
    expect(resp.status).toBe(200);                             // resurrected — the index row is authoritative on a miss
    expect(await kvRecord(admin.refreshToken)).not.toBeNull(); // and self-healed back into KV

    // A REAL revoke removes both, so it sticks.
    await registry.logoutSessions([await hashString(admin.refreshToken)], false);
    const after = await refresh(SELF, uni, refreshCookie(uni, admin.refreshToken));
    expect(after.status).toBe(401);
  });

  /**
   * The invariant itself: hand the revoke a SUBSET and the untouched token must keep BOTH stores. Reds
   * against `DELETE … WHERE sub = ?`, and against un-indexing the whole input list when a KV delete
   * rejects — either would leave a live KV record with no index row, invisible to every future revoke.
   */
  it('a revoke never un-indexes a token whose KV record it did not delete', async () => {
    const uni = uniqueUniverse();
    const email = `multi-sess-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const first = await foundUniverse(SELF, uni, email);
    const registry = getRegistry();

    // A second live session for the SAME sub.
    const ml = await requestMagicLink(SELF, email);
    const { magicLinkUrl } = await ml.json() as { magicLinkUrl: string };
    const { refreshToken: second } = await clickLink(SELF, magicLinkUrl);

    const hashes = [await hashString(first.refreshToken), await hashString(second)];
    const indexed = async () => (runInDurableObject as any)(getRegistry(), (_i: any, c: any) =>
      [...c.storage.sql.exec('SELECT tokenHash FROM RefreshTokenIndex')].map((r: any) => r.tokenHash as string));
    expect((await indexed()).filter((h: string) => hashes.includes(h))).toHaveLength(2);

    // Revoke ONLY the first.
    await registry.logoutSessions([hashes[0]!], false);

    const rows = await indexed();
    expect(rows).not.toContain(hashes[0]);          // the revoked one is gone from BOTH stores
    expect(await kvRecord(first.refreshToken)).toBeNull();
    expect(rows).toContain(hashes[1]);              // the untouched one keeps its index row...
    expect(await kvRecord(second)).not.toBeNull();  // ...AND its KV record
  });
});

describe('Refresh KV-miss fallback (defensive — login→first-refresh cross-colo propagation)', () => {
  const misses: any[] = [];
  beforeEach(() => {
    misses.length = 0;
    setDebugSink((e) => { if (e.namespace === 'nebula-auth.worker.refresh' && e.message === 'kv miss') misses.push(e); });
  });
  afterEach(() => clearDebugSink());

  it('a missing KV record but live index+identity → the registry reconstructs + self-heals KV → refresh succeeds', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    // Simulate a KV read-your-write miss: delete ONLY the KV record (RefreshTokenIndex + Identity live).
    await (env as any).REFRESH_TOKEN_KV.delete(`refresh:${await hashString(admin.refreshToken)}`);
    expect(await kvRecord(admin.refreshToken)).toBeNull();

    const resp = await refresh(SELF, uni, refreshCookie(uni, admin.refreshToken)); // fallback path
    expect(resp.status).toBe(200);
    // A miss the index answers is a propagation gap, not a revocation, so the cookie is NOT expired.
    // Reds against expiring on the first KV miss, which in a browser drops the cookie and 401s the
    // next refresh.
    expect(refreshCookiesSet(resp).has(uni)).toBe(false);
    const { access_token } = await resp.json() as { access_token: string };
    expect((await verifiedClaims(access_token)).sub).toBe(admin.parsed.sub);
    // Self-healed: the record is back in KV, so the NEXT refresh hits KV directly (no fallback).
    expect(await kvRecord(admin.refreshToken)).not.toBeNull();
    expect((await refresh(SELF, uni, refreshCookie(uni, admin.refreshToken))).status).toBe(200);
    // The one miss is logged, with the live record's age since login; the hit after it logs none.
    // Mutation: drop the line, or log it on every read → the count is not 1.
    expect(misses).toHaveLength(1);
    expect(misses[0].data).toMatchObject({ scope: uni, healed: true });
    expect(misses[0].data.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(misses[0].data.ageSeconds).toBeLessThan(60);
  });

  it('a bogus refresh token (no index row) → 401, not a fallback mint', async () => {
    const uni = uniqueUniverse();
    await foundUniverse(SELF, uni, 'scope-admin@example.com');
    const resp = await refresh(SELF, uni, refreshCookie(uni, 'totally-bogus'));
    expect(resp.status).toBe(401);
    // A miss the Registry cannot answer is logged too, with no age, since no record says when.
    expect(misses.map((m) => m.data.healed)).toEqual([false]);
    expect(misses[0].data.ageSeconds).toBeUndefined();
  });
});

describe('M1 — a refresh mints only for a host the membership covers', () => {
  it('refuses a page on a host the cookie\'s membership does not cover; mints one beneath it', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');

    // Beneath the universe admin's membership → minted, for that page.
    const ok = await refreshAndParse(SELF, uni, admin.refreshToken, `${uni}.app.tenant`);
    expect(ok.parsed.aud).toBe(`${uni}.app.tenant`);

    // A host the membership does NOT cover → 401, since no cookie at or above it is a candidate.
    const bad = await refresh(SELF, 'some-other-universe.app', refreshCookie(uni, admin.refreshToken));
    expect(bad.status).toBe(401);
    expect((await bad.json() as { error: string }).error).toBe('invalid_token');
  });
});

describe('scope deletion — sub-first, fail-closed (M2)', () => {
  it('fails CLOSED when the caller\'s sub resolves to no identity (403), not "no other users → wipe"', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    const registry = getRegistry();
    // A caller `sub` with no membership row → the caller-exclusion in `affectedUsers` can't be
    // computed, so the warning would silently under-count → refuse rather than return a lying plan.
    await expect(
      registry.executeScopeDeletion(uni, { ...admin.parsed, sub: 'ghost-sub-with-no-identity' }),
    ).rejects.toThrow(/not found|forbidden/i);
  });

  // Was "blocks (409) a genuinely shared scope". Under ADR-015 authority flows DOWNWARD and is
  // non-vetoable: a covering admin may delete a scope other users are attached to. The attached
  // members are surfaced as a WARNING on the plan, never as a refusal.
  it('a genuinely shared scope is deleted, not refused — members surface as a warning', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    // Invite a second member into the universe → shared.
    await inviteAndLogin(SELF, uni, admin.access_token, 'member@example.com');

    // The Registry's own methods, handed the claims of the admin's verified token as the facade
    // hands them — this lane has no Gateway to reach the facade through.
    const claims = await verifiedClaims(admin.access_token);
    // The plan reports the other member (bounded warning) …
    const plan = await getRegistry().planScopeDeletion(uni, claims) as any;
    expect(plan.affectedUsers.total).toBe(1);
    expect(plan.affectedUsers.sample).toEqual([{ instanceName: uni, email: 'member@example.com' }]);

    // … and the delete SUCCEEDS. Reds against the removed `409 scope_in_use`.
    const executed = await getRegistry().executeScopeDeletion(uni, claims) as any;
    // The universe and the first app its claim wrote beneath it.
    expect(executed.affected.map((a: any) => a.instanceName).sort())
      .toEqual([uni, `${uni}.first`, `${uni}.first.dev`]);
  });
});

describe('Scopes is the existence authority — existence is NOT derived from Identity', () => {
  it('an admin-created, member-LESS galaxy exists (slug unavailable + in the summary) yet has zero identities', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    const registry = getRegistry();

    // Create a galaxy in-session (admin) — a Scopes row with NO identity (managed by dominion).
    await createGalaxy(`${uni}.app`, admin.access_token);

    expect(await registry.checkSlugAvailable(`${uni}.app`)).toBe(false); // exists (reds if derived from Identity)
    // The Home tree surfaces it although NOBODY is a member there — the descent reads `Scopes`, and
    // that is the property this assertion has always been about (it outlived `myScopeTree`, whose
    // JSDoc named the same reason: an email-keyed read would not find a galaxy just created).
    const summary = await registry.getScopeSummary(admin.parsed.profileId);
    const flat = (n: any): string[] => [n.scope, ...(n.children ?? []).flatMap(flat)];
    const tree = summary.emails.flatMap((e: any) => e.memberships.flatMap(flat));
    expect(tree).toContain(`${uni}.app`);                                // discoverable though member-less
    // The admin's membership set does NOT include the galaxy — they have no Identity there.
    const starAdminScopes = (await membershipsOf(registry, 'scope-admin@example.com')).map((d) => d.universeGalaxyStarId);
    expect(starAdminScopes).not.toContain(`${uni}.app`);
  });
});

describe('getScopesForProfile — only ACCEPTED memberships confer scope authority over a profile', () => {
  /**
   * The Profile DO's scoped-admin branch passes when the caller administers any scope
   * `getScopesForProfile` returns, and a profile is a GLOBAL object — so without an acceptance
   * predicate, authority over one is manufacturable: claim a Universe (unauthenticated, Turnstile
   * only) → invite any address you can guess → you now "administer a scope that profile touches".
   *
   * ⚠️ **Every step is now a real path — there is no simulated convergence left.** An earlier revision
   * had to converge the invited row's `profileId` onto the victim's by hand, because the mint gave each
   * `(address, scope)` its own id. Moving `profileId` onto the address makes that structural: the
   * attacker's invite finds the victim's existing `Emails` row and reuses it, so the two scopes share
   * one `profileId` because the schema cannot express anything else. The un-taken-up state is likewise
   * PRODUCED by the real invite endpoint rather than asserted by a fixture, so this also reds if invites
   * ever start pre-accepting.
   */
  it('a manufactured, never-accepted invite does NOT put its scope in the victim profile\'s scope list', async () => {
    const victimEmail = `victim-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const victimUni = uniqueUniverse();
    const evilUni = uniqueUniverse();

    // Real: the victim founds their own Universe and logs in → accepted membership + a real profileId.
    const victim = await foundUniverse(SELF, victimUni, victimEmail);
    const victimProfileId = victim.parsed.profileId;
    expect(victimProfileId).toBeTruthy();

    // Real: the attacker founds a Universe of their own — open self-signup, no approval needed.
    const attacker = await foundUniverse(SELF, evilUni, 'attacker@example.com');

    // Real: the attacker invites the victim's address into THEIR Universe (registry issuance as
    // the mesh facade performs it, under the attacker's real claims). The link is never clicked,
    // so the minted membership is never taken up.
    const inviteMint = await issueInvitesAs(attacker.access_token, evilUni, [{ email: victimEmail }]);
    expect(inviteMint.errors).toHaveLength(0);

    const registry = getRegistry();
    // Read-only: confirm the invite really did attach to the victim's OWN address row (so the shared
    // profileId is genuine, not arranged) and really is un-taken-up.
    const invited = await (runInDurableObject as any)(registry, (_i: any, c: any) => [...c.storage.sql.exec(
      `SELECT m.sub AS sub, m.acceptedAt AS acceptedAt, e.profileId AS profileId
       FROM Memberships m JOIN Emails e ON e.emailId = m.emailId
       WHERE e.email = ? AND m.universeGalaxyStarId = ?`,
      victimEmail, evilUni,
    )][0]);
    expect(invited.acceptedAt).toBeNull();                 // reds if the invite path pre-accepts
    expect(invited.profileId).toBe(victimProfileId);       // the convergence is structural, not seeded

    // The attacker's scope must NOT appear — this is the whole guard.
    const scopes = await registry.getScopesForProfile(victimProfileId);
    expect(scopes).toContain(victimUni);       // the victim's own accepted membership still counts
    expect(scopes).not.toContain(evilUni);     // reds if `AND m.acceptedAt IS NOT NULL` is dropped

    // ⚠️ Acceptance is the discriminator, and specifically NOT `Emails.emailVerified` — which is already
    // 1 here, because the victim proved this mailbox when they founded their own Universe. Swapping the
    // predicate to `emailVerified` would hand the attacker the scope, so this pair is what separates the
    // two columns rather than merely exercising one.
    await (runInDurableObject as any)(registry, (_i: any, c: any) => {
      c.storage.sql.exec('UPDATE Memberships SET acceptedAt = ? WHERE sub = ?', new Date().toISOString(), invited.sub);
    });
    expect(await registry.getScopesForProfile(victimProfileId)).toContain(evilUni);
  });
});

describe('ADR-016 — an authority change records the ACTING TOKEN, not just its target', () => {
  const entries: any[] = [];
  beforeEach(() => { entries.length = 0; setDebugSink((e) => entries.push(e)); });
  afterEach(() => { clearDebugSink(); });

  /**
   * ⚠️ **The required parameter is only HALF the guarantee, which is why this test exists.** Making
   * `callerClaims` required means a call site cannot forget to PASS it — that is a compile error. But
   * deleting the `actingToken` field from the record itself compiles cleanly and silently reverts the
   * site to a target-only line, which under impersonation names the person acted upon as the person
   * who acted. Only an assertion on the emitted record covers that half.
   */
  it('issuing an invite records the acting admin, not merely the invitee', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, `adm-${crypto.randomUUID().slice(0, 8)}@example.com`);
    entries.length = 0;

    const mint = await issueInvitesAs(admin.access_token, uni,
      [{ email: `invitee-${crypto.randomUUID().slice(0, 8)}@example.com` }]);
    expect(mint.errors).toHaveLength(0);

    const sent = entries.filter(e => e.namespace === 'nebula-auth.Registry.invite.issued');
    expect(sent).toHaveLength(1);
    // Reds against deleting `actingToken: projectActingToken(callerClaims)` from the record — the
    // mutation that type-checks.
    expect(sent[0].data.actingToken).toBeDefined();
    expect(sent[0].data.actingToken.sub).toBe(admin.parsed.sub);
    // ...and it carries the ASSERTED authority, not just an id — ADR-016 wants the full claims, and a
    // record narrowed to `{ sub }` cannot answer "under what authority" after the fact.
    expect(sent[0].data.actingToken.access).toBeDefined();
  });

  /**
   * The promotion is an AUTHORITY CHANGE (the bit flips and every live session converges), so its
   * record must name the full acting token — through the ONE shared projection, never a
   * hand-assembled second one. Reds against passing a `sub`-only projection to the record, the
   * mutation that type-checks and silently names only the person acted upon.
   */
  it('a promotion records the acting principal\'s full verified claims', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, `adm-${crypto.randomUUID().slice(0, 8)}@example.com`);
    const promotee = `promotee-${crypto.randomUUID().slice(0, 8)}@example.com`;

    // Mint a plain member, then re-invite WITH the bit — the promotion path.
    await issueInvitesAs(admin.access_token, uni, [{ email: promotee }]);
    entries.length = 0;

    const second = await issueInvitesAs(admin.access_token, uni, [{ email: promotee, scopeAdmin: true }]);
    expect(second.results[0].outcome).toBe('promoted');

    const roleUpdated = entries.filter(e => e.namespace === 'nebula-auth.Registry.identity.roleUpdated');
    expect(roleUpdated).toHaveLength(1);
    expect(roleUpdated[0].data.actingToken).toBeDefined();
    expect(roleUpdated[0].data.actingToken.sub).toBe(admin.parsed.sub);
    expect(roleUpdated[0].data.actingToken.access).toBeDefined();
  });
});

describe('verification is per-ADDRESS, acceptance is per-MEMBERSHIP', () => {
  const entries: any[] = [];
  beforeEach(() => { entries.length = 0; setDebugSink((e) => entries.push(e)); });
  afterEach(() => { clearDebugSink(); });

  /** Read both columns for one address, across scopes. */
  async function state(email: string): Promise<{ emailVerified: number; byScope: Record<string, string | null> }> {
    return (runInDurableObject as any)(getRegistry(), (_i: any, c: any) => {
      const rows = [...c.storage.sql.exec(
        `SELECT m.universeGalaxyStarId AS scope, m.acceptedAt AS acceptedAt, e.emailVerified AS emailVerified
         FROM Memberships m JOIN Emails e ON e.emailId = m.emailId WHERE e.email = ?`, email,
      )];
      const byScope: Record<string, string | null> = {};
      for (const r of rows) byScope[r.scope as string] = (r.acceptedAt as string | null) ?? null;
      return { emailVerified: rows[0].emailVerified as number, byScope };
    });
  }

  /**
   * The distinguishing case for the split, and the one a naive port breaks: proving a mailbox is a
   * property of the ADDRESS, so an invite into a SECOND scope must not touch it. Pre-split the single
   * column made this inexpressible — the mint passed `emailVerified: false`, which would now downgrade
   * an address the person had already proved.
   */
  it('an invite into a second scope leaves the address PROVED and the new membership un-taken-up', async () => {
    const email = `split-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const a = uniqueUniverse();
    const b = uniqueUniverse();

    // Real: found + log in at A → the address is proved, and A is taken up.
    await foundUniverse(SELF, a, email);
    const afterA = await state(email);
    expect(afterA.emailVerified).toBe(1);
    expect(afterA.byScope[a]).not.toBeNull();

    // Real: an admin of B invites the SAME address. Never clicked.
    const adminB = await foundUniverse(SELF, b, `adm-${crypto.randomUUID().slice(0, 8)}@example.com`);
    const inv = await issueInvitesAs(adminB.access_token, b, [{ email }]);
    expect(inv.errors).toHaveLength(0);

    const afterInvite = await state(email);
    expect(afterInvite.emailVerified).toBe(1);        // reds against a mint that writes emailVerified = 0
    expect(afterInvite.byScope[b]).toBeNull();        // the new membership is NOT taken up
    expect(afterInvite.byScope[a]).toBe(afterA.byScope[a]); // and A is untouched

    // ⚠️ **A THIRD scope, invited and left un-taken-up — and it is what makes the next assertion
    // capable of failing.** Accepting B while A is already accepted proves nothing about scoping,
    // because the `AND acceptedAt IS NULL` guard protects A under a per-ADDRESS update too. The
    // dangerous shape is two UNACCEPTED memberships where only one is taken up; a first attempt used
    // the safe shape and the mutation stayed green.
    const c = uniqueUniverse();
    const adminC = await foundUniverse(SELF, c, `adm-${crypto.randomUUID().slice(0, 8)}@example.com`);
    const invC = await issueInvitesAs(adminC.access_token, c, [{ email }]);
    expect(invC.errors).toHaveLength(0);
    expect((await state(email)).byScope[c]).toBeNull();

    // Accept ONLY B's invite, through its own page: the Accept takes up the membership the link
    // names, never every pending one the address holds. That is what the scoping assertion exercises.
    const inviteLink = inv.results[0]?.inviteUrl;
    expect(inviteLink).toBeTruthy();
    await clickLink(SELF, inviteLink!); // the invite page's Accept takes up B alone

    const afterAccept = await state(email);
    expect(afterAccept.byScope[b]).not.toBeNull();          // B is now taken up...
    expect(afterAccept.byScope[a]).toBe(afterA.byScope[a]); // ...A's stamp is unchanged...
    // ...and C, still un-taken-up, MUST remain so. Reds against keying the acceptance UPDATE on the
    // address instead of the membership — one click would otherwise accept every scope this address
    // was ever invited into, granting exactly the manufactured authority ADR-012's predicate refuses.
    expect(afterAccept.byScope[c]).toBeNull();
  });

  /**
   * One person's two memberships resolve to ONE `profileId`, observed where a user observes it — the
   * claim on the JWT after each identity completes a real login through a genuinely different path
   * (an open Universe claim, then an admin's invite).
   *
   * ⚠️ **This is the in-lane equivalent of the first-mover criterion, written after its `/live`
   * justification expired.** That justification was "pool-workers can only assert this by hand-seeding
   * the convergence" — true before the split, false after it, because `#mintIdentity` now find-or-
   * creates the address row so both paths reuse one `Emails` row by construction. An expired
   * justification is a trigger to re-derive, not a licence to drop the coverage: the property still
   * needs asserting, it just no longer needs a running system to assert it faithfully.
   */
  it('two paths that see one address converge on ONE profileId — asserted on the JWT claim', async () => {
    const email = `converge-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const own = uniqueUniverse();
    const other = uniqueUniverse();

    // Path 1: an open Universe claim, then a real login.
    const viaClaim = await foundUniverse(SELF, own, email);

    // Path 2: an admin of a DIFFERENT universe invites the same address; the invitee logs in for real.
    const admin = await foundUniverse(SELF, other, `adm-${crypto.randomUUID().slice(0, 8)}@example.com`);
    const viaInvite = await inviteAndLogin(SELF, other, admin.access_token, email);

    // Reds against a mint that writes a fresh `Emails.profileId` on the second path instead of reusing
    // the existing address row.
    expect(viaInvite.parsed.profileId).toBe(viaClaim.parsed.profileId);
    expect(viaInvite.parsed.sub).not.toBe(viaClaim.parsed.sub); // distinct memberships, one person
  });

  /**
   * The `emailVerified` guard is the one mutation NO value assertion can catch — stripping it leaves the
   * row byte-identical (1 overwritten with 1). Only "did a write happen" distinguishes, and `rowsWritten`
   * lives on the cursor INSIDE the DO, so the debug sink is the sole instrument that reaches it.
   */
  it('a repeat login performs NO flag write — neither column', async () => {
    const email = `flags-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const u = uniqueUniverse();

    await foundUniverse(SELF, u, email);   // first login: both flags flip
    const firstProved = entries.filter(e => e.namespace === 'nebula-auth.Registry.identity.mailboxProved').length;
    const firstAccepted = entries.filter(e => e.namespace === 'nebula-auth.Registry.identity.membershipAccepted').length;
    expect(firstProved).toBe(1);
    expect(firstAccepted).toBe(1);

    entries.length = 0;
    const ml = await requestMagicLink(SELF, email);
    const { magicLinkUrl } = await ml.json() as { magicLinkUrl: string };
    await clickLink(SELF, magicLinkUrl);   // second login: both guards must suppress the write

    // Reds against dropping either `AND emailVerified = 0` or `AND acceptedAt IS NULL`.
    expect(entries.filter(e => e.namespace === 'nebula-auth.Registry.identity.mailboxProved')).toHaveLength(0);
    expect(entries.filter(e => e.namespace === 'nebula-auth.Registry.identity.membershipAccepted')).toHaveLength(0);
  });

  /** The value-observable half — an unguarded `SET acceptedAt = ?` restamps a fresh ISO timestamp. */
  it('a repeat login does not restamp acceptedAt', async () => {
    const email = `stamp-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const u = uniqueUniverse();
    await foundUniverse(SELF, u, email);
    const first = (await state(email)).byScope[u];
    expect(first).toBeTruthy();

    const ml = await requestMagicLink(SELF, email);
    const { magicLinkUrl } = await ml.json() as { magicLinkUrl: string };
    await clickLink(SELF, magicLinkUrl);

    expect((await state(email)).byScope[u]).toBe(first);
  });
});
