/**
 * One person, two scopes, ONE `profileId` — proved with no fixture at all.
 *
 * Two genuinely different mint paths see the same address: an open Universe claim, and an admin's
 * invite into a different Universe. Both complete a **real email round trip** (ADR-009 rung 1 —
 * `waitForEmail` against the deployed email-test Worker, the link pulled from the message that
 * actually arrived, then its page's button pressed), and we compare the `profileId` claim on the two
 * resulting JWTs.
 *
 * ⚠️ **Why this belongs at the live tier even though an in-lane version now exists.** The in-lane
 * test (`packages/nebula-auth/test/identity-mint-point.test.ts`) asserts the same property and is
 * mutation-checked, so this is not about capability — pool-workers CAN assert it. It is about the
 * thing that keeps going wrong: every assertion in-lane rests on a fixture somebody built, and this
 * build lost time twice to fixtures that were the *safe* shape (a mutation-restore that corrupted a
 * neighbouring statement, and an acceptance fixture where the guard protected the row either way).
 * A scenario that claims a Universe, sends a real invite, and clicks two real emails has **no
 * fixture to get wrong** — the convergence is either what the running system does or it is not.
 *
 * ⚠️ **Its predecessor justification was WRONG and is recorded here so it is not revived:** the task
 * file argued live was needed because pool-workers could only assert convergence by hand-seeding it.
 * That was true before `profileId` moved onto the address row and false after — `#mintIdentity` now
 * find-or-creates by address, so both paths reuse one `Emails` row by construction. An expired
 * justification is a trigger to re-derive, not a licence to drop the tier.
 *
 * `needsContainer = false` — this drives auth only and never a build, so the boot skips Docker.
 */
import assert from 'node:assert/strict';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { inviteViaMesh, readDevVar } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import {
  provisionAndLogin, refreshTokenForScope, setCookieHeaders, consumeLink, refreshFromPage, refreshCookie,
} from '../../test/lib/email-login';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');

  // The person whose identity must converge. A real, catch-all-routed mailbox.
  const person = uniqueTestEmail();
  const ownUniverse = testSlug('conv-own');
  const otherUniverse = testSlug('conv-other');

  // ── Path 1: the open Universe claim, logged in for real ──────────────────────────────────────
  const viaClaim = await provisionAndLogin({
    baseUrl: origin, scope: ownUniverse, email: person, testToken,
  });
  const claimProfileId = (parseJwtUnsafe(viaClaim.accessToken)!.payload as any).profileId as string;
  assert.ok(claimProfileId, 'the claim login carried no profileId claim');

  // ── Path 2: a DIFFERENT admin invites the same address, and they accept for real ─────────────
  const otherAdmin = await provisionAndLogin({
    baseUrl: origin, scope: otherUniverse, email: uniqueTestEmail(), testToken,
  });

  // Arm the mailbox watcher BEFORE issuing, so the invite cannot land before we are listening.
  const inviteWaiter = waitForEmail({
    testToken, instance: otherUniverse, to: person, timeout: 60_000,
  });
  let inviteHtml: string;
  try {
    // The ONE production surface: NebulaClient.invite → Gateway → facade (there is no HTTP route).
    const summary = await inviteViaMesh(stack, otherAdmin, otherUniverse, [{ email: person }]);
    assert.equal(summary.errors.length, 0, `invite failed: ${JSON.stringify(summary.errors)}`);
    assert.equal(summary.results[0]?.outcome, 'invited', 'the mint outcome must be `invited`');
    inviteHtml = (await inviteWaiter.emailPromise).html ?? '';
  } finally {
    // ⚠️ ALWAYS close the waiter — its WebSocket to the email-test Worker keeps Node's event loop
    // alive, so a leaked one makes the process hang AFTER printing its verdict. That is what makes a
    // 5-second scenario look like a hung 7-minute boot, and it is why `/live` feels expensive when it
    // is not. In a `finally` so a failing assertion above cannot skip it.
    inviteWaiter.cleanup();
  }

  // The `&amp;` unescape matters: the HTML entity is what an email body actually carries, and a link
  // fetched with it intact silently fails.
  const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(inviteHtml)?.[1];
  assert.ok(href, `invite email carried no magic link (subject start: ${inviteHtml.slice(0, 60)})`);
  const inviteLink = href.replace(/&amp;/g, '&');
  // The invite's page is its consent screen: its Accept proves the mailbox and takes the membership
  // up in one click, so the cookie it sets mints at once.
  const clicked = await consumeLink(inviteLink);
  // ⚠️ `headers.get('set-cookie')` returns only the FIRST of N under mint-all — read them all, and
  // take the one for the scope this invite was into.
  const refreshToken = refreshTokenForScope(setCookieHeaders(clicked), otherUniverse);
  assert.ok(refreshToken, `accepting the real invite set no cookie for "${otherUniverse}" (${clicked.status})`);

  const refreshed = await refreshFromPage(origin, otherUniverse, refreshCookie(otherUniverse, refreshToken!));
  assert.equal(refreshed.status, 200, 'the invited identity could not refresh');
  const invitePayload = parseJwtUnsafe((await refreshed.json() as any).access_token)!.payload as any;

  // ── The property ─────────────────────────────────────────────────────────────────────────────
  // Reds against a mint that writes a fresh `Emails.profileId` on the second path instead of reusing
  // the existing address row — i.e. against the first-mover race the split exists to dissolve.
  assert.equal(
    invitePayload.profileId, claimProfileId,
    'two paths that saw ONE address produced two profileIds — the convergence is not structural',
  );
  // ...while the memberships stay distinct, which is what makes the shared id meaningful rather than
  // a symptom of the two logins collapsing into one identity.
  assert.notEqual(
    invitePayload.sub, (parseJwtUnsafe(viaClaim.accessToken)!.payload as any).sub,
    'the two memberships share a sub — they should be distinct identities on one address',
  );

  console.error(`[identity-convergence] one profileId across two real logins: ${claimProfileId}`);
}
