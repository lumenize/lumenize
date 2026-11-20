/**
 * **A persona is a real member of its dev Star: invited at the address its host spells, accepted by
 * the Worker's own mail handler, and opened by an admin through the impersonation mint.**
 *
 * Studio frames `gerry--dev.crm.{u}.lumenize.dev` to show the app as Gerry sees it. That host spells
 * an address, `gerry--dev.crm.{u}@{the persona mail domain}`, and whoever holds an accepted
 * membership under it at the dev Star is Gerry. Nobody sits behind the address, so the Worker's
 * `email` handler accepts his invite from the message it arrives in. Then the page's refresh mints
 * for that member through the impersonation mint, with the browser's admin as the opener.
 *
 * Mail reaches the handler as each venue delivers it: Cloudflare's routing on the deployed target,
 * and the local stack's own relay locally, which hands the handler the message as it arrived
 * (`scripts/persona-mail-relay.mjs`). The scenario does nothing about delivery in either.
 *
 * The cast: **O** owns `{u}` and its app `crm`. **P** is invited into the dev Star as a plain
 * member and accepts as a person does. **Gerry** and **Sally** are personas.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **Gerry's invite is accepted by mail, with nobody clicking.** Before the invite his host
 *     answers 401. O invites his address into the dev Star, and his host then opens. *Reds if the
 *     handler accepts nothing, or the address the page spells is not the one the host derives.*
 *  2. **The token is Gerry's own, with O in `act`.** Its `sub` is the membership the invite
 *     minted, it carries no admin bit though O's does, and Gerry's tab connects and calls his Star.
 *     *Reds if the refresh mints for its opener, or copies the opener's bit.*
 *  3. **A plain member of the Star cannot open Gerry's page,** refused in the impersonation mint's
 *     own words. Positive control: P's cookie opens the dev Star's own page. *Reds if any member
 *     may open a persona.*
 *  4. **A login link sent to a persona's address signs nobody in and accepts nothing.** It is
 *     mailed to Sally's address while nobody holds it; the handler logs that it dropped it, and
 *     her host still answers 401. *Reds if the handler accepts by any link it is sent.*
 *  5. **An invite into the app, sent to a persona's address, is refused, and leaves nothing
 *     behind.** It would mint a pending admin membership of the dev Star for that address, which
 *     the workspace's own plain invite would then take up, since an invite never lowers a bit.
 *     The invite is answered with an error for Sally and no membership; her host answers 401; and
 *     once the workspace invites her, her token is a plain member's. *Reds if the app invite is
 *     let through: Sally's token then carries an admin bit nobody chose.*
 *  6. **The cookie's record decides, not its name.** E's own refresh value, sent under O's
 *     universe's cookie name, gets 401 on Gerry's host.
 *  7. **Gerry's host keeps a session of its own, and a later refresh asks the Registry nothing.**
 *     A refresh with O's cookie alone sets a cookie named as the host spells Gerry, a day long.
 *     Sent back beside O's, it gets Gerry's token again and no new cookie, and the Worker logs
 *     that it read a held session and missed Workers KV for nothing. *Reds if the refresh opens a
 *     session every time.*
 *
 * Limbs 4, 5 and 7 read the Worker's logs, in both venues.
 *
 * `needsContainer = false` — auth, the mail handler, the refresh and one Star only.
 */
import assert from 'node:assert/strict';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import { personaAddress } from '@lumenize/mesh/client';
import type { Star } from '@lumenize/nebula';
import type { DevStack } from '../lib/harness';
import { connectDriver, inviteViaMesh, readDevVar, scopeUrlOf, waitForHost } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { loggedAfter, waitForDebugLines } from '../lib/stdio';
import type { DebugLine } from '../lib/stdio';
import {
  provisionAndLogin, consumeLink, setCookieHeaders, refreshTokenForScope, refreshCookie, refreshAccessToken,
  requestMagicLink, scopeOriginFrom,
} from '../../test/lib/email-login';

export const needsContainer = false;
export const bootVars = { DEBUG: 'nebula-auth.worker.refresh,nebula-auth.worker.personaMail' };

type Claims = {
  sub: string; profileId: string; aud: string; act?: { sub: string; profileId: string };
  access: { authScope: string; scopeAdmin?: boolean };
};
const claimsOf = (token: string) => parseJwtUnsafe(token)!.payload as unknown as Claims;

/** How long a persona's host may take to open after its invite: the mail's round trip. */
const ACCEPT_BY_MAIL_MS = 90_000;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const universe = testSlug('ph');
  const galaxy = `${universe}.crm`;
  const dev = `${galaxy}.dev`;
  const devOrigin = scopeOriginFrom(origin, dev);
  /** A persona's host: `gerry--dev.crm.{u}.lumenize.localhost`. */
  const hostOf = (persona: string) => devOrigin.replace('//dev.', `//${persona}--dev.`);
  /** A persona's address, as a page on this deployment spells it. */
  const addressOf = (persona: string) => personaAddress({ persona, scope: dev }, stack.personaMailDomain);

  /** The refresh a page on `pageOrigin` sends, with `cookie`. */
  const refreshOn = (pageOrigin: string, cookie: string) => fetch(`${origin}/auth/refresh-token`, {
    method: 'POST', headers: { Origin: pageOrigin, Cookie: cookie, 'Sec-Fetch-Site': 'same-site' },
  });
  const refused = async (pageOrigin: string, cookie: string, who: string): Promise<string> => {
    const res = await refreshOn(pageOrigin, cookie);
    // Never the body itself: a refusal that failed carries a token, which no log may hold.
    const body = await res.json().catch(() => ({})) as { error?: string; error_description?: string; access_token?: string };
    const said = body.access_token ? 'a token' : body.error ?? '(no error code)';
    assert.equal(res.status, 401, `${who} must be refused on ${new URL(pageOrigin).hostname}, got ${res.status}: ${said}`);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), pageOrigin, `${who}'s refusal must be the refresh's own, with its CORS`);
    return body.error_description ?? '';
  };
  /** Ask `pageOrigin` for its token until it opens, which a persona's does once its mail is accepted. */
  const opens = async (pageOrigin: string, cookie: string, who: string): Promise<{ accessToken: string; claims: Claims }> => {
    const deadline = Date.now() + ACCEPT_BY_MAIL_MS;
    for (;;) {
      const res = await refreshOn(pageOrigin, cookie);
      if (res.status === 200) {
        const { access_token } = await res.json() as { access_token: string };
        return { accessToken: access_token, claims: claimsOf(access_token) };
      }
      await res.body?.cancel();
      assert.ok(Date.now() < deadline, `${who}'s host never opened: its invite was not accepted within ${ACCEPT_BY_MAIL_MS / 1000} s`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  /** Invite `email` into `scope` as `admin`, and answer the membership it minted. */
  const invite = async (admin: { accessToken: string; sub: string }, scope: string, email: string) => {
    const summary = await inviteViaMesh(stack, admin, scope, [{ email }]);
    assert.equal(summary.errors.length, 0, `the invite into ${scope} failed: ${JSON.stringify(summary.errors)}`);
    return summary.results[0]!.sub;
  };
  /** The handler's line saying it dropped a message for `to`, logged after `after`. */
  const droppedLine = (to: string, after?: DebugLine) => waitForDebugLines(
    stack,
    (all) => all.some((x) => x.namespace === 'nebula-auth.worker.personaMail' && x.message === 'dropped'
      && x.data.to === to && (!after || loggedAfter(x, after))),
    `the mail handler's drop for ${to}`,
  ).then((all) => all.filter((x) => x.namespace === 'nebula-auth.worker.personaMail' && x.message === 'dropped' && x.data.to === to).at(-1)!);

  // ── The cast ──────────────────────────────────────────────────────────────────────────────
  const owner = await provisionAndLogin({ baseUrl: origin, scope: galaxy, testToken });
  const ownerCookie = refreshCookie(owner.session.authScope, owner.session.refreshToken);
  await waitForHost(scopeUrlOf(stack, dev));
  const atDev = await refreshAccessToken(origin, owner.session, dev);
  const atGalaxy = await refreshAccessToken(origin, owner.session, galaxy);
  const gerry = await addressOf('gerry');
  const sally = await addressOf('sally');

  // ── LIMB 1: Gerry's invite is accepted by mail, with nobody clicking ───────────────────────
  assert.equal(await refused(hostOf('gerry'), ownerCookie, 'O, before Gerry is invited'),
    "No member of this Star holds this persona's address yet");
  const gerrySub = await invite(atDev, dev, gerry);
  const fromO = await opens(hostOf('gerry'), ownerCookie, 'Gerry');
  console.error("  ✓ limb 1 — Gerry's invite was accepted by the Worker's mail handler, and his host opened");

  // ── LIMB 2: the token is Gerry's own, with O in act ─────────────────────────────────────
  assert.equal(fromO.claims.sub, gerrySub, "the token's subject is the membership the invite minted");
  assert.notEqual(fromO.claims.sub, owner.sub, 'the page must get Gerry, not its opener');
  assert.deepEqual(fromO.claims.act, { sub: owner.sub, profileId: claimsOf(atDev.accessToken).profileId },
    'the opener is recorded in act');
  assert.deepEqual(fromO.claims.access, { authScope: dev }, "Gerry's own membership is a plain one, though O's is an admin's");
  assert.equal(fromO.claims.aud, dev, "Gerry's token is for the dev Star's host");
  const tab = await connectDriver(stack, { scope: dev, session: { accessToken: fromO.accessToken, sub: fromO.claims.sub } });
  try {
    const tree = await tab.client.lmz.callAsync('STAR', dev, tab.client.ctn<Star>().resources.orgTree.getState());
    assert.ok(tree, "Gerry's tab must reach his Star");
  } finally {
    tab.dispose();
  }
  console.error("  ✓ limb 2 — the token is Gerry's own membership, plain, with O in act, and his tab connected and called");

  // ── LIMB 3: a plain member of the Star cannot open Gerry's page ──────────────────────────
  const p = uniqueTestEmail();
  const pWaiter = waitForEmail({ testToken, to: p, timeout: 120_000 });
  let pCookie: string;
  try {
    await invite(atDev, dev, p);
    const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec((await pWaiter.emailPromise).html ?? '')?.[1];
    assert.ok(href, "P's invite carried no link");
    const token = refreshTokenForScope(setCookieHeaders(await consumeLink(href.replace(/&amp;/g, '&'), fetch, { nickname: 'Pat' })), dev);
    assert.ok(token, "P's Accept set no cookie for the dev Star");
    pCookie = refreshCookie(dev, token);
  } finally {
    pWaiter.cleanup();
  }
  assert.equal((await refreshOn(devOrigin, pCookie)).status, 200, "the control: P's cookie opens the dev Star's own page");
  assert.equal(await refused(hostOf('gerry'), pCookie, 'P, a plain member of the dev Star'),
    `The calling host's scope "${dev}" does not administer this subject`);
  console.error("  ✓ limb 3 — P opens the dev Star's page, and is refused Gerry's by the impersonation mint");

  // ── LIMB 5, first half: an invite into the app, sent to a persona's address, is refused ───
  const misdirected = await inviteViaMesh(stack, atGalaxy, galaxy, [{ email: sally }]);
  assert.deepEqual(misdirected.results, [], "an app invite must not land for a persona's address");
  assert.deepEqual(misdirected.errors,
    [{ email: sally, error: `"${sally}" is a persona's address, and a persona is invited only into the workspace its address names` }]);
  assert.equal(await refused(hostOf('sally'), ownerCookie, 'O, on Sally, whose only invite was refused'),
    "No member of this Star holds this persona's address yet");

  // ── LIMB 4: a login link sent to a persona's address accepts nothing ──────────────────────
  await requestMagicLink({ baseUrl: origin, email: sally });
  const loginDropped = await droppedLine(sally);
  assert.equal(loginDropped.data.reason, "the link is no invite into this persona's Star");
  await refused(hostOf('sally'), ownerCookie, 'O, on Sally, after a login link was mailed to her');
  console.error("  ✓ limb 4 — a login link mailed to Sally's address was dropped, and her host stayed shut");

  // ── LIMB 5, second half: the workspace's own invite then makes her a plain member ─────────
  // Had the app invite landed, it would have left a pending admin membership here for this
  // invite to take up.
  await invite(atDev, dev, sally);
  const asSally = await opens(hostOf('sally'), ownerCookie, 'Sally');
  assert.deepEqual(asSally.claims.access, { authScope: dev }, "Sally must be a plain member: no earlier invite left her an admin bit");
  console.error("  ✓ limb 5 — an invite into the app for Sally's address was refused and left nothing, so the workspace's own made her a plain member");

  // ── LIMB 6: the cookie's record decides, not its name ───────────────────────────────────
  const evil = await provisionAndLogin({ baseUrl: origin, scope: testSlug('phe'), testToken });
  await refused(hostOf('gerry'), refreshCookie(universe, evil.session.refreshToken), "E's value under O's cookie name");
  console.error("  ✓ limb 6 — E's refresh value under O's universe cookie name minted nothing");

  // ── LIMB 7: Gerry's host keeps a session of its own ─────────────────────────────────────
  const opening = await refreshOn(hostOf('gerry'), ownerCookie);
  assert.equal(opening.status, 200, "Gerry's host must open for O");
  const sessionName = `__Host-refresh-token.${galaxy}.gerry--dev`;
  const set = setCookieHeaders(opening).find((h) => h.startsWith(`${sessionName}=`));
  assert.ok(set, `the first refresh must set Gerry's own cookie, ${sessionName}`);
  assert.match(set, /; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400$/, "Gerry's cookie is the platform host's alone and lasts a day");
  const later = await refreshOn(hostOf('gerry'), `${ownerCookie}; ${set.split(';')[0]}`);
  assert.equal(later.status, 200, "Gerry's host must open again for O with Gerry's session");
  assert.deepEqual(setCookieHeaders(later).filter((h) => h.startsWith(sessionName)), [], 'a refresh that reads a held session sets no new one');
  const again = claimsOf((await later.json() as { access_token: string }).access_token);
  assert.deepEqual([again.sub, again.act, again.access, again.aud], [gerrySub, fromO.claims.act, fromO.claims.access, dev],
    "the held session mints the same token: Gerry's own, with O in act");
  // The refresh's own lines: which path it took, and whether it reached past Workers KV.
  const isHeld = (l: DebugLine) => l.namespace === 'nebula-auth.worker.refresh' && l.message === 'minted'
    && l.data.host === dev && l.data.persona === 'gerry' && l.data.session === 'held';
  const lines = await waitForDebugLines(stack, (all) => all.some(isHeld), "the refresh that read Gerry's held session");
  const held = lines.filter(isHeld);
  assert.equal(held.length, 1, 'exactly one refresh in this run read a held session');
  const misses = lines.filter((l) => l.namespace === 'nebula-auth.worker.refresh' && l.message === 'kv miss'
    && l.data.operationId === held[0]!.data.operationId);
  assert.deepEqual(misses, [], 'the refresh that read the held session missed Workers KV for nothing, so it asked the Registry nothing');
  console.error("  ✓ limb 7 — Gerry's host set a day-long cookie of his own, and the next refresh read it from Workers KV alone");
}
