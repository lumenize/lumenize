/**
 * **A tab's Gateway refuses a call from a tab on a sibling Star, by passage, with its own message.**
 *
 * When the sender of a call to a tab is another Client, the receiving Gateway reads the sender's
 * scope from the `aud` the sender's own Gateway verified, and checks the receiving tab's passage
 * into it. Two plain members, each invited into one of two sibling Stars, make the case lateral.
 *
 * Two limbs:
 *  1. **A tab on Star B calling a tab on Star A is refused at A's Gateway**, matched by the passage
 *     message naming both scopes. Mutation: drop the Gateway's Client branch, so a Client sender is
 *     read like a node whose `{sub}.{tabId}` name is no scope, and the refusal that arrives is the
 *     receiving client's own *Direct client-to-client calls are disabled by default*.
 *  2. **Positive control: a second tab on Star A calling the first passes the Gateway** and meets
 *     that client refusal, so the Gateway does reach a client, and limb 1's refusal is passage.
 *
 * Real logins throughout (ADR-009 rung 1): the owner claims the universe, and each member arrives by
 * a real invite email, accepts, and refreshes onto their Star. `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { provisionAndLogin, refreshAccessToken, acceptInviteAndLogin, foundTenantStar } from '../../test/lib/email-login';

export const needsContainer = false;

/** The refusal MESSAGE, or `null` if the call succeeded — a refusal is matched by what it says. */
async function refusal(op: Promise<unknown>): Promise<string | null> {
  try { await op; return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const universe = `csp-${crypto.randomUUID().slice(0, 8)}`;
  const galaxy = `${universe}.app`;
  const starA = `${galaxy}.a`;
  const starB = `${galaxy}.b`;

  const ownerSession = await provisionAndLogin({ baseUrl: origin, scope: galaxy, email: uniqueTestEmail(), testToken });
  // Each Star founded as a tenant founds one: its own claim, accepted by its claimer. Nothing is
  // invited into a Star whose founder is pending; the owner's dominion is what reaches them.
  for (const star of [starA, starB]) {
    assert.notEqual(await foundTenantStar({ baseUrl: origin, star, testToken }), null, `claim-star found ${star} already claimed`);
  }
  const owner = await connectDriver(stack, {
    scope: galaxy, session: { accessToken: ownerSession.accessToken, sub: ownerSession.sub },
  });

  /** A plain member of `star`: invited by the owner, the email followed as sent, accepted. */
  async function member(star: string): Promise<{ accessToken: string; sub: string }> {
    const email = uniqueTestEmail();
    const waiter = waitForEmail({ testToken, instance: star, to: email, timeout: 60_000 });
    let inviteLink: string;
    try {
      const summary = await owner.client.invite(star, [{ email }]);
      assert.equal(summary.errors.length, 0, `invite into ${star} failed: ${JSON.stringify(summary.errors)}`);
      const html = (await waiter.emailPromise).html ?? '';
      const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(html)?.[1];
      assert.ok(href, `invite email carried no magic link (starts: ${html.slice(0, 60)})`);
      inviteLink = href.replace(/&amp;/g, '&');
    } finally {
      waiter.cleanup();
    }
    const { refreshToken } = await acceptInviteAndLogin({ baseUrl: origin, inviteLink, scope: star });
    return refreshAccessToken(origin, { refreshToken, authScope: star }, star);
  }

  const memberA = await member(starA);
  const memberB = await member(starB);
  const drivers: Driver[] = [owner];
  try {
    const tabA = await connectDriver(stack, { scope: starA, session: memberA });
    const tabA2 = await connectDriver(stack, { scope: starA, session: memberA });
    const tabB = await connectDriver(stack, { scope: starB, session: memberB });
    drivers.push(tabA, tabA2, tabB);
    const callTabA = (from: Driver) => from.client.lmz.callAsync(
      'NEBULA_CLIENT_GATEWAY', tabA.client.lmz.instanceName!,
      (from.client.ctn() as any).handleOrgTreeUpdate({ value: {} }));

    // ── LIMB 1: a tab on a sibling Star is refused at the receiving Gateway, by passage ──────────
    const lateral = await refusal(callTabA(tabB));
    assert.equal(lateral, `No passage from "${starA}" into "${starB}"`,
      `a tab on ${starB} reached a tab on ${starA}'s Gateway past passage. Got: ${lateral}`);
    console.log(`  ✓ limb 1 — ${starA}'s Gateway refused a tab on ${starB} by passage`);

    // ── LIMB 2: a second tab on the same Star passes the Gateway and meets the client's refusal ──
    const sameStar = await refusal(callTabA(tabA2));
    assert.match(sameStar ?? '(succeeded)', /Direct client-to-client calls are disabled by default/,
      `a second tab on ${starA} did not reach the client's own refusal. Got: ${sameStar}`);
    console.log('  ✓ limb 2 — a second tab on the same Star passes the Gateway and meets the client refusal');
  } finally {
    for (const d of drivers) d.dispose();
  }
}
