/**
 * **The direct-invite slice, end to end on real infrastructure** — invite → real email through the
 * catch-all → click the delivered link → arrive with everything in place. The scenario the F&F
 * gate rides: nothing here is a fixture — the inviter logged in through a real claim, the invite
 * rides `NebulaClient.invite` → Gateway → `NEBULA_AUTH_FACADE` (the ONE production surface; there
 * is no HTTP route), the letter is the one that actually arrived, and every persisted effect is
 * read off a real-login JWT or the running Star (ADR-009 rung 1).
 *
 * Four limbs, each with its own assertion and its own way to red (live.md — per limb, not per
 * scenario):
 *
 *  1. **The mint summary returns synchronously and carries NO URL** — the caller's `callAsync`
 *     resolves with per-invitee outcomes while the send finishes under `ctx.waitUntil`; the raw
 *     link exists only in the mail. *Reds against an unfiltered summary (the `invite_token`
 *     probe) or a dead facade binding (no summary at all).*
 *  2. **The REAL letter arrives, tagged and deliverable** — the catch-all receives an
 *     `invite-new`-shaped mail tagged with the target scope, carrying an `accept-invite` link.
 *     *Reds if the facade never dispatches the send (a 60s timeout here, while limb 1 stays
 *     green — the mutation that isolates this limb).*
 *  3. **Clicking THAT link is the login** — the cookie lands, and the refresh mints a JWT whose
 *     `authScope` is the star and whose `scopeAdmin` is true (scenario 4: the invite requested the
 *     bit under the inviter's dominion). *The bit's own mutations are validated in-lane
 *     (nebula-auth-invite.test.ts drives the same mint); what only this tier can add is that the
 *     DELIVERED link carries them.*
 *  4. **First arrival fires the founder stamp** — the star was created by `create-star` (mints no
 *     identity), so the invitee is its first star-scoped admin; their first Star touch seeds the
 *     DAG root `admin` grant, observed on the orgTree channel. *Reds against suppressing the seed
 *     (`Star.onBeforeCall`) while limbs 1–3 stay green.*
 *
 * `needsContainer = false` — auth + orgTree only, never a build, so the boot skips Docker.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import { NebulaClient, ROOT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, type OrgTreeState } from '@lumenize/nebula/client';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import {
  provisionAndLogin, refreshAccessToken, acceptInviteAndLogin,
} from '../../test/lib/email-login';
import { parseJwtUnsafe } from '@lumenize/crypto';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const suffix = crypto.randomUUID().slice(0, 8);
  const universe = `inv-${suffix}`;
  const star = `${universe}.app.tenant`;
  const inviteeEmail = uniqueTestEmail();

  // The inviter: a real universe admin (claim → real email → login), with the galaxy + star scopes
  // created beneath — `create-star` registers the scope and mints NO identity, which is what makes
  // the invitee below this Star's FIRST star-scoped admin (limb 4's precondition).
  const adminSession = await provisionAndLogin({ baseUrl: origin, scope: star, testToken });
  let admin: Driver | undefined;
  let invitee: NebulaClient | undefined;
  const inviteeBrowser = new Browser();
  const waiter = waitForEmail({ testToken, instance: star, to: inviteeEmail, timeout: 60_000 });
  try {
    admin = await connectDriver(stack, {
      scope: universe,
      session: { accessToken: adminSession.accessToken, sub: adminSession.sub },
    });

    // ── LIMB 1: the synchronous per-invitee summary, URL-free ────────────────────────────────────
    const summary = await admin.client.invite(star, [{ email: inviteeEmail, scopeAdmin: true }]);
    assert.equal(summary.errors.length, 0, `invite failed: ${JSON.stringify(summary.errors)}`);
    assert.equal(summary.results[0]?.outcome, 'invited', 'a fresh invitee must mint as `invited`');
    assert.ok(summary.results[0]?.sub, 'the minted sub must ride the summary');
    const wire = JSON.stringify(summary);
    assert.ok(!wire.includes('invite_token'), 'the production summary must carry no invite URL');
    assert.equal(summary.links, undefined, 'test-mode links must not appear on a production summary');

    // ── LIMB 2: the real letter — tagged, invite-new-shaped, deliverable ─────────────────────────
    const mail = await waiter.emailPromise;
    assert.equal(
      mail.instance, star,
      `invite mail must be tagged with its instance (got ${mail.instance ?? 'undefined'})`,
    );
    const html = mail.html ?? '';
    const href = /href="([^"]*accept-invite[^"]*invite_token[^"]*)"/.exec(html)?.[1];
    assert.ok(href, `invite email carried no accept-invite link (starts: ${html.slice(0, 60)})`);
    const link = href.replace(/&amp;/g, '&');

    // ── LIMB 3: the click IS the login, and the persisted bit rides the real path ────────────────
    const { refreshToken } = await acceptInviteAndLogin({
      baseUrl: origin, inviteLink: link, scope: star, fetchImpl: inviteeBrowser.fetch,
    });
    const inviteeSession = await refreshAccessToken(
      origin, { refreshToken, authScope: star }, star, inviteeBrowser.fetch,
    );
    const claims = parseJwtUnsafe(inviteeSession.accessToken)!.payload as any;
    assert.equal(claims.access.authScope, star, "the invitee's authScope must be the star, verbatim");
    assert.equal(claims.access.scopeAdmin, true, 'the requested bit, licensed by dominion, must persist to the JWT');
    assert.equal(claims.sub, summary.results[0]!.sub, 'the login must resolve to the SAME membership the mint returned');

    // ── LIMB 4: first arrival fires the founder stamp ─────────────────────────────────────────────
    // Constructed by hand (not connectDriver) so the orgTree listener registers BEFORE the client
    // reaches 'connected' — the tree subscription only fires at connect when a listener exists.
    // `resourceHostBinding` is left to its default ('STAR'): the dagTree lives on the Star, and the
    // subscribe is itself the invitee's first Star touch — the exact moment the seed runs.
    const ctx = inviteeBrowser.context(stack.baseUrl);
    let tree: OrgTreeState | undefined;
    invitee = new NebulaClient({
      baseUrl: stack.baseUrl,
      authScope: star,
      activeScope: star,
      // Inert — the invitee only watches orgTree here, never a resource op.
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      accessToken: inviteeSession.accessToken,
      instanceName: `${inviteeSession.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: inviteeBrowser.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
    });
    invitee.onOrgTreeUpdate((state) => { tree = state; });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const grant = tree?.permissions?.get(ROOT_NODE_ID)?.get(inviteeSession.sub);
      if (grant === 'admin') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const grant = tree?.permissions?.get(ROOT_NODE_ID)?.get(inviteeSession.sub);
    assert.equal(
      grant, 'admin',
      'the invited star-scoped admin\'s FIRST arrival must seed the DAG root admin grant ' +
      `(founder stamp) — got ${grant ?? 'no grant'} with tree ${tree ? 'delivered' : 'never delivered'}`,
    );
  } finally {
    waiter.cleanup(); // a leaked waiter's WebSocket keeps Node's event loop alive past the verdict
    try { invitee?.[Symbol.dispose](); } catch { /* already disposed */ }
    admin?.dispose();
  }

  console.error(
    '[invite-roundtrip] mint summary synchronous + URL-free; real letter tagged + delivered; ' +
    'the click logged in with the licensed bit; first arrival seeded the founder grant',
  );
}
