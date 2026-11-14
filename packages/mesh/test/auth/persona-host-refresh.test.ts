/**
 * A persona's host mints for the member its address names, through the impersonation mint.
 *
 * `gerry--dev.first.{u}.lumenize.localhost` spells the address `gerry--dev.first.{u}@personas.example`,
 * and whoever holds an accepted membership under that address at `{u}.first.dev` is Gerry. The refresh
 * finds that member and hands the impersonation mint the claims it would have minted for the opener
 * on this host, so the token is Gerry's own with the opener in `act`.
 *
 * In-lane because each refusal here turns on a membership's state this lane sets directly, and the
 * invite is accepted through the link page: the mail handler that accepts a persona's invite has its
 * own file, and the `/live` scenario `persona-host` drives the two together. ADR-009 rung 2.
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import {
  authUrl, clickLink, foundUniverse, issueInvitesAs, refreshAndParse, refreshCookie, scopeOrigin,
} from './test-helpers';

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
