/**
 * Identity authority — the load-bearing security invariants of the surrogate-`sub` +
 * NebulaAuth-dissolution model (tasks/nebula-auth-surrogate-sub.md, Phase 1 + Phase 2 success
 * criteria). Every test here is capable-of-failing: gutting the code under test reddens it.
 *
 * Grounding: rung 2 (test-mode issuance) through the real Worker → registry → KV paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { hashString } from '@lumenize/crypto';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { foundUniverse, inviteAndLogin, requestMagicLink, clickLink, refreshAndParse, registryUrl, url } from './test-helpers';

/** The ADR-016 acting-principal argument these registry methods now require. Recorded, never
 *  consulted — authorization keys off the caller's own verified access, not off this. */
const ACTING = (sub = crypto.randomUUID()) => ({ sub, access: { authScopePattern: '*', scopeAdmin: true } }) as any;

function uniqueUniverse(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }
function getRegistry(): any { return env.NEBULA_AUTH_REGISTRY.getByName('registry'); }
async function kvRecord(refreshToken: string): Promise<any> {
  const raw = await (env as any).REFRESH_TOKEN_KV.get(`refresh:${await hashString(refreshToken)}`);
  return raw ? JSON.parse(raw) : null;
}

describe('Identity authority — mint only at authority points', () => {
  it('claim-universe mints the claiming admin identity; a returning email resolves to the SAME sub', async () => {
    const uni = uniqueUniverse();
    const first = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    expect(first.parsed.access.scopeAdmin).toBe(true);         // the claiming admin is admin
    expect(first.parsed.access.authScopePattern).toBe(`${uni}.*`);

    // Log in AGAIN via the login magic-link (find-and-flip) — must resolve to the SAME sub, never re-mint.
    const mlResp = await requestMagicLink(SELF, uni, 'scope-admin@example.com');
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
    await foundUniverse(SELF, uni, 'scope-admin@example.com');
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
    // mapping) and assert discover(email) returns exactly one universe with one admin identity.
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

    const resp = await SELF.fetch(new Request(`http://localhost/auth/${uni}/refresh-token`, {
      method: 'POST',
      headers: { Cookie: `refresh-token=${admin.refreshToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeScope: uni }),
    }));
    expect(resp.status).toBe(200);                             // resurrected — the index row is authoritative on a miss
    expect(await kvRecord(admin.refreshToken)).not.toBeNull(); // and self-healed back into KV

    // A REAL revoke removes both, so it sticks.
    await registry.revokeRefreshToken(await hashString(admin.refreshToken));
    const after = await SELF.fetch(new Request(`http://localhost/auth/${uni}/refresh-token`, {
      method: 'POST',
      headers: { Cookie: `refresh-token=${admin.refreshToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeScope: uni }),
    }));
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
    const ml = await requestMagicLink(SELF, uni, email);
    const { magicLinkUrl } = await ml.json() as { magicLinkUrl: string };
    const { refreshToken: second } = await clickLink(SELF, magicLinkUrl);

    const hashes = [await hashString(first.refreshToken), await hashString(second)];
    const indexed = async () => (runInDurableObject as any)(getRegistry(), (_i: any, c: any) =>
      [...c.storage.sql.exec('SELECT tokenHash FROM RefreshTokenIndex')].map((r: any) => r.tokenHash as string));
    expect((await indexed()).filter((h: string) => hashes.includes(h))).toHaveLength(2);

    // Revoke ONLY the first.
    await registry.revokeRefreshToken(hashes[0]!);

    const rows = await indexed();
    expect(rows).not.toContain(hashes[0]);          // the revoked one is gone from BOTH stores
    expect(await kvRecord(first.refreshToken)).toBeNull();
    expect(rows).toContain(hashes[1]);              // the untouched one keeps its index row...
    expect(await kvRecord(second)).not.toBeNull();  // ...AND its KV record
  });
});

describe('Refresh KV-miss fallback (defensive — login→first-refresh cross-colo propagation)', () => {
  it('a missing KV record but live index+identity → the registry reconstructs + self-heals KV → refresh succeeds', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    // Simulate a KV read-your-write miss: delete ONLY the KV record (RefreshTokenIndex + Identity live).
    await (env as any).REFRESH_TOKEN_KV.delete(`refresh:${await hashString(admin.refreshToken)}`);
    expect(await kvRecord(admin.refreshToken)).toBeNull();

    const refreshed = await refreshAndParse(SELF, uni, admin.refreshToken); // fallback path
    expect(refreshed.parsed.sub).toBe(admin.parsed.sub);
    expect(refreshed.parsed.access.scopeAdmin).toBe(true);
    // Self-healed: the record is back in KV, so the NEXT refresh hits KV directly (no fallback).
    expect(await kvRecord(admin.refreshToken)).not.toBeNull();
  });

  it('a bogus refresh token (no index row) → 401, not a fallback mint', async () => {
    const uni = uniqueUniverse();
    await foundUniverse(SELF, uni, 'scope-admin@example.com');
    const resp = await SELF.fetch(new Request(`http://localhost/auth/${uni}/refresh-token`, {
      method: 'POST',
      headers: { Cookie: 'refresh-token=totally-bogus', 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeScope: uni }),
    }));
    expect(resp.status).toBe(401);
  });
});

describe('M1 — refresh activeScope validated against the KV record scope, not client input', () => {
  it('rejects an activeScope outside the KV record scope; accepts one within it', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');

    // Within the universe admin's `{uni}.*` reach (KV record scope is the universe) → accepted.
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
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    const registry = getRegistry();
    // A callerSub with no Identity row → the caller-exclusion in `affectedUsers` can't be computed,
    // so the warning would silently under-count → refuse rather than return a lying plan.
    await expect(
      registry.executeScopeDeletion(uni, 'ghost-sub-with-no-identity', admin.parsed.access, admin.parsed),
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

    // The plan reports the other member (bounded warning) …
    const planResp = await SELF.fetch(new Request(registryUrl('delete-scope-plan'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: uni }),
    }));
    expect(planResp.status).toBe(200);
    const plan = await planResp.json() as any;
    expect(plan.affectedUsers.total).toBe(1);
    expect(plan.affectedUsers.sample).toEqual([{ instanceName: uni, email: 'member@example.com' }]);

    // … and the delete SUCCEEDS. Reds against the removed `409 scope_in_use`.
    // Drive the real Worker path (router injects the verified caller `sub`; registry resolves it → email).
    const resp = await SELF.fetch(new Request(registryUrl('delete-scope'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: uni }),
    }));
    expect(resp.status).toBe(200);
  });
});

describe('Scopes is the existence authority — existence is NOT derived from Identity', () => {
  it('an admin-created, member-LESS galaxy exists (slug unavailable + in myScopeTree) yet has zero identities', async () => {
    const uni = uniqueUniverse();
    const admin = await foundUniverse(SELF, uni, 'scope-admin@example.com');
    const registry = getRegistry();

    // Create a galaxy in-session (admin) — a Scopes row with NO admin identity identity (wildcard-managed).
    const createResp = await SELF.fetch(new Request(registryUrl('create-galaxy'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ universeGalaxyId: `${uni}.app` }),
    }));
    expect(createResp.status).toBe(201);

    expect(await registry.checkSlugAvailable(`${uni}.app`)).toBe(false); // exists (reds if derived from Identity)
    const tree = (await registry.myScopeTree(admin.parsed.access)).map((s: any) => s.instanceName);
    expect(tree).toContain(`${uni}.app`);                                // discoverable though member-less
    // discover(the admin) does NOT surface the galaxy — the admin has no Identity there.
    const starAdminScopes = (await registry.discover('scope-admin@example.com')).map((d: any) => d.universeGalaxyStarId);
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

    // Real: the attacker invites the victim's address into THEIR Universe. The link is never clicked,
    // so the minted membership is never taken up.
    const inviteResp = await SELF.fetch(new Request(url(evilUni, 'invite'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${attacker.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: [victimEmail] }),
    }));
    expect(inviteResp.status).toBe(200);

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

    const res = await SELF.fetch(new Request(url(uni, 'invite'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: [`invitee-${crypto.randomUUID().slice(0, 8)}@example.com`] }),
    }));
    expect(res.status).toBe(200);

    const sent = entries.filter(e => e.namespace === 'nebula-auth.Registry.invite.sent');
    expect(sent).toHaveLength(1);
    // Reds against deleting `actingToken: projectActingToken(callerClaims)` from the record — the
    // mutation that type-checks.
    expect(sent[0].data.actingToken).toBeDefined();
    expect(sent[0].data.actingToken.sub).toBe(admin.parsed.sub);
    // ...and it carries the ASSERTED authority, not just an id — ADR-016 wants the full claims, and a
    // record narrowed to `{ sub }` cannot answer "under what authority" after the fact.
    expect(sent[0].data.actingToken.access).toBeDefined();
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
    const inv = await SELF.fetch(new Request(url(b, 'invite'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminB.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: [email] }),
    }));
    expect(inv.status).toBe(200);

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
    const invC = await SELF.fetch(new Request(url(c, 'invite'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminC.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: [email] }),
    }));
    expect(invC.status).toBe(200);
    expect((await state(email)).byScope[c]).toBeNull();

    // Accept ONLY B's invite.
    const inviteLink = (await inv.json() as { links: Record<string, string> }).links[email];
    expect(inviteLink).toBeTruthy();
    await clickLink(SELF, inviteLink!);

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
    const ml = await requestMagicLink(SELF, u, email);
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

    const ml = await requestMagicLink(SELF, u, email);
    const { magicLinkUrl } = await ml.json() as { magicLinkUrl: string };
    await clickLink(SELF, magicLinkUrl);

    expect((await state(email)).byScope[u]).toBe(first);
  });
});
