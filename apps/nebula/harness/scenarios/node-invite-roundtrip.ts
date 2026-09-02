/**
 * **Scenario 5 on real infrastructure — a node invite writes BOTH planes, walked as the invitee.**
 * `Star.invite(nodeId, …)` → pending `_InviteStatus` → facade → Registry mint → REAL email through
 * the catch-all → the invitee clicks, logs in AT the star, and acts at the node under the grant
 * written at invite time — nothing left to apply on arrival (the whole point of the design).
 *
 * Six limbs; the isolating mutations for the shared code paths live in the in-lane twin
 * (`apps/nebula/test/test-apps/baseline/node-invite.test.ts`, mutation-checked per criterion —
 * grant write, already-member heal, validation, the no-bit cap, convergence, the flip). What only
 * THIS tier adds is fixture-freedom + the real mail: the ontology arrives by the REAL path —
 * the dev Apply on the parent Galaxy (a container compile of the seed ontology) and then the
 * Star's server-originated FIRST-TOUCH pull-current, exercised by inviting before anyone has
 * ever used the app (the invite answers `installing` and the retry converges) — the letter is
 * the one that actually arrived, and the login is a real click.
 *
 *  1. The ack returns from `callAsync` with `{ accepted, errors: [] }` — after the first-touch
 *     install converges, which is this limb's other half: a fresh Star with no client op ever
 *     seen installs the Galaxy's current ontology because an INVITE needed it.
 *  2. The REAL letter arrives — `invite-new`-shaped, tagged with the STAR scope (the membership's
 *     scope, not the node), carrying the accept-invite link.
 *  3. Clicking THAT link logs in AT the star; the JWT carries `authScope = star` and NO
 *     `scopeAdmin` — the node path mints no admin (the cap in degenerate form).
 *  4. The invitee's first WRITE at the node commits — the invite-time grant authorizes it.
 *     *Live-mutation-checked: suppress the handler's grant write → this limb reds while 1–3 stay
 *     green (run 2026-08-19).*
 *  5. The `_InviteStatus` row reached `sent`, read back through the public query + read path.
 *  6. A negative control: a SECOND real member of the star with no node invite is refused the same
 *     write — proving limb 4 was the grant, not an open node.
 *
 * `needsContainer = true` — the Apply compiles the seed ontology in the build container.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import { NebulaClient, ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { Galaxy, Star, NodeInviteAck } from '@lumenize/nebula';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, inviteViaMesh, readDevVar } from '../lib/harness';
import {
  provisionAndLogin, pointLinkAt, refreshAccessToken, acceptInviteAndLogin,
} from '../../test/lib/email-login';
import { parseJwtUnsafe } from '@lumenize/crypto';

export const needsContainer = true;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const suffix = crypto.randomUUID().slice(0, 8);
  const star = `ninv-${suffix}.app.tenant`;
  const inviteeEmail = uniqueTestEmail();

  const adminSession = await provisionAndLogin({ baseUrl: origin, scope: star, testToken });
  let admin: Driver | undefined;
  let invitee: NebulaClient | undefined;
  const inviteeBrowser = new Browser();
  const waiter = waitForEmail({ testToken, instance: star, to: inviteeEmail, timeout: 60_000 });
  try {
    admin = await connectDriver(stack, {
      scope: star,
      session: { accessToken: adminSession.accessToken, sub: adminSession.sub },
    });

    // A running Star needs an installed ontology for ANY resource write — and it arrives by the
    // REAL path, never a direct set. The dev Apply on the parent Galaxy compiles the SEED
    // ontology in the build container and appends it to the registry (`provisionAndLogin`'s
    // identity is a UNIVERSE admin, so dominion covers the galaxy); the Star then has NOTHING
    // installed until the invite itself triggers the first-touch pull-current below.
    // _InviteStatus rides every version (platform-unioned).
    const galaxy = star.split('.').slice(0, 2).join('.');
    const appended = await admin.client.lmz.callAsync(
      'GALAXY', galaxy, admin.client.ctn<Galaxy>().appendWorkspaceOntology(),
      { timeoutMs: 240_000 },
    ) as { version: string };
    assert.ok(appended.version.length > 0, 'the Apply should return the appended seed version');

    // ── LIMB 1: the ack, via the first-touch install ──────────────────────────────────────────
    // The FIRST invite lands on a Star that has never seen a client op: the gate answers
    // `installing` (structured-clone keeps name + props across the mesh) and fires the
    // pull-current at the Galaxy; the retry converges once the row installs. A non-`installing`
    // error is a real failure and rethrows.
    let ack: NodeInviteAck | undefined;
    for (let attempt = 0; attempt < 20 && !ack; attempt++) {
      try {
        ack = await admin.client.lmz.callAsync(
          'STAR', star,
          admin.client.ctn<Star>().invite(ROOT_NODE_ID, [{ email: inviteeEmail, tier: 'write' }]),
        );
      } catch (e) {
        const stale = (e as Error)?.name === 'OntologyStaleError' && (e as { installing?: boolean }).installing;
        if (!stale) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    assert.ok(ack, 'invite never converged — the first-touch pull-current did not install the seed ontology');
    assert.deepEqual(ack, { accepted: 1, errors: [] }, `node invite ack: ${JSON.stringify(ack)}`);

    // ── LIMB 2: the real letter — tagged with the STAR (the membership's scope) ────────────────
    const mail = await waiter.emailPromise;
    assert.equal(mail.instance, star, `invite mail tagged "${mail.instance ?? 'undefined'}", wanted the star`);
    const html = mail.html ?? '';
    const href = /href="([^"]*accept-invite[^"]*invite_token[^"]*)"/.exec(html)?.[1];
    assert.ok(href, `invite email carried no accept-invite link (starts: ${html.slice(0, 60)})`);
    const link = pointLinkAt(origin, href.replace(/&amp;/g, '&'));

    // ── LIMB 3: the click IS the login, at the star, with NO admin bit ─────────────────────────
    const { refreshToken } = await acceptInviteAndLogin({
      baseUrl: origin, inviteLink: link, scope: star, fetchImpl: inviteeBrowser.fetch,
    });
    const inviteeSession = await refreshAccessToken(
      origin, { refreshToken, authScope: star }, star, inviteeBrowser.fetch,
    );
    const claims = parseJwtUnsafe(inviteeSession.accessToken)!.payload as any;
    assert.equal(claims.access.authScope, star, "the invitee's authScope must be the star");
    assert.equal(claims.access.scopeAdmin, undefined, 'the node path must mint NO admin bit');

    // ── LIMB 4: the first write at the node commits under the invite-time grant ────────────────
    const ctx = inviteeBrowser.context(stack.baseUrl);
    invitee = new NebulaClient({
      baseUrl: stack.baseUrl,
      authScope: star,
      activeScope: star,
      ontologyVersion: appended.version,
      accessToken: inviteeSession.accessToken,
      instanceName: `${inviteeSession.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: inviteeBrowser.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
    });
    const deadline = Date.now() + 30_000;
    let committed = false;
    let lastKind = '';
    while (Date.now() < deadline && !committed) {
      const outcome = await invitee.resources.transaction({
        [crypto.randomUUID()]: {
          op: 'create', typeName: 'Item', nodeId: ROOT_NODE_ID,
          value: { title: 'written under the invite-time grant' },
        },
      });
      lastKind = outcome.kind;
      if (outcome.kind === 'committed') { committed = true; break; }
      await new Promise((r) => setTimeout(r, 500)); // the traveling handler may still be landing
    }
    assert.ok(committed, `the invitee's write never committed (last outcome: ${lastKind}) — the invite-time grant is missing`);

    // ── LIMB 5: the _InviteStatus row reached `sent` (the public query + read path) ─────────────
    const sub = invitee.resources.subscribeQuery({
      queryType: 'parentChild', typeName: '_InviteStatus', field: 'node', value: ROOT_NODE_ID,
    });
    await sub.ready;
    assert.ok(sub.resourceIds.length >= 1, 'no _InviteStatus row visible at the node');
    let state: string | undefined;
    for (const id of sub.resourceIds) {
      const snapshot = await invitee.resources.read('_InviteStatus', id);
      const v = snapshot?.value as { email?: string; state?: string } | undefined;
      if (v?.email === inviteeEmail) state = v.state;
    }
    sub[Symbol.dispose]();
    assert.equal(state, 'sent', `the (email, node) _InviteStatus row holds "${state ?? 'no row'}", wanted "sent"`);

    // ── LIMB 6: negative control — a member with NO node invite is refused the same write ──────
    const outsiderEmail = uniqueTestEmail();
    await inviteViaMesh(stack, adminSession, star, [{ email: outsiderEmail }]); // scope member, no grant
    const outsiderMail = await (async () => {
      const w = waitForEmail({ testToken, instance: star, to: outsiderEmail, timeout: 60_000 });
      try { return await w.emailPromise; } finally { w.cleanup(); }
    })();
    const outsiderHref = /href="([^"]*accept-invite[^"]*invite_token[^"]*)"/.exec(outsiderMail.html ?? '')?.[1];
    assert.ok(outsiderHref, 'the outsider control never received an invite link');
    const outsiderBrowser = new Browser();
    const { refreshToken: outsiderCookie } = await acceptInviteAndLogin({
      baseUrl: origin,
      inviteLink: pointLinkAt(origin, outsiderHref.replace(/&amp;/g, '&')),
      scope: star,
      fetchImpl: outsiderBrowser.fetch,
    });
    const outsiderSession = await refreshAccessToken(
      origin, { refreshToken: outsiderCookie, authScope: star }, star, outsiderBrowser.fetch,
    );
    const octx = outsiderBrowser.context(stack.baseUrl);
    const outsider = new NebulaClient({
      baseUrl: stack.baseUrl,
      authScope: star,
      activeScope: star,
      ontologyVersion: appended.version,
      accessToken: outsiderSession.accessToken,
      instanceName: `${outsiderSession.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: outsiderBrowser.fetch,
      sessionStorage: octx.sessionStorage,
      BroadcastChannel: octx.BroadcastChannel,
    });
    try {
      const refused = await outsider.resources.transaction({
        [crypto.randomUUID()]: {
          op: 'create', typeName: 'Item', nodeId: ROOT_NODE_ID, value: { title: 'should be denied' },
        },
      });
      assert.equal(
        refused.kind, 'rejected',
        `a scope member with NO node invite wrote at the node (${refused.kind}) — limb 4 would be ` +
        'proving an open node, not the grant',
      );
    } finally {
      try { outsider[Symbol.dispose](); } catch { /* already disposed */ }
      octx.close();
    }
  } finally {
    waiter.cleanup(); // a leaked waiter's WebSocket keeps Node's event loop alive past the verdict
    try { invitee?.[Symbol.dispose](); } catch { /* already disposed */ }
    admin?.dispose();
  }

  console.error(
    '[node-invite-roundtrip] ack synchronous; real letter tagged + delivered; click logged in ' +
    'bit-less at the star; the invite-time grant authorized the first write; _InviteStatus reached ' +
    'sent; the un-granted control was refused',
  );
}
