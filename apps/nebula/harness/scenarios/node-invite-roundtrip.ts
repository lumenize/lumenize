/**
 * **Scenario 5 on real infrastructure — a node invite writes BOTH planes, walked as the invitee.**
 * `Star.invite(nodeId, …)` → pending `InviteStatus` → facade → Registry mint → REAL email through
 * the catch-all → the invitee clicks, logs in AT the star, and acts at the node under the grant
 * written at invite time — nothing left to apply on arrival (the whole point of the design).
 *
 * Six limbs; the isolating mutations for the shared code paths live in the in-lane twin
 * (`apps/nebula/test/test-apps/baseline/node-invite.test.ts`, mutation-checked per criterion —
 * grant write, already-member heal, validation, the no-bit cap, convergence, the flip). What only
 * THIS tier adds is fixture-freedom + the real mail: the ontology is installed on a running Star,
 * the letter is the one that actually arrived, and the login is a real click.
 *
 *  1. The ack returns synchronously from `callAsync` with `{ accepted, errors: [] }`.
 *  2. The REAL letter arrives — `invite-new`-shaped, tagged with the STAR scope (the membership's
 *     scope, not the node), carrying the accept-invite link.
 *  3. Clicking THAT link logs in AT the star; the JWT carries `authScope = star` and NO
 *     `scopeAdmin` — the node path mints no admin (the cap in degenerate form).
 *  4. The invitee's first WRITE at the node commits — the invite-time grant authorizes it.
 *     *Live-mutation-checked: suppress the handler's grant write → this limb reds while 1–3 stay
 *     green (run 2026-08-19).*
 *  5. The `InviteStatus` row reached `sent`, read back through the public query + read path.
 *  6. A negative control: a SECOND real member of the star with no node invite is refused the same
 *     write — proving limb 4 was the grant, not an open node.
 *
 * `needsContainer = false` — auth + resources only, never a build, so the boot skips Docker.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import { NebulaClient, ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { Star, NodeInviteAck } from '@lumenize/nebula';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, inviteViaMesh, readDevVar } from '../lib/harness';
import { provisionAndLogin, pointLinkAt, refreshAccessToken } from '../../test/lib/email-login';
import { compileOntologyVersion } from '../../src/ontology-compile';
import { parseJwtUnsafe } from '@lumenize/crypto';

export const needsContainer = false;

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

    // A running Star needs an installed ontology for ANY resource write (a production Star always
    // has its app's) — compiled here in Node off the same leaf the Worker uses, installed through
    // the admin-gated mesh entry. InviteStatus rides every version (platform-unioned).
    const row = compileOntologyVersion({
      version: `live-${suffix}`,
      types: 'interface TestResource { title: string }',
    });
    await admin.client.lmz.callAsync('STAR', star, admin.client.ctn<Star>().setOntology(row));

    // ── LIMB 1: the synchronous ack ───────────────────────────────────────────────────────────
    const ack: NodeInviteAck = await admin.client.lmz.callAsync(
      'STAR', star,
      admin.client.ctn<Star>().invite(ROOT_NODE_ID, [{ email: inviteeEmail, tier: 'write' }]),
    );
    assert.deepEqual(ack, { accepted: 1, errors: [] }, `node invite ack: ${JSON.stringify(ack)}`);

    // ── LIMB 2: the real letter — tagged with the STAR (the membership's scope) ────────────────
    const mail = await waiter.emailPromise;
    assert.equal(mail.instance, star, `invite mail tagged "${mail.instance ?? 'undefined'}", wanted the star`);
    const html = mail.html ?? '';
    const href = /href="([^"]*accept-invite[^"]*invite_token[^"]*)"/.exec(html)?.[1];
    assert.ok(href, `invite email carried no accept-invite link (starts: ${html.slice(0, 60)})`);
    const link = pointLinkAt(origin, href.replace(/&amp;/g, '&'));

    // ── LIMB 3: the click IS the login, at the star, with NO admin bit ─────────────────────────
    const clicked = await inviteeBrowser.fetch(link, { redirect: 'manual' });
    const setCookie = clicked.headers.getSetCookie?.() ?? [clicked.headers.get('set-cookie') ?? ''];
    const refreshToken = setCookie
      .map((c) => /(?:^|;\s*)refresh-token=([^;]*)/.exec(c)?.[1])
      .find(Boolean);
    assert.ok(refreshToken, `accept-invite (${clicked.status}) set no refresh-token cookie`);
    const inviteeSession = await refreshAccessToken(
      origin, { refreshToken: refreshToken!, authScope: star }, star, inviteeBrowser.fetch,
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
      appVersion: `live-${suffix}`,
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
          op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID,
          value: { title: 'written under the invite-time grant' },
        },
      });
      lastKind = outcome.kind;
      if (outcome.kind === 'committed') { committed = true; break; }
      await new Promise((r) => setTimeout(r, 500)); // the traveling handler may still be landing
    }
    assert.ok(committed, `the invitee's write never committed (last outcome: ${lastKind}) — the invite-time grant is missing`);

    // ── LIMB 5: the InviteStatus row reached `sent` (the public query + read path) ─────────────
    const sub = invitee.resources.subscribeQuery({
      queryType: 'parentChild', typeName: 'InviteStatus', field: 'node', value: ROOT_NODE_ID,
    });
    await sub.ready;
    assert.ok(sub.resourceIds.length >= 1, 'no InviteStatus row visible at the node');
    let state: string | undefined;
    for (const id of sub.resourceIds) {
      const snapshot = await invitee.resources.read('InviteStatus', id);
      const v = snapshot?.value as { email?: string; state?: string } | undefined;
      if (v?.email === inviteeEmail) state = v.state;
    }
    sub[Symbol.dispose]();
    assert.equal(state, 'sent', `the (email, node) InviteStatus row holds "${state ?? 'no row'}", wanted "sent"`);

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
    const outsiderClicked = await outsiderBrowser.fetch(pointLinkAt(origin, outsiderHref.replace(/&amp;/g, '&')), { redirect: 'manual' });
    const outsiderCookie = (outsiderClicked.headers.getSetCookie?.() ?? [outsiderClicked.headers.get('set-cookie') ?? ''])
      .map((c) => /(?:^|;\s*)refresh-token=([^;]*)/.exec(c)?.[1]).find(Boolean);
    assert.ok(outsiderCookie, 'the outsider control could not log in');
    const outsiderSession = await refreshAccessToken(
      origin, { refreshToken: outsiderCookie!, authScope: star }, star, outsiderBrowser.fetch,
    );
    const octx = outsiderBrowser.context(stack.baseUrl);
    const outsider = new NebulaClient({
      baseUrl: stack.baseUrl,
      authScope: star,
      activeScope: star,
      appVersion: `live-${suffix}`,
      accessToken: outsiderSession.accessToken,
      instanceName: `${outsiderSession.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: outsiderBrowser.fetch,
      sessionStorage: octx.sessionStorage,
      BroadcastChannel: octx.BroadcastChannel,
    });
    try {
      const refused = await outsider.resources.transaction({
        [crypto.randomUUID()]: {
          op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'should be denied' },
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
    'bit-less at the star; the invite-time grant authorized the first write; InviteStatus reached ' +
    'sent; the un-granted control was refused',
  );
}
