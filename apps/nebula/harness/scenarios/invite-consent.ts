/**
 * **An invitation is an offer, not an enrolment.**
 *
 * Loading a link someone mailed you proves nothing and agrees to nothing: the link opens a page on
 * the platform host whose lookup writes no state, so a mail scanner, an `<img>` or a curious glance
 * enrols nobody. Signing in through a plain login link places the invitation's cookie but accepts
 * nothing either, so the invited scope refuses to mint until the invitee consents, on the invite's
 * own page or on Home, behind a card that names who sent it.
 *
 * ⚠️ **This is the scenario that reds on the ways the property can be lost**, and each has its own
 * limb below: a lookup that enrols, a connectable unaccepted destination (the card decorating a
 * session that already works), and an acceptance written by something other than an Accept.
 *
 * Limbs, each isolated with a positive control (`live.md` — per limb, never per scenario):
 *
 *  1. **Loading the invite's page enrols nothing.** Its lookup answers the pending invitation with
 *     the inviter's name, and the stored row stays unaccepted. *Reds against a lookup that accepts.*
 *  2. **PRE-ACCEPT: the row is unaccepted and the destination refuses to connect**, after a plain
 *     login placed the invitation's cookie. Both halves — the stored row and the running server's
 *     answer. *Reds against a plain consume that accepts, and separately against a cookie that is
 *     live before consent.*
 *  3. **Rendering the offer, then walking away, writes nothing.** *Reds against any read path that
 *     takes a membership up without an explicit Accept.*
 *  4. **Home's Accept enrols**, and the same cookie then mints for the invited scope. *Reds against
 *     a broken accept route — and is the positive control that makes limbs 2 and 3 meaningful
 *     rather than an assertion that nothing works.*
 *  5. **The invitation carries its inviter's stamp**, which is what the card renders as
 *     "{name} (supplied by the sender)". *Reds if the stamp is not written at invite time —
 *     without it the invitee would meet the SELF flavour ("Only accept if you initiated this
 *     signup") for something a third party initiated, which is the wrong warning entirely.*
 *
 * `needsContainer = false` — auth + the invite facade, never a build.
 */
import assert from 'node:assert/strict';
import { waitForEmail, uniqueTestEmail, extractMagicLink } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { readDevVar, inviteViaMesh } from '../lib/harness';
import {
  provisionAndLogin, refreshTokenForScope, setCookieHeaders, acceptMembership, consumeLink,
  refreshCookie, refreshFromPage, homeSummary, requestMagicLink,
} from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  // The run's shared app; the invitee is this scenario's own.
  const app = await sharedApp(stack, testToken);
  const galaxy = app.galaxy;
  const invitee = uniqueTestEmail();

  // The inviter is a REAL admin, the shared app's owner, signed in by email. Nothing seeded.
  const admin = await provisionAndLogin({
    baseUrl: origin, scope: galaxy, email: app.ownerEmail, testToken,
  });

  // The invite rides the ONE production surface — the mesh facade. There is no HTTP invite route.
  const waiter = waitForEmail({ testToken, instance: galaxy, to: invitee, timeout: 60_000 });
  let link: string;
  try {
    await inviteViaMesh(stack, admin, galaxy, [{ email: invitee }], 'Dana Okonkwo');
    link = extractMagicLink(await waiter.emailPromise); // an invite is a magic link like any other
  } finally {
    waiter.cleanup();
  }

  // ── LIMB 1: loading the invite's page enrols nothing ───────────────────────────────────────────
  const lookup = await fetch(`${new URL(link).origin}/auth/magic-link/lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ token: new URL(link).searchParams.get('token') }),
  });
  assert.equal(lookup.status, 200, `the invite page's lookup refused (${lookup.status})`);
  const offer = await lookup.json() as { pending?: { scope: string; invited: boolean; invitedByName?: string } };
  assert.equal(offer.pending?.scope, galaxy, 'the invite page must offer the invited membership');
  assert.equal(offer.pending?.invited, true, 'the invite page must say the membership came by invite');
  assert.equal(offer.pending?.invitedByName, 'Dana Okonkwo', 'the invite page must name its sender');
  console.error('  ✓ limb 1 — the invite page offers the membership and accepts nothing');

  // The invitee signs in through a plain login link instead of accepting: a cookie for every
  // membership the address holds, the invitation's included, and nothing accepted.
  const loginWaiter = waitForEmail({ testToken, to: invitee, timeout: 60_000 });
  let loginLink: string;
  try {
    await requestMagicLink({ baseUrl: origin, email: invitee });
    loginLink = extractMagicLink(await loginWaiter.emailPromise);
  } finally {
    loginWaiter.cleanup();
  }
  const signedIn = await consumeLink(loginLink);
  assert.equal(signedIn.status, 200, `the plain login's consume refused (${signedIn.status})`);
  const cookie = refreshTokenForScope(setCookieHeaders(signedIn), galaxy);
  assert.ok(cookie, `the plain login set no cookie for ${galaxy}`);
  const cookieHeader = refreshCookie(galaxy, cookie!);

  /** The consent card, read the way Home reads it — cookie-credentialed, no access token anywhere. */
  const consentCard = async (): Promise<{ accepted: boolean; invited?: boolean; invitedByName?: string }> => {
    const res = await fetch(`${origin}/auth/pending-membership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Cookie: cookieHeader },
      body: JSON.stringify({ scope: galaxy }),
    });
    assert.equal(res.status, 200, `pending-membership refused the invitee's own cookie (${res.status})`);
    return await res.json() as { accepted: boolean; invited?: boolean; invitedByName?: string };
  };

  /** The invited scope's answer to a page on its own host, as a status + body pair. */
  const mintAttempt = async (): Promise<{ status: number; body: string }> => {
    const res = await refreshFromPage(origin, galaxy, cookieHeader);
    return { status: res.status, body: await res.text() };
  };

  // ── LIMB 2: PRE-ACCEPT — the session is inert AND the row says so ──────────────────────────────
  // Both halves, because they can break apart: a session could be refused for a reason that has
  // nothing to do with acceptance, and a row could be flipped while the refusal persisted.
  const preAccept = await mintAttempt();
  assert.equal(preAccept.status, 401,
    'an unaccepted invite must mint NOTHING — otherwise the card decorates a session that already works');
  assert.match(preAccept.body, /membership_not_accepted/,
    'the refusal must name the reason, so a boundary refusal cannot be mistaken for this one');
  const cardBefore = await consentCard();
  assert.equal(cardBefore.accepted, false,
    'the ROW must be unaccepted, not merely the session refused — this is the half the 401 cannot prove');
  assert.equal(cardBefore.invited, true,
    'the card must say INVITED, or Home renders the self flavour ("only accept if you initiated this") ' +
    'for something a third party initiated');
  assert.equal(cardBefore.invitedByName, 'Dana Okonkwo',
    'the card the invitee actually meets renders its attribution from THIS read, pre-accept');
  console.error('  ✓ limb 2 — pre-accept: the scope refuses to connect, and the row is unaccepted');

  // ── LIMB 3: RENDERING THE OFFER, THEN WALKING AWAY, WRITES NOTHING ─────────────────────────────
  // Declining has no route (walking away is the whole point), so what makes the limb capable of
  // failing is the one thing the invitee's browser DOES do before walking: Home reads the consent
  // card to render it. That read is on the production path and must be a pure read.
  //
  // Isolating mutation: make `pending-membership` flip `acceptedAt`. Limb 2 stays green — it reads
  // the card only after its own 401 — and this limb reds, because the second read now reports
  // `accepted: true` and the refresh mints.
  await consentCard();   // the invitee opens Home, sees the offer…
  await consentCard();   // …and looks again, because a re-render is a re-read
  const cardAfter = await consentCard();
  assert.equal(cardAfter.accepted, false,
    'rendering the offer enrolled the invitee — a read path must never write acceptance');
  const afterDecline = await mintAttempt();
  assert.equal(afterDecline.status, 401,
    'declining must leave the membership untaken — nothing may enrol without an explicit Accept');
  console.error('  ✓ limb 3 — decline: rendering the offer three times wrote nothing');

  // ── LIMB 4: Home's ACCEPT enrols, and the SAME cookie then mints ───────────────────────────────
  await acceptMembership(origin, cookie!, galaxy);
  const postAccept = await refreshFromPage(origin, galaxy, cookieHeader);
  assert.equal(postAccept.status, 200,
    `the same cookie must mint once accepted (${postAccept.status}) — the positive control for limbs 2 and 3`);
  await postAccept.text();
  console.error('  ✓ limb 4 — accept: the same cookie mints for the invited scope');

  // ── LIMB 5: the invitation carries its inviter's stamp ─────────────────────────────────────────
  const home = await homeSummary(origin, cookieHeader);
  assert.equal(home.status, 200, `Home's summary refused the invitee (${home.status})`);
  const { groups } = await home.json() as { groups: { summary: { emails: { memberships: any[] }[] } }[] };
  const row = groups.flatMap((g) => g.summary.emails.flatMap((e) => e.memberships)).find((m) => m.scope === galaxy);
  assert.ok(row, 'the invited membership is missing from the invitee\'s own summary after accepting');
  assert.equal(row!.invitedByName, 'Dana Okonkwo',
    'the invitation must carry the inviter stamp the card renders as "(supplied by the sender)" — ' +
    'without it the invitee meets the SELF flavour for something a third party initiated');
  console.error('  ✓ limb 5 — the inviter stamp survives to the summary Home renders from');

  console.error('  ── an invitation is an offer: a page that changes nothing, then consent');
}
