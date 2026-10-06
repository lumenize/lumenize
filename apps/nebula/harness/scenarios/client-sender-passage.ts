/**
 * **A call from another tab reaches the receiving Client, which refuses it before decoding it.**
 *
 * A tab is named `{sub}.{tabId}`, not by a scope, so it offers no scope for the receiving Gateway
 * to check passage into. The Gateway passes a Client sender through, and the receiving Client's
 * default `onBeforeCall` refuses it with its own message. Two plain members, each invited into one
 * of two sibling Stars, make limb 1 lateral.
 *
 * Two limbs:
 *  1. **A tab on Star B calling a tab on Star A reaches A's Client and is refused there**, matched
 *     on *Direct client-to-client calls are disabled by default*, never a passage message.
 *     Mutation: restore the Gateway's Client branch, and the passage refusal arrives instead.
 *  2. **A tab whose frame carries a chain no decoder can read is still refused with that message.**
 *     Its socket nulls the chain of each CALL frame it sends while armed, and nothing else. The
 *     tab is on Star A, so it passes any Gateway check, and the refusal shows the caller check ran
 *     before decoding. Mutation: decode before `onBeforeCall`, and the decoder's `TypeError`
 *     arrives instead.
 *
 * Both limbs run and the verdict comes at the end, so a mutation that reds one limb leaves the
 * other visible (`live-scenarios.md`).
 *
 * Real logins throughout (ADR-009 rung 1): the owner is the run's shared app's, signed in by email,
 * and each member arrives by a real invite email, accepts, and refreshes onto their Star.
 * `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import { Browser } from '@lumenize/testing';
import { GatewayMessageType } from '@lumenize/mesh/client';
import { NebulaClient, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, constructionPairs, readDevVar, scopeUrlOf } from '../lib/harness';
import { provisionAndLogin, refreshAccessToken, acceptInviteAndLogin, foundTenantStar } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';
import { testSlug } from '../lib/test-scopes';

export const needsContainer = false;

/**
 * A tab's socket that replaces the chain of every CALL frame it sends with `null` while armed, and
 * counts the frames it touched. Every other byte is what `NebulaClient` wrote: the only forged thing
 * is what an attacker controls, its own tab's bytes.
 */
function garblingWebSocket(garble: { armed: boolean; rewritten: number }): typeof WebSocket {
  return class GarblingWebSocket extends WebSocket {
    override send(message: Parameters<WebSocket['send']>[0]): void {
      if (garble.armed && typeof message === 'string') {
        const frame = JSON.parse(message);
        if (frame.type === GatewayMessageType.CALL) {
          frame.chain = null;
          garble.rewritten += 1;
          message = JSON.stringify(frame);
        }
      }
      super.send(message);
    }
  };
}

const PEER_REFUSAL = /^Direct client-to-client calls are disabled by default/;

/** The refusal MESSAGE, or `null` if the call succeeded — a refusal is matched by what it says. */
async function refusal(op: Promise<unknown>): Promise<string | null> {
  try { await op; return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  // The run's shared app, with two sibling Stars of this scenario's own beneath it.
  const app = await sharedApp(stack, testToken);
  const galaxy = app.galaxy;
  const starA = `${galaxy}.${testSlug('a')}`;
  const starB = `${galaxy}.${testSlug('b')}`;

  const ownerSession = await provisionAndLogin({ baseUrl: origin, scope: galaxy, email: app.ownerEmail, testToken });
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
    const tabB = await connectDriver(stack, { scope: starB, session: memberB });
    drivers.push(tabA, tabB);
    const callTabA = (from: Driver) => from.client.lmz.callAsync(
      'NEBULA_CLIENT_GATEWAY', tabA.client.lmz.instanceName!,
      (from.client.ctn() as any).handleOrgTreeUpdate({ value: {} }));

    const failures: string[] = [];
    const limb = (name: string, got: string | null, why: string) => {
      if (got !== null && PEER_REFUSAL.test(got)) console.log(`  ✓ ${name}`);
      else { console.log(`  ✗ ${name} — got ${got ?? '(succeeded)'}`); failures.push(`${name}: ${why} Got: ${got ?? '(succeeded)'}`); }
    };

    // ── LIMB 1: a tab on a sibling Star reaches the receiving Client, which refuses it ────────────
    limb(`limb 1 — a tab on ${starB} reached ${starA}'s Client and was refused there`,
      await refusal(callTabA(tabB)), 'a tab on a sibling Star did not meet the receiving Client\'s refusal.');


    // ── LIMB 2: a chain no decoder can read is refused by the caller check, before decoding ──────
    const garble = { armed: false, rewritten: 0 };
    const garblerBrowser = new Browser();
    const garblerCtx = garblerBrowser.context(scopeUrlOf(stack, starA));
    const garbler = new NebulaClient({
      baseUrl: scopeUrlOf(stack, starA),
      platformOrigin: stack.baseUrl,
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      ...constructionPairs(starA),
      accessToken: memberA.accessToken,
      instanceName: `${memberA.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: garblerCtx.fetch,
      sessionStorage: garblerCtx.sessionStorage,
      BroadcastChannel: garblerCtx.BroadcastChannel,
      WebSocket: garblingWebSocket(garble),
    });
    try {
      const deadline = Date.now() + 30_000;
      while (garbler.connectionState !== 'connected') {
        assert.ok(Date.now() < deadline, `the garbling tab never connected (state=${garbler.connectionState})`);
        await new Promise((r) => setTimeout(r, 50));
      }
      garble.armed = true;
      const garbled = await refusal(garbler.lmz.callAsync(
        'NEBULA_CLIENT_GATEWAY', tabA.client.lmz.instanceName!,
        (garbler.ctn() as any).handleOrgTreeUpdate({ value: {} })));
      garble.armed = false;
      assert.ok(garble.rewritten > 0, 'the garbling socket sent no CALL frame, so limb 2 tested nothing');
      limb('limb 2 — an undecodable chain from a tab is refused by the caller check, before decoding',
        garbled, 'an undecodable chain from a tab did not meet the caller check first.');
    } finally {
      try { garbler[Symbol.dispose](); } catch { /* already disposed */ }
      garblerCtx.close();
    }
    assert.equal(failures.length, 0, failures.join('\n'));
  } finally {
    for (const d of drivers) d.dispose();
  }
}
