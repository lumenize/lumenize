/**
 * **An invitation is an offer, not an enrolment.**
 *
 * Clicking a link someone mailed you proves you can read that mailbox. It does not agree to
 * anything — and before this design it effectively did: the click minted a session and dropped you
 * inside the scope, so a curiosity-click on an unsolicited invite handed a stranger a live
 * membership and, with it, whatever the scope's tree exposes. Now the click proves the address and
 * lands on Home, where the invitation waits behind a modal that names who sent it.
 *
 * ⚠️ **This is the scenario that reds on the three ways the property can be lost**, and each has
 * its own limb below: a direct-landing 302 (skipping Home), a connectable unaccepted destination
 * (the modal decorating a session that already works), and a modal bypass (acceptance written by
 * something other than the accept endpoint).
 *
 * Limbs, each isolated with a positive control (`live.md` — per limb, never per scenario):
 *
 *  1. **The click lands on HOME, not in the invited scope.** *Reds against a direct-landing 302.*
 *  2. **PRE-ACCEPT: `acceptedAt` is NULL and the destination refuses to connect.** Both halves —
 *     the stored row and the running server's answer. *Reds against a consume-time acceptance flip,
 *     and separately against a cookie that is live before consent.*
 *  3. **DECLINE writes nothing.** Walking away leaves the row exactly as it was. *Reds against any
 *     path that takes a membership up without an explicit Accept.*
 *  4. **ACCEPT is what enrols**, and the same cookie then mints for the invited scope. *Reds
 *     against a broken accept endpoint — and is the positive control that makes limbs 2 and 3
 *     meaningful rather than an assertion that nothing works.*
 *  5. **The invitation carries its inviter's stamp**, which is what the modal renders as
 *     "{name} (supplied by the sender)". *Reds if the stamp is not written at invite time —
 *     without it the invitee would meet the SELF flavour ("Only accept if you initiated this
 *     signup") for something a third party initiated, which is the wrong warning entirely.*
 *
 * `needsContainer = false` — auth + the invite facade, never a build.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { readDevVar, inviteViaMesh } from '../lib/harness';
import {
  provisionAndLogin, refreshTokenForScope, setCookieHeaders, acceptMembership,
} from '../../test/lib/email-login';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const suffix = crypto.randomUUID().slice(0, 8);
  const universe = `inv-c-${suffix}`;
  const galaxy = `${universe}.app`;
  const invitee = uniqueTestEmail();

  // The inviter is a REAL admin: claimed, mailed, clicked, accepted. Nothing seeded.
  const admin = await provisionAndLogin({
    baseUrl: origin, scope: galaxy, email: uniqueTestEmail(), testToken,
  });

  // The invite rides the ONE production surface — the mesh facade. There is no HTTP invite route.
  const waiter = waitForEmail({ testToken, instance: galaxy, to: invitee, timeout: 60_000 });
  let link: string;
  try {
    await inviteViaMesh(stack, admin, galaxy, [{ email: invitee }], 'Dana Okonkwo');
    // ⚠️ An invite letter carries an `accept-invite` link, not a magic link — `extractMagicLink`
    // matches only the latter and dies with "No magic link found" on a letter that arrived perfectly.
    const html = (await waiter.emailPromise).html ?? '';
    const href = /href="([^"]*accept-invite[^"]*invite_token[^"]*)"/.exec(html)?.[1];
    assert.ok(href, `the invite email carried no accept-invite link (starts: ${html.slice(0, 80)})`);
    link = href!;
  } finally {
    waiter.cleanup();
  }

  // ── LIMB 1: the click lands on HOME ────────────────────────────────────────────────────────────
  const clicked = await fetch(link, { redirect: 'manual' });
  assert.equal(clicked.status, 302, `the invite click did not redirect (${clicked.status})`);
  const landing = clicked.headers.get('Location') ?? '';
  assert.match(landing, /^\/auth\/[^/]+\/home$/,
    `an invite click must land on Home to be consented to; landed on "${landing}"`);
  console.error(`  ✓ limb 1 — the invite click landed on ${landing}, not inside ${galaxy}`);

  const cookie = refreshTokenForScope(setCookieHeaders(clicked), galaxy);
  assert.ok(cookie, `the invite click set no cookie for ${galaxy}`);

  /** The stored acceptance for the invitee at the invited scope, read through a real admin token. */
  const invitedRow = async (): Promise<{ accepted?: boolean; invitedByName?: string } | undefined> => {
    const res = await fetch(`${origin}/auth/scope-summary`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${inviteeToken()}`, 'Content-Type': 'application/json' },
    });
    if (res.status !== 200) return undefined;
    const s = await res.json() as { emails: { memberships: any[] }[] };
    return s.emails.flatMap((e) => e.memberships).find((m) => m.scope === galaxy);
  };
  // The invitee cannot read their own summary before accepting (their only cookie is inert), so the
  // pre-accept row is read the only way it can be: through the running server's refusal, below.
  let inviteeAccess = '';
  function inviteeToken(): string { return inviteeAccess; }

  /** The consent card, read the way Home reads it — cookie-credentialed, no access token anywhere. */
  const consentCard = async (): Promise<{ accepted: boolean; invited?: boolean; invitedByName?: string }> => {
    const res = await fetch(`${origin}/auth/${galaxy}/pending-membership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `refresh-token=${cookie}` },
    });
    assert.equal(res.status, 200, `pending-membership refused the invitee's own cookie (${res.status})`);
    return await res.json() as { accepted: boolean; invited?: boolean; invitedByName?: string };
  };

  /** The invited scope's refusal to mint, as a status + reason pair. */
  const mintAttempt = async (): Promise<{ status: number; body: string }> => {
    const res = await fetch(`${origin}/auth/${galaxy}/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `refresh-token=${cookie}` },
      body: JSON.stringify({ activeScope: galaxy }),
    });
    return { status: res.status, body: await res.text() };
  };

  // ── LIMB 2: PRE-ACCEPT — the session is inert AND the row says so ──────────────────────────────
  // Both halves, because they can break apart: a session could be refused for a reason that has
  // nothing to do with acceptance, and a row could be flipped while the refusal persisted.
  const preAccept = await mintAttempt();
  assert.equal(preAccept.status, 401,
    'an unaccepted invite must mint NOTHING — otherwise the modal decorates a session that already works');
  assert.match(preAccept.body, /membership_not_accepted/,
    'the refusal must name the reason, so a boundary refusal cannot be mistaken for this one');
  const cardBefore = await consentCard();
  assert.equal(cardBefore.accepted, false,
    'the ROW must be unaccepted, not merely the session refused — this is the half the 401 cannot prove');
  assert.equal(cardBefore.invited, true,
    'the card must say INVITED, or Home renders the self flavour ("only accept if you initiated this") ' +
    'for something a third party initiated');
  assert.equal(cardBefore.invitedByName, 'Dana Okonkwo',
    'the modal the invitee actually meets renders its attribution from THIS card, pre-accept');
  console.error('  ✓ limb 2 — pre-accept: the scope refuses to connect, and the row is unaccepted');

  // ── LIMB 3: RENDERING THE OFFER, THEN WALKING AWAY, WRITES NOTHING ─────────────────────────────
  // 🚨 **This limb used to re-send limb 2's exact request with nothing in between, so it could not
  // fail on its own** — any mutation that reddened it reddened limb 2 first. Declining has no
  // endpoint (walking away is the whole point), so what makes the limb capable of failing is the
  // one thing the invitee's browser DOES do before walking: Home fetches the consent card to render
  // the modal. That read is on the production path and must be a pure read.
  //
  // Isolating mutation: make `pending-membership` flip `acceptedAt` (or let any read path enrol).
  // Limb 2 stays green — it reads the card only after its own 401 — and this limb reds, because the
  // second read now reports `accepted: true` and the mint succeeds. That is the scanner-shaped hole
  // the always-modal design exists to close: a fetch must never be able to enrol anybody.
  await consentCard();   // the invitee opens Home, sees the offer…
  await consentCard();   // …and looks again, because a re-render is a re-read
  const cardAfter = await consentCard();
  assert.equal(cardAfter.accepted, false,
    'rendering the offer enrolled the invitee — a read path must never write acceptance');
  const afterDecline = await mintAttempt();
  assert.equal(afterDecline.status, 401,
    'declining must leave the membership untaken — nothing may enrol without an explicit Accept');
  console.error('  ✓ limb 3 — decline: rendering the offer three times wrote nothing');

  // ── LIMB 4: ACCEPT enrols, and the SAME cookie then mints ──────────────────────────────────────
  await acceptMembership(origin, cookie!, galaxy);
  const postAccept = await fetch(`${origin}/auth/${galaxy}/refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `refresh-token=${cookie}` },
    body: JSON.stringify({ activeScope: galaxy }),
  });
  assert.equal(postAccept.status, 200,
    `the same cookie must mint once accepted (${postAccept.status}) — the positive control for limbs 2 and 3`);
  inviteeAccess = (await postAccept.json() as { access_token: string }).access_token;
  console.error('  ✓ limb 4 — accept: the same cookie mints for the invited scope');

  // ── LIMB 5: the invitation carries its inviter's stamp ─────────────────────────────────────────
  const row = await invitedRow();
  assert.ok(row, 'the invited membership is missing from the invitee\'s own summary after accepting');
  assert.equal(row!.invitedByName, 'Dana Okonkwo',
    'the invitation must carry the inviter stamp the modal renders as "(supplied by the sender)" — ' +
    'without it the invitee meets the SELF flavour for something a third party initiated');
  console.error('  ✓ limb 5 — the inviter stamp survives to the summary the modal renders from');

  console.error('  ── an invitation is an offer: Home, then a modal, then consent');
}
