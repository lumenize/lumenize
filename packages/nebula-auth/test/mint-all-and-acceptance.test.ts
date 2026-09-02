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
 *  - **The superuser comes through the front door.** A configured bootstrap address gets its
 *    `nebula-platform` membership on any consume (behind mailbox proof), and mint-all sets that
 *    cookie like any other. ⚠️ A carve-out here used to withhold it unless the link itself named the
 *    platform scope; it was dropped 2026-09-01 and the tests below assert the reversal — read them,
 *    not this bullet, and see `selectSessionsToMint`'s JSDoc for why both reasons retired it.
 *  - **Inert until accepted.** The cookies exist before consent, so something must stop them being
 *    usable — otherwise the consent modal decorates a session that already works, and a direct link
 *    to the scope's surface would connect. `refresh-token` refuses an unaccepted membership, and the
 *    accept endpoint is what converges the record.
 */
import { describe, it, expect } from 'vitest';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
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

  it('a bootstrap address gets its platform cookie from the ORDINARY scope-less login', async () => {
    // ⚠️ **This inverts a carve-out that used to live here (dropped 2026-09-01).** mint-all excluded
    // the platform cookie unless the consumed link NAMED that scope — but the scope-less login is the
    // only front door now, so that rule left a superuser able to see their platform row on Home and
    // unable to accept it: the accept endpoint authenticates by the very cookie the rule withheld.
    const link = await scopelessLink(BOOTSTRAP);
    const resp = await SELF.fetch(new Request(link, { redirect: 'manual' }));
    expect(cookieScopes(resp)).toContain(PLATFORM_SCOPE);
  });

  it('...and that cookie is INERT — the consent modal, not a carve-out, is what gates superuser-ship', async () => {
    // The safety story the carve-out used to carry, asserted where it now lives. An ambient platform
    // cookie grants NOTHING: it mints no token until its membership is accepted, and accepting means
    // clicking through a modal that says "Only accept if you initiated this signup."
    const link = await scopelessLink(BOOTSTRAP);
    const resp = await SELF.fetch(new Request(link, { redirect: 'manual' }));
    const token = (resp.headers as any).getSetCookie()
      .find((c: string) => c.includes(`Path=${'/auth/'}${PLATFORM_SCOPE}`))!
      .split(';')[0].split('=')[1];

    expect(await acceptedAt(BOOTSTRAP, PLATFORM_SCOPE)).toBeNull(); // minted, un-taken-up
    const minted = await SELF.fetch(new Request(url(PLATFORM_SCOPE, 'refresh-token'), {
      method: 'POST', headers: { Cookie: `refresh-token=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeScope: PLATFORM_SCOPE }),
    }));
    // ⚠️ THE assertion. Reds against dropping inert-until-accepted, which is now the ONLY thing
    // standing between an unsolicited invite click and a live superuser session.
    expect(minted.status).toBe(401);
    expect(await minted.text()).toContain('membership_not_accepted');

    // Positive control: consent turns the same cookie live, so the 401 above is the gate working
    // rather than the platform session being broken outright.
    await acceptMembership(SELF, PLATFORM_SCOPE, token);
    const after = await refreshAndParse(SELF, PLATFORM_SCOPE, token);
    expect(after.parsed.access.authScope).toBe(PLATFORM_SCOPE);
  });

  it('records ONE ADR-016 session record naming every scope the click established', async () => {
    // ⚠️ **ADR-016 § *In scope today* names establishing a session explicitly**, and the record had
    // gone missing: the pre-existing `login.succeeded` marker was deleted when the single-session
    // consume was replaced by mint-all, so for a while a login was recorded nowhere at all.
    //
    // Asserted through the debug sink because the mechanism IS the activity log — ADR-016 § *What is
    // recorded is the commitment; where it goes is not* puts a `@lumenize/debug` line at the point of
    // action and imposes no schema obligation. The sink also sees DO-side entries under
    // pool-workers, which is where this one is emitted (`testing.md`).
    const person = addr();
    const a = uni(); const b = uni();
    for (const u of [a, b]) await foundUniverse(SELF, u, person);

    const entries: any[] = [];
    setDebugSink((e) => entries.push(e));
    try {
      await SELF.fetch(new Request(await scopelessLink(person), { redirect: 'manual' }));
    } finally {
      clearDebugSink();
    }

    const records = entries.filter((e) => e.namespace === 'nebula-auth.Registry.login.established');
    // ONE line for the whole act, not one per session — a reader asking what a login turned into
    // wants the set. Reds against moving the line inside the loop.
    expect(records).toHaveLength(1);

    const sessions = records[0].data.sessions as Array<Record<string, unknown>>;
    // The SET of scopes, never a count: recording two sessions for the wrong two would pass a length
    // check, and this is the field the record exists to carry.
    expect(sessions.map((s) => s.universeGalaxyStarId).sort()).toEqual([a, b].sort());
    // Every principal the act put into play. `profileId` is what still names the human after the
    // membership is gone (ADR-013's write-time-pinned stamp), and `accepted` is what says whether the
    // cookie this record describes can do anything yet.
    for (const s of sessions) {
      expect(s.sub).toEqual(expect.any(String));
      expect(s.profileId).toEqual(expect.any(String));
      expect(s.accepted).toBe(true); // `foundUniverse` accepts, so a regression to `false` reds here
      expect(s).toHaveProperty('scopeAdmin');
    }
    // ⚠️ A record must never carry the credential it describes (critical.md). Reds against adding
    // `tokenHash` — a hash is not the raw value, but it is the lookup key for a live session.
    expect(JSON.stringify(records[0].data)).not.toContain('tokenHash');
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

describe('Phase 10 — the consent modal can be rendered before any session exists', () => {
  /**
   * ⚠️ **This endpoint exists because a refresh REFUSES an unaccepted membership**, which is exactly
   * the membership Home renders a modal for — so without it the screen that takes consent could
   * never learn what it was taking consent for. Found by driving the rendered page
   * (`harness/scenarios/auth-pages-render.ts`), not by any suite.
   */
  const card = (scope: string, token: string) => SELF.fetch(new Request(url(scope, 'pending-membership'), {
    method: 'POST', headers: { Cookie: `refresh-token=${token}`, 'Content-Type': 'application/json' },
  }));

  it('answers the modal inputs for an UNACCEPTED membership, with no access token anywhere', async () => {
    const claimer = addr();
    const u = uni();
    const { tokenFor } = await clickLink(SELF, await claimUniverse(SELF, u, claimer));

    const resp = await card(u, tokenFor(u));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ universeGalaxyStarId: u, accepted: false });
  });

  it('marks an INVITED membership `invited`, even when the sender supplied NO name', async () => {
    // ⚠️ **The discriminator is `invited`, NOT the attribution fields, and this fixture is why.**
    // `issueInvitesAs` passes no inviter name, so `invitedByName` is null — and `JSON.stringify`
    // drops undefined keys, so a card keyed on the name alone came back byte-identical to a
    // self-claim. The invitee would then meet "Only accept if you initiated this signup" for
    // something a third party initiated. Reds against going back to the attribution fields.
    const u = uni();
    const admin = await foundUniverse(SELF, u, addr());
    const invitee = addr();
    const mint = await issueInvitesAs(admin.access_token, u, [{ email: invitee }]);
    const { tokenFor } = await clickLink(SELF, mint.results[0].inviteUrl);
    const invited = await (await card(u, tokenFor(u))).json() as any;
    expect(invited.invited).toBe(true);
    expect(invited).not.toHaveProperty('invitedByName'); // the fixture supplied none

    // A self-claim carries no stamp at all — the other half, without which the assertion above
    // would pass on a build that marked EVERY membership invited.
    const selfClaimer = addr();
    const su = uni();
    const self = await clickLink(SELF, await claimUniverse(SELF, su, selfClaimer));
    const own = await (await card(su, self.tokenFor(su))).json() as any;
    expect(own.invited).toBeUndefined();
  });

  it('answers about the COOKIE\'s membership, never the scope in the URL', async () => {
    // ⚠️ The security property. Presenting scope A's cookie at scope B's path must describe A —
    // otherwise a holder of any cookie could read the modal inputs of any membership they name.
    const person = addr();
    const a = uni(); const b = uni();
    await foundUniverse(SELF, a, person);
    await claimUniverse(SELF, b, person);
    const resp = await SELF.fetch(new Request('https://example.com/auth/email-magic-link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: person }),
    }));
    const { tokenFor } = await clickLink(SELF, (await resp.json() as any).magicLinkUrl);

    const answered = await (await card(b, tokenFor(a))).json() as any;
    expect(answered.universeGalaxyStarId).toBe(a);
    expect(answered.universeGalaxyStarId).not.toBe(b);
  });

  it('refuses a cookie-less request', async () => {
    const resp = await SELF.fetch(new Request(url(uni(), 'pending-membership'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }));
    expect(resp.status).toBe(401);
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
