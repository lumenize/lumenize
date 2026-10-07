/**
 * **A persona's host mints the persona's token for an admin of its `dev` Star, and for nobody else.**
 *
 * Studio frames `manny--dev.crm.{u}.lumenize.dev` to show the app as Manny sees it. The page's
 * refresh answers with Manny's own plain token when the browser holds a cookie whose ACCEPTED
 * membership has dominion over the `.dev` Star, judged from the cookie's record and never its name.
 * Manny's `sub` and `profileId` are one version-5 UUID of `{u}.crm.dev/manny`, so every refresh
 * derives the same id and nothing stores it.
 *
 * The cast: **O** owns `{u}` and its app `crm`. **C** is invited into the app as an admin, which
 * co-mints a `.dev` admin membership, and accepts. **P** is invited into the `.dev` Star as a plain
 * member. **N** is invited into the app as an admin and signs in through a plain link without
 * accepting. **E** owns an unrelated universe.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **An admin of the `dev` Star gets Manny's token.** O's cookie mints a plain token on Manny's
 *     host — no `act`, no `scopeAdmin`, `authScope` and `aud` both the `.dev` Star — and C's does
 *     too. *Reds if the host is treated as its Star: the page gets its opener's own token.*
 *  2. **Nobody else gets Manny, each refused by the refresh's own 401.** P, a plain member; N,
 *     whose admin membership is unaccepted; and O on `manny--staging`. *Reds, one per limb, if the
 *     persona falls through to the ordinary pick, the accepted conjunct goes, or the `dev` check
 *     goes.* Positive control: N, after Accept, gets Manny's token.
 *  3. **The refresh records its opener.** The persona's line, read by the refresh's id, names
 *     both O's `sub` and Manny's. *Reds if the record is dropped.*
 *  4. **The cookie's record decides, not its name.** E's own refresh value, sent under O's
 *     universe's cookie name, gets 401. *Reds if the name decides — Manny's token is minted.*
 *  5. **Manny's id is a name-based GUID no person's can equal.** It is the `sub` and the
 *     `profileId`, carries version 5, and is the same from O's browser and C's. Positive control:
 *     Manny's tab opens a socket and makes a call, so the `.dev` Star accepts the id.
 *
 * Limb 3 reads the stack's stdio, which a deployed target does not capture; it says so there.
 *
 * `needsContainer = false` — auth, the refresh and one Star only.
 */
import assert from 'node:assert/strict';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import type { Star } from '@lumenize/nebula';
import type { DevStack } from '../lib/harness';
import { connectDriver, inviteViaMesh, readDevVar, scopeUrlOf, waitForHost } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { waitForDebugLines } from '../lib/stdio';
import {
  provisionAndLogin, consumeLink, setCookieHeaders, refreshTokenForScope, refreshCookie, refreshAccessToken,
  acceptMembership, requestMagicLink, scopeOriginFrom,
} from '../../test/lib/email-login';

export const needsContainer = false;
export const bootVars = { DEBUG: 'nebula-auth.worker.refresh' };

type Claims = { sub: string; profileId: string; aud: string; act?: unknown; access: { authScope: string; scopeAdmin?: boolean } };
const claimsOf = (token: string) => parseJwtUnsafe(token)!.payload as unknown as Claims;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const observable = stack.logs !== undefined;
  const universe = testSlug('ph');
  const galaxy = `${universe}.crm`;
  const dev = `${galaxy}.dev`;
  const devOrigin = scopeOriginFrom(origin, dev);
  /** A persona's host in `star`'s slot: `manny--dev.crm.{u}.lumenize.localhost`. */
  const personaOrigin = (persona: string, starSlug: string) => devOrigin.replace('//dev.', `//${persona}--${starSlug}.`);
  const manny = personaOrigin('manny', 'dev');

  /** The refresh a page on `pageOrigin` sends, with `cookie`. */
  const refreshOn = (pageOrigin: string, cookie: string) => fetch(`${origin}/auth/refresh-token`, {
    method: 'POST', headers: { Origin: pageOrigin, Cookie: cookie, 'Sec-Fetch-Site': 'same-site' },
  });
  const mannyFrom = async (cookie: string, who: string): Promise<{ accessToken: string; claims: Claims }> => {
    const res = await refreshOn(manny, cookie);
    const body = await res.json() as { access_token?: string; error_description?: string };
    assert.equal(res.status, 200, `${who}'s refresh on Manny's host answered ${res.status}: ${body.error_description}`);
    return { accessToken: body.access_token!, claims: claimsOf(body.access_token!) };
  };
  const refusedOn = async (pageOrigin: string, cookie: string, who: string) => {
    const res = await refreshOn(pageOrigin, cookie);
    // Never the body itself: a refusal that failed carries a token, which no log may hold.
    const body = await res.json().catch(() => ({})) as { error?: string; access_token?: string };
    const said = body.access_token ? 'a token' : body.error ?? '(no error code)';
    assert.equal(res.status, 401, `${who} must be refused on ${new URL(pageOrigin).hostname}, got ${res.status}: ${said}`);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), pageOrigin, `${who}'s refusal must be the refresh's own, with its CORS`);
  };
  /** The link an invite mails, armed before the send and filtered by its unique recipient. */
  const inviteLink = async (admin: { accessToken: string; sub: string }, scope: string, email: string, scopeAdmin: boolean) => {
    // Before the waiter is armed: on a deployed target this app's host answers only once its certificate
    // is issued, which can outlast the waiter, and the invite dials it.
    await waitForHost(scopeUrlOf(stack, (parseJwtUnsafe(admin.accessToken)!.payload as { aud: string }).aud));
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
  /** Press a link's Accept and come back with the refresh cookies it set for `scopes`, as a header. */
  const acceptedCookies = async (link: string, scopes: string[]) => {
    const set = setCookieHeaders(await consumeLink(link, fetch, { nickname: 'Ph' }));
    const pairs = scopes.flatMap((scope) => {
      const token = refreshTokenForScope(set, scope);
      return token ? [refreshCookie(scope, token)] : [];
    });
    assert.ok(pairs.length > 0, `the Accept set no cookie for ${scopes.join(' or ')}`);
    return pairs.join('; ');
  };

  // ── The cast ──────────────────────────────────────────────────────────────────────────────
  const owner = await provisionAndLogin({ baseUrl: origin, scope: galaxy, testToken });
  const ownerCookie = refreshCookie(owner.session.authScope, owner.session.refreshToken);
  const atGalaxy = await refreshAccessToken(origin, owner.session, galaxy);
  const c = uniqueTestEmail();
  const cCookie = await acceptedCookies(await inviteLink(atGalaxy, galaxy, c, true), [galaxy, dev]);
  const p = uniqueTestEmail();
  const atDev = await refreshAccessToken(origin, owner.session, dev);
  const pCookie = await acceptedCookies(await inviteLink(atDev, dev, p, false), [dev]);

  // ── LIMB 1: an admin of the dev Star gets Manny's token ──────────────────────────────────
  const fromO = await mannyFrom(ownerCookie, 'O');
  assert.equal(fromO.claims.act, undefined, "Manny's token carries no act chain");
  assert.deepEqual(fromO.claims.access, { authScope: dev }, "Manny's token is a plain membership at the .dev Star");
  assert.equal(fromO.claims.aud, dev, "Manny's token is for the .dev Star's host");
  assert.notEqual(fromO.claims.sub, owner.sub, "the page must get Manny, not its opener");
  const fromC = await mannyFrom(cCookie, 'C');
  console.error("  ✓ limb 1 — O's universe cookie and C's galaxy-admin cookie each got Manny's plain token");

  // ── LIMB 2: nobody else gets Manny, each refused by the refresh's own 401 ─────────────────
  await refusedOn(manny, pCookie, 'P, a plain member of the .dev Star');
  const n = uniqueTestEmail();
  await inviteLink(atGalaxy, galaxy, n, true); // never opened: N signs in through a plain link instead
  const nWaiter = waitForEmail({ testToken, to: n, timeout: 120_000 });
  let nLogin: string;
  try {
    await requestMagicLink({ baseUrl: origin, email: n });
    nLogin = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec((await nWaiter.emailPromise).html ?? '')![1]!.replace(/&amp;/g, '&');
  } finally {
    nWaiter.cleanup();
  }
  const nDevToken = refreshTokenForScope(setCookieHeaders(await consumeLink(nLogin)), dev);
  assert.ok(nDevToken, "N's plain login must set the .dev cookie, pending");
  await refusedOn(manny, refreshCookie(dev, nDevToken!), 'N, whose admin membership is unaccepted');
  await refusedOn(personaOrigin('manny', 'staging'), ownerCookie, 'O on a staging persona');
  await acceptMembership(origin, nDevToken!, dev);
  await mannyFrom(refreshCookie(dev, nDevToken!), 'N after Accept'); // the positive control
  console.error('  ✓ limb 2 — P, unaccepted N and the staging persona were refused; N got Manny once accepted');

  // ── LIMB 3: the refresh records its opener ─────────────────────────────────────────────
  if (observable) {
    const isRecord = (x: { namespace: string; message: string; data: Record<string, unknown> }) =>
      x.namespace === 'nebula-auth.worker.refresh.persona' && x.message === 'persona minted'
      && x.data.sub === fromO.claims.sub && (x.data.opener as { sub?: string } | undefined)?.sub === owner.sub;
    const lines = await waitForDebugLines(stack, (all) => all.some(isRecord), "the persona refresh's opener record");
    const record = lines.find(isRecord)!;
    assert.deepEqual(record.data.opener, { sub: owner.sub, profileId: claimsOf(atGalaxy.accessToken).profileId, scope: universe, scopeAdmin: true },
      'the record names the opener from its cookie record');
    assert.equal(record.data.star, dev);
    assert.equal(record.data.actingToken, undefined, 'a persona refresh records no acting token');
    console.error("  ✓ limb 3 — the refresh's record named O as the opener beside Manny");
  } else {
    console.error('[persona-host] limb 3: not observable on a deployed target');
  }

  // ── LIMB 4: the cookie's record decides, not its name ───────────────────────────────────
  const evil = await provisionAndLogin({ baseUrl: origin, scope: testSlug('phe'), testToken });
  await refusedOn(manny, refreshCookie(universe, evil.session.refreshToken), "E's value under O's cookie name");
  console.error("  ✓ limb 4 — E's refresh value under O's universe cookie name minted nothing");

  // ── LIMB 5: Manny's id is a name-based GUID no person's can equal ─────────────────────────
  assert.equal(fromO.claims.sub, fromO.claims.profileId, "Manny's sub and profileId are one value");
  assert.equal(fromO.claims.sub[14], '5', "Manny's id carries version 5");
  assert.equal(fromC.claims.sub, fromO.claims.sub, "two browsers' refreshes derive the same id");
  const tab = await connectDriver(stack, { scope: dev, session: { accessToken: fromO.accessToken, sub: fromO.claims.sub } });
  try {
    const tree = await tab.client.lmz.callAsync('STAR', dev, tab.client.ctn<Star>().resources.orgTree.getState());
    assert.ok(tree, "Manny's tab must reach its Star");
  } finally {
    tab.dispose();
  }
  console.error("  ✓ limb 5 — Manny's id is version 5, the same from two openers, and his tab connected and called");
}
