/**
 * **A brand-new person spends ONE email, on either arm.**
 *
 * Signing up used to cost two: one link to prove the address, then — because the claim was a
 * separate unauthenticated call that issued its own link — a second one to enter what you had just
 * created. Both arms of the new design spend one, and they get there differently, so both are here:
 *
 *  - **The AFFORDANCE arm.** Someone who says up front that they are new uses "Create a new account",
 *    which names the account and sends the claim link in one call. The click lands on Home with the
 *    self-flavour modal over their new universe.
 *  - **The FALLBACK arm.** Someone who does not — who just types their address into the login form —
 *    proves their mailbox and turns out to have nothing to enter. The click issues a **signup
 *    ticket** and lands on the slug screen, whose claim spends that ticket and logs them straight in.
 *    No second link, because the mailbox was proved seconds ago by the click that issued the ticket.
 *
 * ⚠️ **"One email" is asserted by COUNTING REAL MAIL, which only a real run can do.** In-lane there
 * is no mailbox to count — a test reads a link out of a response body, so a second send would be
 * invisible. Here each arm arms a waiter for a SECOND letter after the first and asserts it times
 * out. That is the assertion; the rest is setup.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **Affordance: one letter, and the click lands on Home for the new universe.** *Reds if the
 *     claim stops sending, or if the 302 teleports into the universe instead of stopping at Home.*
 *  2. **Affordance: NO second letter.** *Reds against re-introducing a post-claim login send.*
 *  3. **Affordance: the membership is UNACCEPTED on arrival, and Accept is what takes it up.**
 *     *Reds against a consume-time flip, which would make the modal decorative.*
 *  4. **Fallback: a proved address with nothing to enter lands on `/auth/signup` with a ticket.**
 *     *Reds against the ticket never being issued — the browser would arrive unable to claim.*
 *  5. **Fallback: the ticket claims in ONE step and returns a live session, with no second letter.*
 *     *Reds against the claim sending a link instead of logging them in.*
 *
 * `needsContainer = false` — auth only, never a build.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import {
  requestUniverseClaim, refreshTokenForScope, setCookieHeaders, acceptMembership,
} from '../../test/lib/email-login';

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
    try {
      const claimed = await requestUniverseClaim({ baseUrl: origin, universe, email: person });
      assert.notEqual(claimed, null, 'the affordance claim was refused — the slug should be free');
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }

    const clicked = await fetch(link, { redirect: 'manual' });
    assert.equal(clicked.status, 302, `the claim click did not redirect (${clicked.status})`);
    assert.equal(clicked.headers.get('Location'), `/auth/${universe}/home`,
      'a claim click must land on HOME with its modal, never inside the universe it just created');
    console.error(`  ✓ limb 1 — affordance: one letter, landing on /auth/${universe}/home`);

    // ── LIMB 2: no second letter ───────────────────────────────────────────────────────────────
    await assertNoSecondLetter(testToken, person, 'affordance arm');
    console.error('  ✓ limb 2 — affordance: no second email');

    // ── LIMB 3: unaccepted on arrival; Accept is what takes it up ──────────────────────────────
    const token = refreshTokenForScope(setCookieHeaders(clicked), universe);
    assert.ok(token, 'the claim click set no cookie for the universe it created');
    const beforeAccept = await fetch(`${origin}/auth/${universe}/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `refresh-token=${token}` },
      body: JSON.stringify({ activeScope: universe }),
    });
    assert.equal(beforeAccept.status, 401,
      'an unaccepted membership must mint nothing — otherwise the consent modal decorates a live session');
    assert.match(await beforeAccept.text(), /membership_not_accepted/);

    await acceptMembership(origin, token!, universe);
    const afterAccept = await fetch(`${origin}/auth/${universe}/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `refresh-token=${token}` },
      body: JSON.stringify({ activeScope: universe }),
    });
    assert.equal(afterAccept.status, 200, 'the SAME cookie must mint once its membership is accepted');
    console.error('  ✓ limb 3 — affordance: inert before Accept, live after, on one cookie');
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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: person }),
      });
      assert.equal(requested.status, 200, `the scope-less request was refused (${requested.status})`);
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }

    const clicked = await fetch(link, { redirect: 'manual' });
    assert.equal(clicked.status, 302, `the click did not redirect (${clicked.status})`);
    assert.equal(clicked.headers.get('Location'), '/auth/signup',
      'a proved address with no memberships must land on the slug screen');
    const ticket = setCookieHeaders(clicked)
      .find((c) => c.startsWith('signup-ticket='))?.split(';')[0].split('=')[1];
    assert.ok(ticket, 'no signup ticket was issued — the slug screen would have no way to claim');
    console.error('  ✓ limb 4 — fallback: /auth/signup with a signup ticket');

    // ── LIMB 5: the ticket claims in one step, and no second letter is sent ─────────────────────
    const claimed = await fetch(`${origin}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `signup-ticket=${ticket}` },
      body: JSON.stringify({ slug: universe }),
    });
    assert.equal(claimed.status, 200, `the ticket claim failed (${claimed.status}): ${await claimed.text()}`);
    const session = refreshTokenForScope(setCookieHeaders(claimed), universe);
    assert.ok(session, 'the ticket claim returned no session — the whole point is that it logs you in');

    await assertNoSecondLetter(testToken, person, 'fallback arm');
    console.error('  ✓ limb 5 — fallback: claimed and signed in on one email, no second letter');
  }

  console.error('  ── both newbie arms cost exactly one email');
}
