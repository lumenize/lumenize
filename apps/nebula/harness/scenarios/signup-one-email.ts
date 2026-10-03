/**
 * **A brand-new person spends ONE email, on either arm.**
 *
 * Signing up used to cost two: one link to prove the address, then — because the claim was a
 * separate unauthenticated call that issued its own link — a second one to enter what you had just
 * created. Both arms of the new design spend one, and they get there differently, so both are here:
 *
 *  - **The AFFORDANCE arm.** Someone who says up front that they are new uses "Create a new account",
 *    which names the account and its first app and sends the claim link in one call. The link opens
 *    a consent screen, and its Accept signs them in and lands in the first app's Studio.
 *  - **The FALLBACK arm.** Someone who does not — who just types their address into the login form —
 *    proves their mailbox and turns out to have nothing to enter. The link page's Continue issues a
 *    **signup ticket** and lands on the slug screen, whose claim spends that ticket and logs them
 *    straight in.
 *    No second link, because the mailbox was proved seconds ago by the click that issued the ticket.
 *
 * ⚠️ **"One email" is asserted by COUNTING REAL MAIL, which only a real run can do.** In-lane there
 * is no mailbox to count — a test reads a link out of a response body, so a second send would be
 * invisible. Here each arm arms a waiter for a SECOND letter after the first and asserts it times
 * out. That is the assertion; the rest is setup.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **Affordance: one letter, whose page offers the new universe's consent, and whose Accept lands
 *     in the first app's Studio.** *Reds if the claim stops sending, or if Accept lands anywhere but
 *     the first app's host.*
 *  2. **Affordance: NO second letter.** *Reds against re-introducing a post-claim login send.*
 *  3. **Affordance: loading the link changes nothing, and Accept is what signs in and accepts.**
 *     The page's `GET` sets no cookie and leaves the link unspent and the membership pending; the
 *     cookie the Accept sets mints at once. *Reds against a `GET` that consumes, which would let a
 *     mail scanner accept on its owner's behalf.*
 *  4. **Fallback: a proved address with nothing to enter is sent to `/auth/signup` with a ticket.**
 *     *Reds against the ticket never being issued — the browser would arrive unable to claim.*
 *  5. **Fallback: the ticket claims in ONE step and returns a live session, with no second letter.*
 *     *Reds against the claim sending a link instead of logging them in.*
 *  6. **The letter says Lumenize.** Limb 1's real magic-link email names Lumenize in its subject and
 *     body and Nebula nowhere, since Nebula is a code name. *Reds if the sender's `appName` goes
 *     back to the code name.*
 *
 * `needsContainer = false` — auth only, never a build.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import {
  requestUniverseClaim, refreshTokenForScope, setCookieHeaders, consumeLink, refreshFromPage, refreshCookie,
  scopeOriginFrom,
} from '../../test/lib/email-login';
import { SIGNUP_TICKET_COOKIE } from '@lumenize/nebula-auth/claims';

export const needsContainer = false;

/**
 * Assert that NO further mail reaches `to` within `ms`.
 *
 * ⚠️ The timeout is the pass condition, so it is deliberately short — this waits out the window a
 * second send would land in, and every second here is paid on every run. A real second send arrives
 * in ~1s (measured, `testing.md`), so 8s is generous without being slow.
 */
async function assertNoSecondLetter(testToken: string, to: string, label: string): Promise<void> {
  const waiter = waitForEmail({ testToken, to, timeout: 8_000 });
  try {
    const arrived = await waiter.emailPromise.then(() => true).catch(() => false);
    assert.equal(arrived, false, `${label}: a SECOND email was sent — signup must cost exactly one`);
  } finally {
    waiter.cleanup();
  }
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const suffix = crypto.randomUUID().slice(0, 8);

  // ══ THE AFFORDANCE ARM ═════════════════════════════════════════════════════════════════════════
  {
    const person = uniqueTestEmail();
    const universe = `aff-${suffix}`;

    // ── LIMB 1: one letter, landing on Home ────────────────────────────────────────────────────
    const waiter = waitForEmail({ testToken, instance: universe, to: person, timeout: 60_000 });
    let link: string;
    let letter: Awaited<typeof waiter.emailPromise>;
    try {
      const claimed = await requestUniverseClaim({ baseUrl: origin, universe, appSlug: 'first', email: person });
      assert.notEqual(claimed, null, 'the affordance claim was refused — the slug should be free');
      letter = await waiter.emailPromise;
      link = extractMagicLink(letter);
    } finally {
      waiter.cleanup();
    }

    // ── LIMB 6: the letter says Lumenize, and never the code name ──────────────────────────────
    assert.match(letter.subject ?? '', /Lumenize/, `the subject must name Lumenize: ${letter.subject}`);
    assert.match(letter.html ?? '', /Lumenize/, 'the body must name Lumenize');
    assert.doesNotMatch(`${letter.subject ?? ''} ${letter.html ?? ''} ${letter.text ?? ''}`, /Nebula/,
      'a letter must not name the code name');
    console.error('  ✓ limb 6 — the letter names Lumenize and never Nebula');

    // ── LIMB 3, first half: loading the link changes nothing ──────────────────────────────────
    const loaded = await fetch(link);
    await loaded.text();
    assert.deepEqual(setCookieHeaders(loaded), [], "the link page's GET must set no cookie");
    const lookup = await fetch(`${new URL(link).origin}/auth/magic-link/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ token: new URL(link).searchParams.get('token') }),
    });
    const shown = await lookup.json() as { spent?: boolean; pending?: { scope: string; invited: boolean } };
    assert.equal(shown.spent, false, "the link page's GET spent the link");
    assert.equal(shown.pending?.scope, universe, 'the link page must offer consent to the new universe');

    // ── LIMB 1: Accept lands in the first app's Studio ─────────────────────────────────────────
    const clicked = await consumeLink(link, fetch, { nickname: 'Aff' });
    assert.equal(clicked.status, 200, `the claim's Accept failed (${clicked.status})`);
    const { redirect } = await clicked.clone().json() as { redirect?: string };
    const studio = `${scopeOriginFrom(origin, `${universe}.first`)}/`;
    assert.equal(redirect, studio,
      "a claim's Accept must land in the first app's Studio, never on Home or the universe page");
    console.error(`  ✓ limb 1 — affordance: one letter, consent for ${universe}, Accept lands on ${studio}`);

    // ── LIMB 2: no second letter ───────────────────────────────────────────────────────────────
    await assertNoSecondLetter(testToken, person, 'affordance arm');
    console.error('  ✓ limb 2 — affordance: no second email');

    // ── LIMB 3, second half: the Accept's cookie mints at once ─────────────────────────────────
    const token = refreshTokenForScope(setCookieHeaders(clicked), universe);
    assert.ok(token, "the claim's Accept set no cookie for the universe it created");
    const afterAccept = await refreshFromPage(origin, universe, refreshCookie(universe, token!));
    assert.equal(afterAccept.status, 200,
      `the Accept's own cookie must mint at once (${afterAccept.status}): ${await afterAccept.text()}`);
    console.error('  ✓ limb 3 — affordance: the GET changed nothing; the Accept signed in and accepted');
  }

  // ══ THE FALLBACK ARM ═══════════════════════════════════════════════════════════════════════════
  {
    const person = uniqueTestEmail();
    const universe = `fbk-${suffix}`;

    // ── LIMB 4: a proved address with nothing to enter gets a ticket and the slug screen ────────
    const waiter = waitForEmail({ testToken, instance: '_scopeless', to: person, timeout: 60_000 });
    let link: string;
    try {
      const requested = await fetch(`${origin}/auth/email-magic-link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
        body: JSON.stringify({ email: person }),
      });
      assert.equal(requested.status, 200, `the scope-less request was refused (${requested.status})`);
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }

    const clicked = await consumeLink(link);
    assert.equal(clicked.status, 200, `the Continue failed (${clicked.status})`);
    const { redirect } = await clicked.clone().json() as { redirect?: string };
    assert.equal(redirect, '/auth/signup', 'a proved address with no memberships must land on the slug screen');
    const ticket = setCookieHeaders(clicked)
      .find((c) => c.startsWith(`${SIGNUP_TICKET_COOKIE}=`))?.split(';')[0].split('=')[1];
    assert.ok(ticket, 'no signup ticket was issued — the slug screen would have no way to claim');
    console.error('  ✓ limb 4 — fallback: /auth/signup with a signup ticket');

    // ── LIMB 5: the ticket claims in one step, and no second letter is sent ─────────────────────
    const claimed = await fetch(`${origin}/auth/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin',
        Cookie: `${SIGNUP_TICKET_COOKIE}=${ticket}`,
      },
      body: JSON.stringify({ slug: universe, appSlug: 'first' }),
    });
    assert.equal(claimed.status, 200, `the ticket claim failed (${claimed.status}): ${await claimed.text()}`);
    const session = refreshTokenForScope(setCookieHeaders(claimed), universe);
    assert.ok(session, 'the ticket claim returned no session — the whole point is that it logs you in');

    await assertNoSecondLetter(testToken, person, 'fallback arm');
    console.error('  ✓ limb 5 — fallback: claimed and signed in on one email, no second letter');
  }

  console.error('  ── both newbie arms cost exactly one email');
}
