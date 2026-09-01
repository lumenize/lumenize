/**
 * Phase 5: "log out everywhere", and acceptance pinned on every arm.
 *
 * Two things are asserted here that nothing else can:
 *
 *  - **Logout-all is the symmetric twin of mint-all.** One click minted a cookie per membership of
 *    the address; one logout ends all of them. Anything less is a surprise on a shared machine,
 *    where "log out" plainly means "not still signed in over there".
 *  - **The writer story, whole.** Four arms — invite consume, claim consume, refresh, and the accept
 *    endpoint — and exactly one of them writes `acceptedAt`. Each is asserted separately, because a
 *    single "acceptance works" test passes while three of the four quietly also write.
 */
import { describe, it, expect } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import {
  foundUniverse, claimUniverse, issueInvitesAs, clickLink, acceptMembership, refreshAndParse, url,
} from './test-helpers';

const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;
const addr = () => `p5-${crypto.randomUUID().slice(0, 8)}@example.com`;
const getRegistry = (): any => env.NEBULA_AUTH_REGISTRY.getByName('registry');

/** Can this cookie still mint? The only probe that matters for a revoke, per `security.md`: it is
 *  driven at the cookie's OWN scope, which is the shape that can actually fail. */
async function stillRefreshes(scope: string, token: string): Promise<boolean> {
  const resp = await SELF.fetch(new Request(url(scope, 'refresh-token'), {
    method: 'POST',
    headers: { Cookie: `refresh-token=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeScope: scope }),
  }));
  return resp.status === 200;
}

async function acceptedAt(email: string, scope: string): Promise<string | null> {
  return (runInDurableObject as any)(getRegistry(), (_i: any, c: any) => {
    const rows = [...c.storage.sql.exec(
      `SELECT m.acceptedAt AS a FROM Memberships m JOIN Emails e ON e.emailId = m.emailId
       WHERE e.email = ? AND m.universeGalaxyStarId = ?`, email, scope)];
    return rows.length ? rows[0].a : null;
  });
}

describe('Phase 5 — logout-all ends every session this address holds', () => {
  it('one logout-all kills sessions at EVERY scope, and expires each cookie at its own Path', async () => {
    const person = addr();
    const a = uni(); const b = uni();
    await foundUniverse(SELF, a, person);
    const second = await foundUniverse(SELF, b, person);

    // One more click, so the browser holds a live cookie for BOTH memberships (mint-all).
    const link = await claimUniverse(SELF, uni(), person).catch(() => null);
    const fresh = await clickLink(SELF, (await (async () => {
      const resp = await SELF.fetch(new Request('https://example.com/auth/email-magic-link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: person }),
      }));
      return (await resp.json() as { magicLinkUrl: string }).magicLinkUrl;
    })()));
    const tokenA = fresh.tokenFor(a);
    const tokenB = fresh.tokenFor(b);
    expect(await stillRefreshes(a, tokenA)).toBe(true);
    expect(await stillRefreshes(b, tokenB)).toBe(true); // both live — the fixture is not vacuous

    const resp = await SELF.fetch(new Request(url(a, 'logout-all'), {
      method: 'POST', headers: { Cookie: `refresh-token=${tokenA}`, 'Content-Type': 'application/json' },
    }));
    expect(resp.status).toBe(200);

    // ⚠️ The OTHER scope is the assertion. Revoking only the called scope is the plausible wrong
    // implementation, and it passes every check that looks at scope `a` alone.
    expect(await stillRefreshes(a, tokenA)).toBe(false);
    expect(await stillRefreshes(b, tokenB)).toBe(false);

    // Every cookie is expired at its own Path, so the browser drops all of them rather than
    // holding dead credentials that look live.
    const paths = (resp.headers as any).getSetCookie()
      .filter((c: string) => c.includes('Max-Age=0'))
      .map((c: string) => /Path=([^;]+)/.exec(c)![1]);
    expect(paths).toEqual(expect.arrayContaining([`/auth/${a}`, `/auth/${b}`]));
    expect(second.refreshToken).toBeDefined();
  });

  it('a per-scope logout still ends only its own scope', async () => {
    const person = addr();
    const a = uni(); const b = uni();
    await foundUniverse(SELF, a, person);
    await foundUniverse(SELF, b, person);
    const resp = await SELF.fetch(new Request('https://example.com/auth/email-magic-link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: person }),
    }));
    const { tokenFor } = await clickLink(SELF, (await resp.json() as any).magicLinkUrl);
    const tokenA = tokenFor(a); const tokenB = tokenFor(b);

    await SELF.fetch(new Request(url(a, 'logout'), {
      method: 'POST', headers: { Cookie: `refresh-token=${tokenA}`, 'Content-Type': 'application/json' },
    }));
    // The narrow logout is still narrow — reds if `logout` were quietly widened to the address.
    expect(await stillRefreshes(a, tokenA)).toBe(false);
    expect(await stillRefreshes(b, tokenB)).toBe(true);
  });
});

describe('Phase 5 — exactly one arm writes acceptance', () => {
  it('invite consume: NO', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, addr());
    const invitee = addr();
    const mint = await issueInvitesAs(admin.access_token, u, [{ email: invitee }]);
    await clickLink(SELF, mint.results[0].inviteUrl);
    expect(await acceptedAt(invitee, u)).toBeNull();
  });

  it('claim consume: NO', async () => {
    const claimer = addr();
    const u = uni();
    await clickLink(SELF, await claimUniverse(SELF, u, claimer));
    expect(await acceptedAt(claimer, u)).toBeNull();
  });

  it('refresh: NO — it READS acceptance and never writes it', async () => {
    const person = addr();
    const u = uni();
    const founded = await foundUniverse(SELF, u, person); // accepted by the helper
    const before = await acceptedAt(person, u);
    await refreshAndParse(SELF, u, founded.refreshToken);
    await refreshAndParse(SELF, u, founded.refreshToken);
    // Reds against a refresh that re-stamps: the value must be the ONE moment consent happened,
    // not the last time a token was minted.
    expect(await acceptedAt(person, u)).toBe(before);
  });

  it('the accept endpoint: YES — and it is the only one', async () => {
    const claimer = addr();
    const u = uni();
    const { tokenFor } = await clickLink(SELF, await claimUniverse(SELF, u, claimer));
    expect(await acceptedAt(claimer, u)).toBeNull();
    await acceptMembership(SELF, u, tokenFor(u));
    expect(await acceptedAt(claimer, u)).not.toBeNull();
  });

  it('accept refuses a cookie for a DIFFERENT membership than the one it names', async () => {
    const person = addr();
    const a = uni(); const b = uni();
    await foundUniverse(SELF, a, person);
    await claimUniverse(SELF, b, person); // pending, unaccepted
    const resp = await SELF.fetch(new Request('https://example.com/auth/email-magic-link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: person }),
    }));
    const { tokenFor } = await clickLink(SELF, (await resp.json() as any).magicLinkUrl);

    // Present scope A's cookie at scope B's accept endpoint. The endpoint resolves the cookie to ITS
    // OWN membership, so this takes up A (already accepted, a no-op) and never touches B.
    //
    // ⚠️ **A CONTRACT guard, not a behavioural one, and worth saying so.** No mutation isolates it:
    // `acceptMembership(sub)` takes no scope argument, so there is nothing to pass the URL segment
    // to — the property holds by the signature rather than by a check. This assertion exists to red
    // if someone later adds that parameter, which is exactly when it would stop holding.
    await SELF.fetch(new Request(url(b, 'accept-membership'), {
      method: 'POST', headers: { Cookie: `refresh-token=${tokenFor(a)}`, 'Content-Type': 'application/json' },
    }));
    expect(await acceptedAt(person, b)).toBeNull();
  });
});
