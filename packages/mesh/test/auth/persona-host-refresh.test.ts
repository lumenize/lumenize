/**
 * A persona's host mints for the member its address names, through the impersonation mint.
 *
 * `gerry--dev.first.{u}.lumenize.localhost` spells the address `gerry--dev.first.{u}@personas.example`,
 * and whoever holds an accepted membership under that address at `{u}.first.dev` is Gerry. The refresh
 * finds that member and hands the impersonation mint the claims it would have minted for the opener
 * on this host, so the token is Gerry's own with the opener in `act`.
 *
 * That first refresh also opens a session for Gerry: a cookie of his own on the platform host,
 * whose record names the opener. Each later refresh reads it and the opener's own from Workers KV,
 * and asks the Registry nothing.
 *
 * In-lane because each refusal here turns on a membership's state this lane sets directly, and the
 * invite is accepted through the link page: the mail handler that accepts a persona's invite has its
 * own file, and the `/live` scenario `persona-host` drives the two together. ADR-009 rung 2.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { hashString } from '@lumenize/crypto';
import {
  authUrl, clickLink, createGalaxy, foundUniverse, issueInvitesAs, logoutRequest, refreshAndParse, refreshCookie,
  refreshCookiesSet, registryStub, scopeOrigin,
} from './test-helpers';
import { sameRefreshRecord } from '../../src/auth/types';

const MAIL_DOMAIN = 'personas.example';

/** A universe with its first app, its admin, and that admin's token on the dev Star's host. */
async function cast() {
  const u = `u${crypto.randomUUID().slice(0, 8)}`;
  const dev = `${u}.first.dev`;
  const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
  const adminAtDev = await refreshAndParse(SELF, u, admin.refreshToken, dev);
  const address = (slug: string) => `${slug}--dev.first.${u}@${MAIL_DOMAIN}`;
  const host = (slug: string) => scopeOrigin(dev).replace('//dev.', `//${slug}--dev.`);
  /** Invite `email` into the dev Star, and accept unless told not to. Answers the member's `sub`. */
  const invite = async (email: string, opts: { scopeAdmin?: boolean; accept?: boolean } = {}) => {
    const mint = await issueInvitesAs(adminAtDev.access_token, dev, [{ email, scopeAdmin: opts.scopeAdmin }]);
    expect(mint.errors).toEqual([]);
    const accepted = opts.accept === false ? undefined : await clickLink(SELF, mint.results[0]!.inviteUrl);
    return { sub: mint.results[0]!.sub, refreshToken: accepted?.refreshToken };
  };
  const refreshOn = (origin: string, cookie: string) => SELF.fetch(new Request(authUrl('refresh-token'), {
    method: 'POST', headers: { Origin: origin, Cookie: cookie },
  }));
  return { u, dev, admin, adminAtDev, address, host, invite, refreshOn, adminCookie: refreshCookie(u, admin.refreshToken) };
}

const payloadOf = (token: string) => JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
const claimsOf = async (resp: Response) => payloadOf((await resp.clone().json() as { access_token: string }).access_token);
/** The Workers KV record behind a refresh cookie's value, as the refresh reads it. */
const kvRecord = async (token: string): Promise<any> => {
  const raw = await (env as any).REFRESH_TOKEN_KV.get(`refresh:${await hashString(token)}`);
  return raw ? JSON.parse(raw) : null;
};
/** A platform admin's claims, for the Registry methods a test calls directly. */
const ACTING = () => ({ sub: crypto.randomUUID(), access: { authScope: '_platform', scopeAdmin: true } }) as any;

describe("a persona's host mints for the member its address names", () => {
  it("gives an admin of the Star the persona's own token, with the admin in act", async () => {
    const c = await cast();
    const gerry = await c.invite(c.address('gerry'));
    const resp = await c.refreshOn(c.host('gerry'), c.adminCookie);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Access-Control-Allow-Origin')).toBe(c.host('gerry'));
    const body = await resp.json() as { access_token: string; sub: string };
    const claims = payloadOf(body.access_token);
    expect(body.sub).toBe(gerry.sub);
    expect(claims.sub).toBe(gerry.sub);
    expect(claims.sub).not.toBe(c.adminAtDev.parsed.sub);
    expect(claims.aud).toBe(c.dev);
    // Gerry's own membership: a plain one at the dev Star, though the opener is an admin.
    expect(claims.access).toEqual({ authScope: c.dev });
    expect(claims.act).toEqual({ sub: c.adminAtDev.parsed.sub, profileId: c.adminAtDev.parsed.profileId });
    expect(claims.profileId).not.toBe(c.adminAtDev.parsed.profileId);
  });

  it("carries the persona's own admin bit when its membership has one", async () => {
    const c = await cast();
    const mary = await c.invite(c.address('mary'), { scopeAdmin: true });
    const resp = await c.refreshOn(c.host('mary'), c.adminCookie);
    expect(resp.status).toBe(200);
    const claims = payloadOf((await resp.json() as { access_token: string }).access_token);
    expect(claims.sub).toBe(mary.sub);
    expect(claims.access).toEqual({ authScope: c.dev, scopeAdmin: true });
  });

  it('refuses a plain member of the Star as opener', async () => {
    const c = await cast();
    await c.invite(c.address('gerry'));
    const pat = await c.invite(`pat-${c.u}@example.com`);
    // The positive control: Pat's cookie does open the dev Star's own page.
    expect((await c.refreshOn(scopeOrigin(c.dev), refreshCookie(c.dev, pat.refreshToken!))).status).toBe(200);
    const resp = await c.refreshOn(c.host('gerry'), refreshCookie(c.dev, pat.refreshToken!));
    expect(resp.status).toBe(401);
    const body = await resp.json() as { access_token?: string; error_description: string };
    expect(body.access_token).toBeUndefined();
    // The impersonation mint's own refusal, naming the opener's host and nothing of Gerry's.
    expect(body.error_description).toBe(`The calling host's scope "${c.dev}" does not administer this subject`);
  });

  // A collaborator: invited into the app as a plain member, which co-mints an admin membership of
  // its dev Star. Their browser holds both cookies, and the plain one covers nothing below the app.
  // Mutation, of the fixture: send the app's cookie alone → 401, which shows the dev Star's
  // membership is what opens the page.
  it('opens for a collaborator, on the dev Star membership their app invite co-minted', async () => {
    const c = await cast();
    const gerry = await c.invite(c.address('gerry'));
    const atUniverse = await refreshAndParse(SELF, c.u, c.admin.refreshToken, c.u);
    const app = `${c.u}.first`;
    const mint = await issueInvitesAs(atUniverse.access_token, app, [{ email: `collab-${c.u}@example.com` }]);
    expect(mint.errors).toEqual([]);
    const collab = await clickLink(SELF, mint.results[0]!.inviteUrl);
    const both = `${refreshCookie(app, collab.tokenFor(app))}; ${refreshCookie(c.dev, collab.tokenFor(c.dev))}`;
    const resp = await c.refreshOn(c.host('gerry'), both);
    expect(resp.status).toBe(200);
    const claims = payloadOf((await resp.json() as { access_token: string }).access_token);
    expect(claims.sub).toBe(gerry.sub);
    // The opener in `act` is the collaborator's dev Star membership, a `sub` of its own.
    expect(claims.act.sub).not.toBe(mint.results[0]!.sub);
    expect(claims.act.sub).not.toBe(payloadOf(c.adminAtDev.access_token).sub);
    // The app's own cookie opens nothing here: a plain member of the app has no dominion below it.
    expect((await c.refreshOn(c.host('gerry'), refreshCookie(app, collab.tokenFor(app)))).status).toBe(401);
  });

  it('refuses a persona whose invite nobody has accepted, and opens once it is', async () => {
    const c = await cast();
    const mint = await issueInvitesAs(c.adminAtDev.access_token, c.dev, [{ email: c.address('gerry') }]);
    const pending = await c.refreshOn(c.host('gerry'), c.adminCookie);
    expect(pending.status).toBe(401);
    expect((await pending.json() as { error_description: string }).error_description)
      .toBe("No member of this Star holds this persona's address yet");
    await clickLink(SELF, mint.results[0]!.inviteUrl);
    expect((await c.refreshOn(c.host('gerry'), c.adminCookie)).status).toBe(200);
  });

  it('refuses a host whose address nobody holds', async () => {
    const c = await cast();
    await c.invite(c.address('gerry'));
    const resp = await c.refreshOn(c.host('sally'), c.adminCookie);
    expect(resp.status).toBe(401);
    expect((await resp.json() as { access_token?: string }).access_token).toBeUndefined();
  });

  it('finds the membership at this Star when the address holds others', async () => {
    const c = await cast();
    // The same address, first a member of the universe and of the app, then of the dev Star.
    const atUniverse = await refreshAndParse(SELF, c.u, c.admin.refreshToken, c.u);
    for (const scope of [c.u, `${c.u}.first`]) {
      const elsewhere = await issueInvitesAs(atUniverse.access_token, scope, [{ email: c.address('gerry') }]);
      expect(elsewhere.errors).toEqual([]);
      await clickLink(SELF, elsewhere.results[0]!.inviteUrl);
    }
    const resp = await c.refreshOn(c.host('gerry'), c.adminCookie);
    expect(resp.status).toBe(200);
    const claims = payloadOf((await resp.json() as { access_token: string }).access_token);
    expect(claims.access).toEqual({ authScope: c.dev, scopeAdmin: true });
  });
});


describe("a persona's host keeps a session of its own", () => {
  afterEach(() => { vi.useRealTimers(); });

  /** Open `slug`'s session as the universe's admin: the persona, its cookie's name and value. */
  async function opened(slug = 'gerry', opts: { scopeAdmin?: boolean } = {}) {
    const c = await cast();
    const member = await c.invite(c.address(slug), opts);
    const first = await c.refreshOn(c.host(slug), c.adminCookie);
    expect(first.status).toBe(200);
    const name = `${c.u}.first.${slug}--dev`;
    const token = refreshCookiesSet(first).get(name)!;
    return { c, member, first, name, token, cookie: refreshCookie(name, token) };
  }

  // Mutations: name the cookie for the Star → the name is the admin's own; give it the 30-day
  // life → Max-Age and the record's expiry move; drop the actor from the recorded session → the
  // record names Gerry alone.
  it('the first refresh opens it: a cookie named as the host spells the persona, a day long, whose record names the opener', async () => {
    const { c, member, first, name, token } = await opened();
    expect([...refreshCookiesSet(first).keys()]).toEqual([name]);
    const header = ((first.headers as any).getSetCookie() as string[]).find((h) => h.includes(name));
    expect(header).toBe(`__Host-refresh-token.${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
    const record = await kvRecord(token);
    expect(record).toMatchObject({
      sub: member.sub, universeGalaxyStarId: c.dev, scopeAdmin: false, accepted: true,
      actor: { sub: c.adminAtDev.parsed.sub, profileId: c.adminAtDev.parsed.profileId },
    });
    const life = (Date.parse(record.expiresAt) - Date.now()) / 1000;
    expect(life).toBeGreaterThan(86400 - 120);
    expect(life).toBeLessThanOrEqual(86400);
  });

  // The Registry's row for Gerry is deleted behind its back, which no route does, so that a read
  // of the Registry would show: with the admin's cookie alone the refresh asks who holds the
  // address and is told nobody. With the session's cookie it reads Workers KV and mints.
  // Mutation: skip the held session → the second refresh asks the Registry too, and 401s.
  it('a later refresh reads the session and asks the Registry nothing', async () => {
    const { c, member, first, cookie } = await opened();
    await (runInDurableObject as any)(registryStub(), (_i: any, state: any) => {
      state.storage.sql.exec('DELETE FROM Memberships WHERE sub = ?', member.sub);
    });
    const asked = await c.refreshOn(c.host('gerry'), c.adminCookie);
    expect(asked.status).toBe(401);
    const held = await c.refreshOn(c.host('gerry'), `${c.adminCookie}; ${cookie}`);
    expect(held.status).toBe(200);
    expect(refreshCookiesSet(held).size).toBe(0);
    const [before, after] = [await claimsOf(first), await claimsOf(held)];
    expect([after.sub, after.aud, after.access, after.act, after.profileId])
      .toEqual([before.sub, before.aud, before.access, before.act, before.profileId]);
    expect(after.sub).toBe(member.sub);
  });

  it('the session alone opens nothing: its opener must send their own', async () => {
    const { c, cookie } = await opened();
    const resp = await c.refreshOn(c.host('gerry'), cookie);
    expect(resp.status).toBe(401);
    expect((await resp.json() as { error_description: string }).error_description).toBe('No refresh cookie covers this host');
  });

  // Amy administers the dev Star, opens Gerry's session, and is then demoted. Her own record is
  // converged, so the session she opened stops answering her.
  // Mutation: drop the dominion test from the held session's check → her demoted cookie still mints.
  it('an opener who loses dominion loses the sessions they opened', async () => {
    const c = await cast();
    await c.invite(c.address('gerry'));
    const amy = await c.invite(`amy-${c.u}@example.com`, { scopeAdmin: true });
    const amyCookie = refreshCookie(c.dev, amy.refreshToken!);
    const first = await c.refreshOn(c.host('gerry'), amyCookie);
    expect(first.status).toBe(200);
    const session = refreshCookie(`${c.u}.first.gerry--dev`, refreshCookiesSet(first).get(`${c.u}.first.gerry--dev`)!);
    expect((await c.refreshOn(c.host('gerry'), `${amyCookie}; ${session}`)).status).toBe(200);
    await registryStub().setIdentityAdmin(amy.sub, false, ACTING());
    const resp = await c.refreshOn(c.host('gerry'), `${amyCookie}; ${session}`);
    expect(resp.status).toBe(401);
    expect((await resp.json() as { error_description: string }).error_description)
      .toBe(`The calling host's scope "${c.dev}" does not administer this subject`);
  });

  // Mutation: drop the opener test from the held session's check → Amy reads the first admin's
  // session, and her tab's writes name him as the actor.
  it("another admin's browser opens a session of its own, naming them", async () => {
    const { c, member, cookie, token } = await opened();
    const amy = await c.invite(`amy-${c.u}@example.com`, { scopeAdmin: true });
    const resp = await c.refreshOn(c.host('gerry'), `${refreshCookie(c.dev, amy.refreshToken!)}; ${cookie}`);
    expect(resp.status).toBe(200);
    const claims = await claimsOf(resp);
    expect([claims.sub, claims.act.sub]).toEqual([member.sub, amy.sub]);
    const reopened = refreshCookiesSet(resp).get(`${c.u}.first.gerry--dev`);
    expect(reopened).toBeDefined();
    expect(reopened).not.toBe(token);
    expect((await kvRecord(reopened!)).actor.sub).toBe(amy.sub);
  });

  // A client that is no browser can send the session's value under the Star's own name, to the
  // Star's own host, where a person's cookie is read.
  // Mutation: mint a person's token from the record without its actor → Gerry's token names nobody else.
  it("presented under the Star's own name, the session still mints with its opener in act", async () => {
    const { c, member, token } = await opened();
    const resp = await c.refreshOn(scopeOrigin(c.dev), refreshCookie(c.dev, token));
    expect(resp.status).toBe(200);
    const claims = await claimsOf(resp);
    expect([claims.sub, claims.act]).toEqual([member.sub, { sub: c.adminAtDev.parsed.sub, profileId: c.adminAtDev.parsed.profileId }]);
  });

  // Mary is an admin persona, so her session's record carries the admin bit, and under the Star's
  // own name it would pass for an admin's cookie.
  // Mutation: build the opener's claims without the record's actor → Mary's session opens Gerry's.
  it("an admin persona's session opens no other persona's", async () => {
    const { c, token } = await opened('mary', { scopeAdmin: true });
    await c.invite(c.address('gerry'));
    const resp = await c.refreshOn(c.host('gerry'), refreshCookie(c.dev, token));
    expect(resp.status).toBe(401);
    expect((await resp.json() as { error_description: string }).error_description)
      .toBe('Impersonation requires a root identity (a token carrying no `act` chain)');
  });

  // Mutation: compose the converged record without the index row's actor → the re-put is reaped
  // as differing from the Registry's own, and no record stands in KV.
  it("a persona's promotion converges its session, and the record keeps its opener", async () => {
    const { c, member, token, cookie } = await opened();
    await registryStub().setIdentityAdmin(member.sub, true, ACTING());
    const record = await kvRecord(token);
    expect(record).toMatchObject({ sub: member.sub, scopeAdmin: true, actor: { sub: c.adminAtDev.parsed.sub } });
    const claims = await claimsOf(await c.refreshOn(c.host('gerry'), `${c.adminCookie}; ${cookie}`));
    expect([claims.access, claims.act.sub]).toEqual([{ authScope: c.dev, scopeAdmin: true }, c.adminAtDev.parsed.sub]);
  });

  // Mutation: leave the persona sessions out of the logout's revoke → the Registry still answers
  // for the session after its opener logged out.
  it("its opener's logout expires its cookie and ends it", async () => {
    const { c, name, token, cookie } = await opened();
    expect(await registryStub().getRefreshRecord(await hashString(token))).not.toBeNull();
    const resp = await SELF.fetch(logoutRequest([c.adminCookie, cookie]));
    expect(resp.status).toBe(200);
    const expiries = ((resp.headers as any).getSetCookie() as string[]).filter((h) => h.includes('Max-Age=0'));
    expect(expiries.some((h) => h.startsWith(`__Host-refresh-token.${name}=;`))).toBe(true);
    expect(await registryStub().getRefreshRecord(await hashString(token))).toBeNull();
    expect(await kvRecord(token)).toBeNull();
  });

  // A second app in the same universe has a Gerry of its own. The first app's session is sent under
  // the second's name, by a client that is no browser, with the admin who holds dominion over both.
  // Dominion is read from the host asked on, which covers its own Star alone, so no test of the
  // Star's name is needed. Mutation: drop the dominion test from the held session's check → the
  // second app's host is handed the first app's Gerry.
  it("a session for one Star's persona is not read on another Star's host", async () => {
    const { c, member, token } = await opened();
    const atUniverse = await refreshAndParse(SELF, c.u, c.admin.refreshToken, c.u);
    await createGalaxy(`${c.u}.second`, atUniverse.access_token);
    const dev2 = `${c.u}.second.dev`;
    const adminAtDev2 = await refreshAndParse(SELF, c.u, c.admin.refreshToken, dev2);
    const mint = await issueInvitesAs(adminAtDev2.access_token, dev2, [{ email: `gerry--dev.second.${c.u}@${MAIL_DOMAIN}` }]);
    expect(mint.errors).toEqual([]);
    await clickLink(SELF, mint.results[0]!.inviteUrl);
    const host2 = scopeOrigin(dev2).replace('//dev.', '//gerry--dev.');
    const resp = await c.refreshOn(host2, `${c.adminCookie}; ${refreshCookie(`${c.u}.second.gerry--dev`, token)}`);
    expect(resp.status).toBe(200);
    const claims = await claimsOf(resp);
    expect(claims.sub).toBe(mint.results[0]!.sub);
    expect(claims.sub).not.toBe(member.sub);
    expect(claims.aud).toBe(dev2);
  });

  // A day and an hour on, the session has lapsed and its opener's has not.
  // Mutation: drop the lapse test from the held session's check → the lapsed session still mints,
  // and no new one is opened.
  it('a lapsed session is not read, and the next refresh opens another', async () => {
    const { c, member, token, name, cookie } = await opened();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.now() + 25 * 3600 * 1000));
    const resp = await c.refreshOn(c.host('gerry'), `${c.adminCookie}; ${cookie}`);
    expect(resp.status).toBe(200);
    expect((await claimsOf(resp)).sub).toBe(member.sub);
    const reopened = refreshCookiesSet(resp).get(name);
    expect(reopened).toBeDefined();
    expect(reopened).not.toBe(token);
  });

  // The admin's own session has half a day left when the persona's opens, so a day would outlast it.
  // Mutation: always give the session its full day → its record lapses after its opener's.
  it("it ends no later than its opener's own session", async () => {
    const c = await cast();
    await c.invite(c.address('gerry'));
    const opener = await kvRecord(c.admin.refreshToken);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.parse(opener.expiresAt) - 12 * 3600 * 1000));
    const resp = await c.refreshOn(c.host('gerry'), c.adminCookie);
    expect(resp.status).toBe(200);
    const record = await kvRecord(refreshCookiesSet(resp).get(`${c.u}.first.gerry--dev`)!);
    expect(record.expiresAt).toBe(opener.expiresAt);
  });
});


describe('whether a put record still says what the Registry says', () => {
  const record = { sub: 's', universeGalaxyStarId: 'u.g.dev', scopeAdmin: false, accepted: true, expiresAt: '2026-12-01T00:00:00.000Z', profileId: 'p' };
  const actor = { sub: 'a', profileId: 'ap' };
  // Mutation: compare every field but the actor → a put that lost its opener is taken for current.
  it('compares the actor, so a record that lost or changed its opener differs', () => {
    expect(sameRefreshRecord({ ...record, actor }, { ...record, actor })).toBe(true);
    expect(sameRefreshRecord({ ...record, actor }, record)).toBe(false);
    expect(sameRefreshRecord(record, { ...record, actor })).toBe(false);
    expect(sameRefreshRecord({ ...record, actor }, { ...record, actor: { ...actor, sub: 'b' } })).toBe(false);
    expect(sameRefreshRecord({ ...record, actor }, { ...record, actor: { ...actor, profileId: 'bp' } })).toBe(false);
  });
});
