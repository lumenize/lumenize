/**
 * **The direct-invite slice, end to end on real infrastructure** — invite → real email through the
 * catch-all → click the delivered link → arrive with everything in place. The scenario the F&F
 * gate rides: nothing here is a fixture — the inviter logged in through a real claim, the invite
 * rides `NebulaClient.invite` → its host node → `AUTH_FACADE` (the ONE production surface; there
 * is no HTTP route), the letter is the one that actually arrived, and every persisted effect is
 * read off a real-login JWT or the running Star (ADR-009 rung 1).
 *
 * Four limbs, each with its own assertion and its own way to red (live.md — per limb, not per
 * scenario):
 *
 *  1. **The mint summary returns synchronously and carries NO URL** — the caller's `callAsync`
 *     resolves with per-invitee outcomes while the send finishes under `ctx.waitUntil`; the raw
 *     link exists only in the mail. *Reds against an unfiltered summary (the `magic-link?token=`
 *     probe) or a dead facade binding (no summary at all).*
 *  2. **The REAL letter arrives, tagged and deliverable** — the catch-all receives an
 *     `invite-new`-shaped mail tagged with the target scope, carrying a magic link.
 *     *Reds if the facade never dispatches the send (a 60s timeout here, while limb 1 stays
 *     green — the mutation that isolates this limb).*
 *  3. **Accepting on THAT link's page is the login** — the cookie lands, and the refresh mints a JWT whose
 *     `authScope` is the star and whose `scopeAdmin` is true (scenario 4: the invite requested the
 *     bit under the inviter's dominion). *The bit's own mutations are validated in-lane
 *     (Mesh's auth-invite.test.ts drives the same mint); what only this tier can add is that the
 *     DELIVERED link carries them.*
 *  4. **The invited star admin acts on its tree through the bypass, holding no grant there** —
 *     the tree arrives on the orgTree channel with no grant for the invitee, and their own
 *     `createNode` lands in it. *Reds if the scope-admin bypass in `requirePermission` stops
 *     admitting an admin whose dominion is exactly this Star, while limbs 1–3 stay green.*
 *
 * `needsContainer = false` — auth + orgTree only, never a build, so the boot skips Docker.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import { NebulaClient, ROOT_NODE_ID, type OrgTreeState } from '@lumenize/resources/client';
import { CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar, scopeUrlOf } from '../lib/harness';
import {
  provisionAndLogin, refreshAccessToken, acceptInviteAndLogin,
} from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';
import { testSlug } from '../lib/test-scopes';
import { parseJwtUnsafe } from '@lumenize/crypto';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  // The run's shared app, with a Star of this scenario's own beneath it.
  const app = await sharedApp(stack, testToken);
  const universe = app.universe;
  const star = `${app.galaxy}.${testSlug('inv')}`;
  const inviteeEmail = uniqueTestEmail();

  // The inviter: a real universe admin, the shared app's owner signed in by email, with this
  // scenario's Star founded beneath by a throwaway claimer whose membership is never taken up, so the
  // invitee below is the one accepted star-scoped admin limb 4 drives.
  const adminSession = await provisionAndLogin({ baseUrl: origin, scope: star, email: app.ownerEmail, testToken });
  let admin: Driver | undefined;
  let invitee: NebulaClient | undefined;
  const inviteeBrowser = new Browser();
  const waiter = waitForEmail({ testToken, instance: star, to: inviteeEmail, timeout: 60_000 });
  try {
    // On the universe's page, with the token that page's refresh mints: the node a page's host
    // names accepts no token for another host.
    const onUniverse = await refreshAccessToken(origin, adminSession.session, universe);
    admin = await connectDriver(stack, {
      scope: universe,
      session: { accessToken: onUniverse.accessToken, sub: onUniverse.sub },
    });

    // ── LIMB 1: the synchronous per-invitee summary, URL-free ────────────────────────────────────
    const summary = await admin.client.invite(star, [{ email: inviteeEmail, scopeAdmin: true }]);
    assert.equal(summary.errors.length, 0, `invite failed: ${JSON.stringify(summary.errors)}`);
    assert.equal(summary.results[0]?.outcome, 'invited', 'a fresh invitee must mint as `invited`');
    assert.ok(summary.results[0]?.sub, 'the minted sub must ride the summary');
    const wire = JSON.stringify(summary);
    assert.ok(!wire.includes('magic-link?token='), 'the production summary must carry no invite URL');
    assert.equal(summary.links, undefined, 'test-mode links must not appear on a production summary');

    // ── LIMB 2: the real letter — tagged, invite-new-shaped, deliverable ─────────────────────────
    const mail = await waiter.emailPromise;
    assert.equal(
      mail.instance, star,
      `invite mail must be tagged with its instance (got ${mail.instance ?? 'undefined'})`,
    );
    const html = mail.html ?? '';
    const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(html)?.[1];
    assert.ok(href, `invite email carried no magic link (starts: ${html.slice(0, 60)})`);
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

    // ── LIMB 4: the invited star admin acts on its tree through the bypass ──────────────────────────
    // Constructed by hand (not connectDriver) so the orgTree listener registers BEFORE the client
    // reaches 'connected' — the tree subscription only fires at connect when a listener exists.
    // `resourceHostBinding` is left to its default ('STAR'): the orgTree lives on the Star.
    const ctx = inviteeBrowser.context(scopeUrlOf(stack, star));
    let tree: OrgTreeState | undefined;
    invitee = new NebulaClient({
      baseUrl: scopeUrlOf(stack, star),
      platformOrigin: stack.baseUrl,
      // Inert — the invitee only watches orgTree here, never a resource op.
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      accessToken: inviteeSession.accessToken,
      instanceName: `${inviteeSession.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: ctx.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
    });
    invitee.onOrgTreeUpdate((state) => { tree = state; });

    const treeDeadline = Date.now() + 30_000;
    while (!tree && Date.now() < treeDeadline) await new Promise((r) => setTimeout(r, 200));
    assert.ok(tree, 'the invitee\'s orgTree was never delivered');
    assert.equal(tree.permissions?.get(ROOT_NODE_ID)?.get(inviteeSession.sub), undefined,
      'a star admin holds no grant in its tree — it acts through the bypass');

    const nodeId = crypto.randomUUID();
    await invitee.orgTree.createNode(nodeId, ROOT_NODE_ID, 'first', 'First');
    const nodeDeadline = Date.now() + 30_000;
    while (!tree.nodes?.has(nodeId) && Date.now() < nodeDeadline) await new Promise((r) => setTimeout(r, 200));
    assert.ok(tree.nodes?.has(nodeId), 'the invited star admin\'s own createNode never reached its tree');
  } finally {
    waiter.cleanup(); // a leaked waiter's WebSocket keeps Node's event loop alive past the verdict
    try { invitee?.[Symbol.dispose](); } catch { /* already disposed */ }
    admin?.dispose();
  }

  console.error(
    '[invite-roundtrip] mint summary synchronous + URL-free; real letter tagged + delivered; ' +
    'the click logged in with the licensed bit; the star admin acted on its tree through the bypass',
  );
}
