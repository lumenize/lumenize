/**
 * One logout ends every session the browser's cookies name, and acceptance has exactly two writers.
 *
 *  - **The logout is the symmetric twin of mint-all.** One consume set a cookie per membership of the
 *    address; one logout ends all of them, so "log out" on a shared machine means "not still signed
 *    in over there". `everywhere` widens it to every session of each address those cookies name, on
 *    every device — what someone who lost a laptop needs.
 *  - **The writer story, whole.** The link page's `POST` and Home's `accept-membership` both write
 *    `acceptedAt`, through the Registry's one method; a plain login's consume, the page's lookup and
 *    the refresh do not. Each arm is asserted separately, because one "acceptance works" test passes
 *    while another arm quietly also writes.
 *
 * In-lane because each arm's observable is a Registry row; the `/live` scenarios drive the same
 * routes from rendered pages.
 */
import { describe, it, expect } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import {
  foundUniverse, claimUniverse, issueInvitesAs, clickLink, acceptMembership, refreshAndParse, authUrl,
  plainLogin, lookupLink, platformLogin, refresh, refreshCookie, SUPERUSER_PAGE_SCOPE, BOOTSTRAP_EMAIL,
} from './test-helpers';
import { PLATFORM_SCOPE } from '../src/types';

const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;
const addr = () => `p5-${crypto.randomUUID().slice(0, 8)}@example.com`;
const getRegistry = (): any => env.AUTH_REGISTRY.getByName('registry');

/** Can this cookie still mint, from a page on its own scope's host? */
async function stillRefreshes(scope: string, token: string, page = scope): Promise<boolean> {
  return (await refresh(SELF, page, refreshCookie(scope, token))).status === 200;
}

/** `POST /auth/logout` presenting `cookies`, with `everywhere` when asked. */
function logout(cookies: string[], everywhere?: boolean): Promise<Response> {
  return SELF.fetch(new Request(authUrl('logout'), {
    method: 'POST',
    headers: { Cookie: cookies.join('; '), 'Content-Type': 'application/json' },
    body: JSON.stringify(everywhere === undefined ? {} : { everywhere }),
  }));
}

/** The `Max-Age=0` cookies a response sets, by name. */
function expired(resp: Response): string[] {
  return ((resp.headers as any).getSetCookie() as string[])
    .filter((c) => c.includes('Max-Age=0'))
    .map((c) => c.split('=')[0]);
}

async function acceptedAt(email: string, scope: string): Promise<string | null> {
  return (runInDurableObject as any)(getRegistry(), (_i: any, c: any) => {
    const rows = [...c.storage.sql.exec(
      `SELECT m.acceptedAt AS a FROM Memberships m JOIN Emails e ON e.emailId = m.emailId
       WHERE e.email = ? AND m.universeGalaxyStarId = ?`, email, scope)];
    return rows.length ? rows[0].a : null;
  });
}

describe('one logout ends every session the browser\'s cookies name', () => {
  it('ends the session behind every cookie it receives, and expires each with Secure', async () => {
    const person = addr();
    const a = uni(); const b = uni();
    await foundUniverse(SELF, a, person);
    await foundUniverse(SELF, b, person);
    const { tokenFor } = await plainLogin(SELF, person); // one browser holding both
    expect(await stillRefreshes(a, tokenFor(a))).toBe(true);
    expect(await stillRefreshes(b, tokenFor(b))).toBe(true); // both live — the fixture is not vacuous

    const resp = await logout([refreshCookie(a, tokenFor(a)), refreshCookie(b, tokenFor(b))]);
    expect(resp.status).toBe(200);

    // ⚠️ The second scope is the assertion. Ending only one cookie is the plausible wrong
    // implementation, and it passes every check that looks at `a` alone.
    expect(await stillRefreshes(a, tokenFor(a))).toBe(false);
    expect(await stillRefreshes(b, tokenFor(b))).toBe(false);
    expect(expired(resp)).toEqual(expect.arrayContaining([
      `__Host-refresh-token.${a}`, `__Host-refresh-token.${b}`,
    ]));
    // A browser discards a `__Host-` header without `Secure`, so an expiry without it expires nothing.
    for (const c of ((resp.headers as any).getSetCookie() as string[])) expect(c).toContain('Secure');
  });

  it('ends only the sessions this browser presents, unless asked to end them everywhere', async () => {
    const person = addr();
    const a = uni(); const b = uni();
    await foundUniverse(SELF, a, person);
    await foundUniverse(SELF, b, person);
    const laptop = await plainLogin(SELF, person);
    const phone = await plainLogin(SELF, person);

    await logout([refreshCookie(a, laptop.tokenFor(a)), refreshCookie(b, laptop.tokenFor(b))]);
    expect(await stillRefreshes(a, laptop.tokenFor(a))).toBe(false);
    expect(await stillRefreshes(a, phone.tokenFor(a))).toBe(true); // reds if logout widened silently

    // `everywhere` from one cookie ends every session of that address, the other scope's included.
    await logout([refreshCookie(a, phone.tokenFor(a))], true);
    expect(await stillRefreshes(a, phone.tokenFor(a))).toBe(false);
    expect(await stillRefreshes(b, phone.tokenFor(b))).toBe(false);
  });

  // The platform cookie's name is the root, which `parseId` refuses, so a classification that
  // forgot `isPlatformScope` would leave it unread, unrevoked and still minting.
  it('ends the platform membership\'s session too', async () => {
    const superuser = await platformLogin(SELF, BOOTSTRAP_EMAIL);
    const cookie = refreshCookie(PLATFORM_SCOPE, superuser.refreshToken);
    expect(await stillRefreshes(PLATFORM_SCOPE, superuser.refreshToken, SUPERUSER_PAGE_SCOPE)).toBe(true);
    await logout([cookie]);
    expect(await stillRefreshes(PLATFORM_SCOPE, superuser.refreshToken, SUPERUSER_PAGE_SCOPE)).toBe(false);
  });

  it('expires a refresh cookie whose name parses as no scope, without reading it', async () => {
    const resp = await logout(['__Host-refresh-token.Not..A_Scope=whatever']);
    expect(resp.status).toBe(200);
    expect(expired(resp)).toEqual(['__Host-refresh-token.Not..A_Scope']);
  });
});

describe('acceptance has two writers: the link page and Home', () => {
  it('an invite page\'s Accept: YES', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, addr());
    const invitee = addr();
    const mint = await issueInvitesAs(admin.access_token, u, [{ email: invitee }]);
    await clickLink(SELF, mint.results[0].inviteUrl);
    expect(await acceptedAt(invitee, u)).not.toBeNull();
  });

  it('a claim page\'s Accept: YES', async () => {
    const claimer = addr();
    const u = uni();
    await clickLink(SELF, await claimUniverse(SELF, u, claimer));
    expect(await acceptedAt(claimer, u)).not.toBeNull();
  });

  it('loading a link\'s page: NO', async () => {
    const claimer = addr();
    const u = uni();
    expect((await lookupLink(SELF, await claimUniverse(SELF, u, claimer))).status).toBe(200);
    expect(await acceptedAt(claimer, u)).toBeNull();
  });

  it('a GET of the link itself, as a mail scanner or an <img> sends it: NO — and the link still works', async () => {
    // The Worker's own GET row, which a local stack's vite answers for it, so no `/live` limb
    // reaches it: the page this GET serves is static, and only its script's POST consumes.
    const claimer = addr();
    const u = uni();
    const link = await claimUniverse(SELF, u, claimer);
    const fetched = await SELF.fetch(new Request(link));
    await fetched.text();
    expect(await acceptedAt(claimer, u)).toBeNull();
    expect((await (await lookupLink(SELF, link)).json() as { spent: boolean }).spent).toBe(false);
    await clickLink(SELF, link);
    expect(await acceptedAt(claimer, u)).not.toBeNull();
  });

  it('a plain login\'s Continue: NO — it names no membership to accept', async () => {
    const claimer = addr();
    const u = uni();
    await claimUniverse(SELF, u, claimer);
    await plainLogin(SELF, claimer);
    expect(await acceptedAt(claimer, u)).toBeNull();
  });

  it('refresh: NO — it READS acceptance and never writes it', async () => {
    const person = addr();
    const u = uni();
    const founded = await foundUniverse(SELF, u, person); // accepted by the claim page
    const before = await acceptedAt(person, u);
    await refreshAndParse(SELF, u, founded.refreshToken);
    await refreshAndParse(SELF, u, founded.refreshToken);
    // Reds against a refresh that re-stamps: the value must be the ONE moment consent happened,
    // not the last time a token was minted.
    expect(await acceptedAt(person, u)).toBe(before);
  });

  it('Home\'s Accept: YES', async () => {
    const claimer = addr();
    const u = uni();
    await claimUniverse(SELF, u, claimer);
    const { tokenFor } = await plainLogin(SELF, claimer);
    expect(await acceptedAt(claimer, u)).toBeNull();
    await acceptMembership(SELF, u, tokenFor(u));
    expect(await acceptedAt(claimer, u)).not.toBeNull();
  });

  it('Home\'s Accept refuses a cookie whose record is not the scope its name and the body give', async () => {
    const person = addr();
    const a = uni(); const b = uni();
    await foundUniverse(SELF, a, person);
    await claimUniverse(SELF, b, person); // pending, unaccepted
    const { tokenFor } = await plainLogin(SELF, person);

    // Scope A's value under scope B's name — what a client that is not a browser can send. The
    // record decides, so it is refused rather than resolved to A.
    const resp = await SELF.fetch(new Request(authUrl('accept-membership'), {
      method: 'POST',
      headers: { Cookie: refreshCookie(b, tokenFor(a)), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: b }),
    }));
    expect(resp.status).toBe(401);
    expect(await acceptedAt(person, b)).toBeNull();
  });
});
