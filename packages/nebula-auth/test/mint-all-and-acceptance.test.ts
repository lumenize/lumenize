/**
 * Phase 2: one click mints a session per membership, and every one of them is INERT until its holder
 * consents.
 *
 * The three properties, and why each is here:
 *
 *  - **Mint-all.** A click used to mint one session, for the scope the link named — which is why an
 *    address with several memberships dead-ended. Now the click proves the mailbox and the browser
 *    ends up holding one path-scoped cookie per membership, so choosing a scope afterwards is
 *    navigation rather than another email. Asserted as the exact SET of cookie `Path` values: a
 *    count would pass while minting the wrong ones.
 *  - **The platform carve-out.** A configured bootstrap address gets its `nebula-platform` membership
 *    on any consume (behind mailbox proof), so an unqualified mint-all would leave a superuser cookie
 *    in that browser after, say, an unsolicited peer invite. Only a link that itself named the
 *    platform scope mints that cookie.
 *  - **Inert until accepted.** The cookies exist before consent, so something must stop them being
 *    usable — otherwise the consent modal decorates a session that already works, and a direct link
 *    to the scope's surface would connect. `refresh-token` refuses an unaccepted membership, and the
 *    accept endpoint is what converges the record.
 */
import { describe, it, expect } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { hashString } from '@lumenize/crypto';
import {
  foundUniverse, issueInvitesAs, clickLink, refreshAndParse, acceptMembership,
  createGalaxy, requestMagicLink, claimUniverse, url,
} from './test-helpers';
import { PLATFORM_SCOPE, MINT_ALL_COOKIE_CAP } from '../src/types';
import { selectSessionsToMint } from '../src/worker-token';

const BOOTSTRAP = 'bootstrap-admin@example.com';
const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;
const addr = () => `p2-${crypto.randomUUID().slice(0, 8)}@example.com`;
const getRegistry = (): any => env.NEBULA_AUTH_REGISTRY.getByName('registry');

/** The scopes a click set cookies for, read off each cookie's `Path`. */
function cookieScopes(resp: Response): string[] {
  return (resp.headers as any).getSetCookie().map(
    (c: string) => decodeURIComponent(/Path=([^;]+)/.exec(c)![1].split('/').pop()!),
  ).sort();
}

async function scopelessLink(email: string): Promise<string> {
  const resp = await SELF.fetch(new Request('https://example.com/auth/email-magic-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
  }));
  return (await resp.json() as { magicLinkUrl: string }).magicLinkUrl;
}

/** The stored acceptance for one (address, scope) — the row, not a derived copy. */
async function acceptedAt(email: string, scope: string): Promise<string | null> {
  return (runInDurableObject as any)(getRegistry(), (_i: any, c: any) => {
    const rows = [...c.storage.sql.exec(
      `SELECT m.acceptedAt AS a FROM Memberships m JOIN Emails e ON e.emailId = m.emailId
       WHERE e.email = ? AND m.universeGalaxyStarId = ?`, email, scope)];
    return rows.length ? rows[0].a : null;
  });
}

/** The KV record behind a refresh token — where `accepted` is denormalized. */
async function kvRecord(refreshToken: string): Promise<any> {
  const raw = await (env as any).REFRESH_TOKEN_KV.get(`refresh:${await hashString(refreshToken)}`);
  return raw ? JSON.parse(raw) : null;
}

describe('Phase 2 — one click, a session per membership', () => {
  it('an address with THREE memberships gets exactly that set of cookie Paths, on one 302', async () => {
    const person = addr();
    const a = uni(); const b = uni(); const c = uni();
    // Three universes, each claimed by the same address — three memberships, three scopes.
    for (const u of [a, b, c]) await foundUniverse(SELF, u, person);

    const resp = await SELF.fetch(new Request(await scopelessLink(person), { redirect: 'manual' }));
    expect(resp.status).toBe(302);
    // ⚠️ The SET, never a count: minting three cookies for the wrong three scopes would pass a
    // length check. Reds against minting only the link's scope (the pre-mint-all behaviour).
    expect(cookieScopes(resp)).toEqual([a, b, c].sort());
  });

  it('a bootstrap address consuming a NON-platform link gets no /auth/nebula-platform cookie', async () => {
    // The consume ensures the platform membership (behind mailbox proof) — so it exists, and the
    // question is only whether mint-all hands out a cookie for it.
    const link = await scopelessLink(BOOTSTRAP);
    const resp = await SELF.fetch(new Request(link, { redirect: 'manual' }));
    expect(await acceptedAt(BOOTSTRAP, PLATFORM_SCOPE)).toBeNull(); // minted, un-taken-up
    // Reds against an unqualified mint-all: an ambient superuser cookie, spendable by any
    // same-origin script, placed by an ordinary login.
    expect(cookieScopes(resp)).not.toContain(PLATFORM_SCOPE);
  });

  it('a bootstrap address consuming a link that NAMES the platform scope does get it', async () => {
    const ml = await requestMagicLink(SELF, PLATFORM_SCOPE, BOOTSTRAP);
    const { magicLinkUrl } = await ml.json() as { magicLinkUrl: string };
    const resp = await SELF.fetch(new Request(magicLinkUrl, { redirect: 'manual' }));
    // The positive control for the carve-out above — without it, that assertion would pass on a
    // build that never minted the platform cookie at all.
    expect(cookieScopes(resp)).toContain(PLATFORM_SCOPE);
  });
  it('past the cap, the scope the LINK NAMED is still minted — it is what the click is about', () => {
    // ⚠️ A unit test on the selector, because constructing 25+ real memberships is minutes of HTTP
    // for a property that is pure ordering. It exists because the ordering shipped wrong once: with
    // acceptance ranked above the link's own scope, an address holding a capful of older accepted
    // memberships could not complete a fresh claim at all — the one cookie the next step needs was
    // the one dropped. The full app suite caught it as ~60 unrelated 401s.
    const older = Array.from({ length: MINT_ALL_COOKIE_CAP + 5 }, (_, i) => ({
      sub: `s${i}`, universeGalaxyStarId: `old${i}`, scopeAdmin: false, profileId: 'p', accepted: true,
    }));
    const fresh = {
      sub: 'fresh', universeGalaxyStarId: 'brand-new', scopeAdmin: true, profileId: 'p', accepted: false,
    };
    const chosen = selectSessionsToMint({
      email: 'x@example.com', purpose: 'claim', linkScope: 'brand-new',
      memberships: [...older, fresh],
    });
    expect(chosen).toHaveLength(MINT_ALL_COOKIE_CAP);         // the cap holds…
    expect(chosen[0].universeGalaxyStarId).toBe('brand-new'); // …and the link's scope is never the one cut
  });
});

describe('Phase 2 — a cookie is inert until its holder accepts', () => {
  it('an unaccepted membership refuses to mint, and accepting the SAME cookie makes it work', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, addr());
    const galaxy = `${u}.app`;
    await createGalaxy(SELF, galaxy, admin.access_token);
    const invitee = addr();
    const mint = await issueInvitesAs(admin.access_token, galaxy, [{ email: invitee }]);
    const { tokenFor } = await clickLink(SELF, mint.results[0].inviteUrl);
    const token = tokenFor(galaxy);

    // Before consent: the cookie exists, and mints nothing.
    const before = await SELF.fetch(new Request(url(galaxy, 'refresh-token'), {
      method: 'POST', headers: { Cookie: `refresh-token=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeScope: galaxy }),
    }));
    expect(before.status).toBe(401);
    expect(await before.text()).toContain('membership_not_accepted');
    expect((await kvRecord(token)).accepted).toBe(false);

    // Consent, then the very same cookie mints.
    await acceptMembership(SELF, galaxy, token);
    expect((await kvRecord(token)).accepted).toBe(true); // the record converged, not just the row
    const after = await refreshAndParse(SELF, galaxy, token);
    expect(after.parsed.access.authScope).toBe(galaxy);
  });

  it('accepting a galaxy invite takes up its co-minted `.dev` sibling in the same act', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, addr());
    const galaxy = `${u}.app`;
    await createGalaxy(SELF, galaxy, admin.access_token);
    const invitee = addr();
    const mint = await issueInvitesAs(admin.access_token, galaxy, [{ email: invitee }]);
    const { tokenFor } = await clickLink(SELF, mint.results[0].inviteUrl);

    expect(await acceptedAt(invitee, `${galaxy}.dev`)).toBeNull();
    await acceptMembership(SELF, galaxy, tokenFor(galaxy));
    // One consent covers the bundle the invitation arrived as — reds if only the primary flips,
    // which would leave the workspace session permanently inert with no modal able to reach it.
    expect(await acceptedAt(invitee, `${galaxy}.dev`)).not.toBeNull();
    const dev = await refreshAndParse(SELF, `${galaxy}.dev`, tokenFor(`${galaxy}.dev`));
    expect(dev.parsed.access.authScope).toBe(`${galaxy}.dev`);
  });

  it('NO consume flips acceptance — not the claim arm, not the invite arm', async () => {
    // The claim arm: its own consume must leave the claimer un-taken-up.
    const claimer = addr();
    const u = uni();
    const magicLinkUrl = await claimUniverse(SELF, u, claimer);
    await clickLink(SELF, magicLinkUrl);
    expect(await acceptedAt(claimer, u)).toBeNull(); // reds against a consume-time flip on the claim arm

    // The invite arm: same.
    const admin = await foundUniverse(SELF, uni(), addr());
    const invitee = addr();
    const scope = admin.parsed.access.authScope;
    const mint = await issueInvitesAs(admin.access_token, scope, [{ email: invitee }]);
    await clickLink(SELF, mint.results[0].inviteUrl);
    expect(await acceptedAt(invitee, scope)).toBeNull(); // reds against a consume-time flip on the invite arm
  });

  it('acceptance is idempotent, and a second Accept writes nothing new', async () => {
    const u = uni();
    const person = addr();
    const founded = await foundUniverse(SELF, u, person); // this helper already accepts once
    const first = await acceptedAt(person, u);
    expect(first).not.toBeNull();
    await acceptMembership(SELF, u, founded.refreshToken);
    expect(await acceptedAt(person, u)).toBe(first); // the stamp is write-once
  });
});
