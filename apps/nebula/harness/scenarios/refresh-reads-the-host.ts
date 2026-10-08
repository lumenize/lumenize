/**
 * **The refresh reads the page's host, and the cookies decide nothing their records do not.**
 *
 * A page on any scope host gets its token from one route on the platform host. The page names
 * nothing: `Origin` names its host, and the browser sends every refresh cookie it holds. So
 * everything about which membership mints is the server's to get right, and each limb here drives
 * one rule of it with real logins, real invites and real acceptances — no cookie is built by hand
 * except where a limb is about a cookie someone forged.
 *
 * The cast, all in one account `acme` with its first app `crm` and two tenant Stars, `t1` and `t2`:
 *  - **O**, who claimed `acme` and so holds dominion over all of it.
 *  - **X**, who founded a universe of their own, `evil`, and is a plain member of `t1` and `t2`.
 *  - **Y**, invited as an admin at `acme` and at `acme.crm`, and as a plain member of `t1`.
 *  - **P**, invited as an admin at `acme`, never accepted, and a plain member of `t1`.
 *  - **Q**, invited as a plain member of `t1`, who signs in through a plain link without accepting.
 *
 * Limbs, each isolated (`live.md` — per limb), each refusal matched by its message:
 *
 *  1. **Only cookies at or above the host are read.** X's refresh on `t1`'s host carries `evil` and
 *     `t1`, and the read markers name `t1` alone. *Reds if every refresh cookie is a candidate.*
 *  2. **The first admin candidate ends the read.** Y's refresh on `t1`'s host carries `acme`,
 *     `acme.crm` and `t1`, and the markers name `acme` alone. *Reds if every candidate is read.*
 *  3. **The admin membership is picked over the plain one, and its dominion holds on the page.**
 *     Y's token on `t1`'s host has `authScope: acme`, and a dominion-gated call on `t1` from that
 *     page lands. *Reds if the plain membership is picked — the call is then refused by message.*
 *  4. **One person carries the universe membership's `sub` on the universe's page and the
 *     galaxy's.** *Reds if the nearest admin membership is picked.*
 *  5. **A cookie's name nominates it, and its record decides.** X's `evil` value sent as
 *     `__Host-refresh-token.{acme}` from `t1`'s host is refused as the refresh's own 401, and the
 *     same value under its own name mints on `evil`'s host. *Reds if the name supplies the scope.*
 *  6. **Only an accepted membership mints.** P's pending admin membership at `acme` beside an
 *     accepted plain one at `t1` mints the plain one; Q, pending alone, is refused
 *     `membership_not_accepted` until Q accepts on Home. *Reds if either arm stops checking
 *     acceptance.*
 *  7. **A revoked membership's cookie is expired by the refresh that finds it gone.** After `t2` is
 *     deleted, X's refresh on `t2`'s host answers with that cookie expired, `Secure` included, and
 *     X's browser no longer holds it. *Reds if the double miss stops expiring the cookie.*
 *
 * Limbs 1 and 2 read the stack's stdio, which a deployed target does not capture; they say so there.
 *
 * `needsContainer = false` — auth, the Registry and one facade call only.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { Star } from '@lumenize/nebula';
import type { DevStack } from '../lib/harness';
import { connectDriver, inviteViaMesh, readDevVar, scopeUrlOf } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { waitForDebugLines } from '../lib/stdio';
import {
  provisionAndLogin, foundTenantStar, consumeLink, refreshTokenForScope, setCookieHeaders, refreshCookie,
  refreshFromPage, refreshAccessToken, requestMagicLink, acceptMembership,
} from '../../test/lib/email-login';

export const needsContainer = false;
export const bootVars = { DEBUG: 'nebula-auth.worker.refresh' };

type Claims = { sub: string; aud: string; access: { authScope: string; scopeAdmin?: boolean } };
const claimsOf = (token: string) => parseJwtUnsafe(token)!.payload as unknown as Claims;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const observable = stack.logs !== undefined;
  const acme = testSlug('rh');
  const galaxy = `${acme}.crm`;
  const t1 = `${galaxy}.t1`;
  const t2 = `${galaxy}.t2`;
  const evil = testSlug('rhe');

  /** The link an invite mails, armed before the send and filtered by its unique recipient. */
  const inviteLink = async (
    admin: { accessToken: string; sub: string }, scope: string, email: string, scopeAdmin = false,
  ): Promise<string> => {
    const waiter = waitForEmail({ testToken, to: email, timeout: 120_000 });
    try {
      const summary = await inviteViaMesh(stack, admin, scope, [{ email, scopeAdmin }]);
      assert.equal(summary.errors.length, 0, `the invite into ${scope} failed: ${JSON.stringify(summary.errors)}`);
      const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec((await waiter.emailPromise).html ?? '')?.[1];
      assert.ok(href, `the invite into ${scope} carried no link`);
      return href.replace(/&amp;/g, '&');
    } finally {
      waiter.cleanup();
    }
  };
  /** Press a link's button and come back with every refresh cookie it set, by scope. */
  const cookiesFrom = async (link: string, fetchImpl: typeof fetch = fetch): Promise<Map<string, string>> => {
    const res = await consumeLink(link, fetchImpl, { nickname: 'Rh' });
    const set = setCookieHeaders(res);
    const out = new Map<string, string>();
    for (const scope of [acme, galaxy, t1, t2, evil]) {
      const token = refreshTokenForScope(set, scope);
      if (token) out.set(scope, token);
    }
    return out;
  };
  const header = (cookies: Map<string, string>, scopes: string[]) =>
    scopes.map((s) => refreshCookie(s, cookies.get(s)!)).join('; ');
  /** Refresh on `host`'s page and answer the minted token's claims, or fail naming the refusal. */
  const mintToken = async (host: string, cookie: string): Promise<{ accessToken: string; claims: Claims }> => {
    const res = await refreshFromPage(origin, host, cookie);
    const body = await res.json() as { access_token?: string; error_description?: string };
    assert.equal(res.status, 200, `the refresh on ${host} answered ${res.status}: ${body.error_description}`);
    return { accessToken: body.access_token!, claims: claimsOf(body.access_token!) };
  };
  const mint = async (host: string, cookie: string): Promise<Claims> => (await mintToken(host, cookie)).claims;
  /** The scopes this refresh's read markers name, found through its own completion line. */
  const readsOf = async (host: string, sub: string): Promise<string[]> => {
    const all = await waitForDebugLines(stack, (a) => a.some((l) => l.namespace === 'nebula-auth.worker.refresh'
      && l.message === 'minted' && l.data.host === host && l.data.sub === sub), `the refresh on ${host} minting ${sub}`);
    const done = [...all].reverse().find((l) => l.message === 'minted' && l.data.host === host && l.data.sub === sub)!;
    return all.filter((l) => l.namespace === 'nebula-auth.worker.refresh' && l.message === 'read'
      && l.data.operationId === done.data.operationId).map((l) => l.data.scope as string);
  };

  // ── The cast ──────────────────────────────────────────────────────────────────────────────────
  const owner = await provisionAndLogin({ baseUrl: origin, scope: galaxy, testToken });
  const atAcme = await refreshAccessToken(origin, owner.session, acme);
  for (const star of [t1, t2]) {
    assert.ok(await foundTenantStar({ baseUrl: origin, star, testToken }), `${star} could not be founded`);
  }

  const x = uniqueTestEmail();
  const xEvil = (await provisionAndLogin({ baseUrl: origin, scope: evil, email: x, testToken })).session.refreshToken;
  const xBrowser = new Browser();
  const xT1 = (await cookiesFrom(await inviteLink(atAcme, t1, x))).get(t1)!;
  await cookiesFrom(await inviteLink(atAcme, t2, x), xBrowser.fetch);

  const y = uniqueTestEmail();
  await cookiesFrom(await inviteLink(atAcme, acme, y, true));
  await cookiesFrom(await inviteLink(atAcme, galaxy, y, true));
  const yCookies = await cookiesFrom(await inviteLink(atAcme, t1, y));

  // ── LIMB 1: only cookies at or above the host are read ──────────────────────────────────────
  const xOnT1 = await mint(t1, [refreshCookie(evil, xEvil), refreshCookie(t1, xT1)].join('; '));
  assert.equal(xOnT1.access.authScope, t1, "X's plain membership at t1 must mint on its own host");
  if (observable) {
    assert.deepEqual(await readsOf(t1, xOnT1.sub), [t1], "a cookie for another universe must not be read on t1's host");
    console.error('  ✓ limb 1 — on t1\'s host only the t1 cookie was read');
  } else {
    console.error('[refresh-reads-the-host] limb 1: not observable on a deployed target');
  }

  // ── LIMB 2: the first admin candidate ends the read ────────────────────────────────────────
  const yOnT1Token = await mintToken(t1, header(yCookies, [acme, galaxy, t1]));
  const yOnT1 = yOnT1Token.claims;
  if (observable) {
    assert.deepEqual(await readsOf(t1, yOnT1.sub), [acme], 'the read must stop at the first admin candidate, the broadest');
    console.error('  ✓ limb 2 — the read stopped at acme, the first admin candidate');
  } else {
    console.error('[refresh-reads-the-host] limb 2: not observable on a deployed target');
  }

  // ── LIMB 3: the admin membership is picked, and its dominion holds on the page ─────────────
  assert.deepEqual(yOnT1.access, { authScope: acme, scopeAdmin: true },
    "Y's token on t1's host must rest on the admin membership at acme");
  const yDriver = await connectDriver(stack, { scope: t1, session: { accessToken: yOnT1Token.accessToken, sub: yOnT1.sub } });
  try {
    // `setStarConfig` is `@mesh()`-decorated with `requireDominionHere`, so it lands only under
    // dominion at t1: a plain member there is refused with "Admin access required". An invite would
    // not do — a plain member may invite peers into their own scope.
    await yDriver.client.lmz.callAsync('STAR', t1, yDriver.client.ctn<Star>().setStarConfig('refresh-reads-the-host', true));
  } finally {
    yDriver.dispose();
  }
  console.error("  ✓ limb 3 — Y's token on t1 rests on acme, and a dominion-gated call on t1 landed");

  // ── LIMB 4: the universe membership's sub on the universe's page and the galaxy's ──────────
  const yOnAcme = await mint(acme, header(yCookies, [acme, galaxy, t1]));
  const yOnGalaxy = await mint(galaxy, header(yCookies, [acme, galaxy, t1]));
  assert.equal(yOnGalaxy.sub, yOnAcme.sub, "the galaxy's page must carry the universe membership's sub");
  assert.equal(yOnGalaxy.access.authScope, acme, "the galaxy's page must rest on the universe membership");
  console.error('  ✓ limb 4 — one sub on the universe\'s page and the galaxy\'s');

  // ── LIMB 5: a cookie's name nominates it, and its record decides ───────────────────────────
  const forged = await refreshFromPage(origin, t1, refreshCookie(acme, xEvil));
  assert.equal(forged.status, 401, `a cookie named for acme but holding evil's record must not mint, got ${forged.status}`);
  assert.match(await forged.text(), /No refresh cookie covers this host/, "the refusal must be the refresh's own");
  const trueName = await mint(evil, refreshCookie(evil, xEvil));
  assert.equal(trueName.access.authScope, evil, 'the same value under its own name must mint on its own host');
  console.error("  ✓ limb 5 — evil's value named for acme was refused; under its own name it minted");

  // ── LIMB 6: only an accepted membership mints, on either arm ───────────────────────────────
  const p = uniqueTestEmail();
  await inviteLink(atAcme, acme, p, true); // never opened, so never accepted
  const pCookies = await cookiesFrom(await inviteLink(atAcme, t1, p));
  assert.ok(pCookies.get(acme), "P's consume must set the pending acme cookie beside t1's");
  const pOnT1 = await mint(t1, header(pCookies, [acme, t1]));
  assert.equal(pOnT1.access.authScope, t1, "P's pending admin membership must not mint; the accepted plain one must");
  assert.ok(!pOnT1.access.scopeAdmin, "P's token must carry no admin bit");

  const q = uniqueTestEmail();
  await inviteLink(atAcme, t1, q); // never opened
  const qWaiter = waitForEmail({ testToken, to: q, timeout: 120_000 });
  let qLink: string;
  try {
    await requestMagicLink({ baseUrl: origin, email: q });
    qLink = extractMagicLink(await qWaiter.emailPromise);
  } finally {
    qWaiter.cleanup();
  }
  const qT1 = (await cookiesFrom(qLink)).get(t1)!;
  const pending = await refreshFromPage(origin, t1, refreshCookie(t1, qT1));
  assert.equal(pending.status, 401, 'a membership nobody accepted must mint nothing');
  assert.match(await pending.text(), /membership_not_accepted/, 'the refusal must name the missing acceptance');
  await acceptMembership(origin, qT1, t1);
  assert.equal((await mint(t1, refreshCookie(t1, qT1))).access.authScope, t1, 'the same cookie must mint once accepted');
  console.error("  ✓ limb 6 — P's pending admin membership was passed over; Q minted only after accepting");

  // ── LIMB 7: a revoked membership's cookie is expired by the refresh that finds it gone ─────
  const ownerDriver = await connectDriver(stack, { scope: acme, session: atAcme });
  try {
    await ownerDriver.client.scopes.delete(t2);
  } finally {
    ownerDriver.dispose();
  }
  const name = refreshCookie(t2, '').slice(0, -1);
  assert.ok(xBrowser.getCookie(name), "X's browser must hold the t2 cookie before the deletion — the positive control");
  const gone = await xBrowser.context(scopeUrlOf(stack, t2)).fetch(`${origin}/auth/refresh-token`, { method: 'POST' });
  assert.equal(gone.status, 401, "a deleted membership's cookie must mint nothing");
  const expiry = setCookieHeaders(gone).find((c) => c.startsWith(`${name}=`));
  assert.ok(expiry && /Max-Age=0/.test(expiry) && /Secure/.test(expiry),
    `the refresh must expire the dead cookie, Secure included: ${expiry}`);
  assert.equal(xBrowser.getCookie(name), undefined, 'the browser must no longer hold the expired cookie');
  console.error("  ✓ limb 7 — the refresh expired the deleted membership's cookie, and the browser dropped it");
}
