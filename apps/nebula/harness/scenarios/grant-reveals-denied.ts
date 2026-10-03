/**
 * **A grant reveals what a member was denied, with no write — on a real Star, to a real member.**
 *
 * A subscriber who cannot read a resource is told, not refused: its store entry names the node and
 * holds no content. The server re-runs nothing on a permission change, so what delivers a later
 * grant is the client itself. Every client `createNebulaClient` builds watches the org tree, and at
 * each tree change it re-subscribes exactly what its last update denied. This scenario walks that
 * end to end with nothing hand-built: a real login, a real invite email, a factory client
 * refreshing on the member's own cookie, and an ontology that arrives by the real Apply.
 *
 *  1. The member, invited to the `pub` node only, subscribes to an Item on the sibling `priv` node.
 *     The subscribe is not refused: `.snapshot` resolves `null`, and the store entry names `priv`
 *     and holds no value.
 *  2. The admin grants the member `read` on `priv` and writes nothing. The member's store gains the
 *     Item's content, its `deniedNodes` empties, and the handle's `onChange` fires once.
 *     *Live-mutation-checked: drop the client's ask-again and this limb reds while limb 1 stays
 *     green (run 2026-09-28).*
 *
 * `needsContainer = true` — the Apply compiles the seed ontology in the build container, since a
 * Star serves resources only for an installed ontology. The in-lane twins, one mutation per limb,
 * are `nebula-client-denied.test.ts` and `child2-query-permission.test.ts`.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import { createNebulaClient } from '@lumenize/nebula/frontend';
import type { Galaxy, Star, NodeInviteAck } from '@lumenize/nebula';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar, scopeUrlOf } from '../lib/harness';
import { sharedApp } from '../lib/shared-app';
import { testSlug } from '../lib/test-scopes';
import { refreshAccessToken } from '../../test/lib/email-login';
import { provisionAndLogin, acceptInviteAndLogin } from '../../test/lib/email-login';

export const needsContainer = true;

/** Retry an op the Star answers `installing` while its first-touch pull of the ontology lands —
 *  returned as a value by `transaction`, thrown by other entries, so both are read. */
async function whileInstalling<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt++) {
    let outcome: unknown;
    try { outcome = await op(); } catch (e) { outcome = e; }
    const installing = (outcome as Error)?.name === 'OntologyStaleError' && (outcome as { installing?: boolean }).installing;
    if (!installing) {
      if (outcome instanceof Error) throw outcome;
      return outcome as T;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the Star never finished installing the ontology');
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  // A tenant Star of this scenario's own, beneath the run's shared app, founded by its owner.
  const app = await sharedApp(stack, testToken);
  const star = `${app.galaxy}.${testSlug('grd')}`;
  const memberEmail = uniqueTestEmail();

  const adminSession = await provisionAndLogin({ baseUrl: origin, scope: star, email: app.ownerEmail, testToken });
  let admin: Driver | undefined;
  let member: ReturnType<typeof createNebulaClient> | undefined;
  const memberBrowser = new Browser();
  const waiter = waitForEmail({ testToken, instance: star, to: memberEmail, timeout: 60_000 });
  try {
    admin = await connectDriver(stack, {
      scope: star,
      session: { accessToken: adminSession.accessToken, sub: adminSession.sub },
    });

    // The ontology arrives by the REAL path: the dev Apply on the parent Galaxy, asked from Studio,
    // the galaxy's own page (the host rule), then the Star's first-touch pull when an op needs it.
    const galaxy = star.split('.').slice(0, 2).join('.');
    const studio = await connectDriver(stack, { scope: galaxy, session: await refreshAccessToken(origin, adminSession.session, galaxy) });
    let version: string;
    try {
      ({ version } = await studio.client.lmz.callAsync(
        'GALAXY', galaxy, studio.client.ctn<Galaxy>().applyOntology(), { timeoutMs: 240_000 },
      ) as { version: string });
    } finally {
      studio.dispose();
    }

    const pub = await admin.client.orgTree.createNode(crypto.randomUUID(), ROOT_NODE_ID, 'pub', 'Pub');
    const priv = await admin.client.orgTree.createNode(crypto.randomUUID(), ROOT_NODE_ID, 'priv', 'Priv');
    const item = crypto.randomUUID();
    const created = await whileInstalling(() => admin!.client.lmz.callAsync('STAR', star, admin!.client.ctn<Star>().resources.transaction(
      version, crypto.randomUUID(),
      { [item]: { op: 'create', typeName: 'Item', nodeId: priv, value: { title: 'behind the grant' } } },
    )) as Promise<{ ok: boolean }>);
    assert.equal(created.ok, true, `the admin's create of the Item failed: ${JSON.stringify(created)}`);

    // The member is invited to `pub` only — a sibling of `priv`, so no grant reaches it.
    const ack = await admin.client.lmz.callAsync(
      'STAR', star, admin.client.ctn<Star>().resources.invite(pub, [{ email: memberEmail, tier: 'read' }]),
    ) as NodeInviteAck;
    assert.deepEqual(ack, { accepted: 1, errors: [] }, `node invite ack: ${JSON.stringify(ack)}`);
    const mail = await waiter.emailPromise;
    const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(mail.html ?? '')?.[1];
    assert.ok(href, 'the invite email carried no magic link');
    await acceptInviteAndLogin({
      baseUrl: origin, inviteLink: href.replace(/&amp;/g, '&'), scope: star, fetchImpl: memberBrowser.fetch,
    });

    // A factory client on the Star's own page, refreshing on the member's own cookie against the
    // platform host — the production shape, which watches the org tree by construction.
    const ctx = memberBrowser.context(scopeUrlOf(stack, star));
    member = createNebulaClient({
      baseUrl: scopeUrlOf(stack, star), platformOrigin: stack.baseUrl, ontologyVersion: version,
      fetch: ctx.fetch, sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
      onShouldRefreshUI: () => {},
    });
    await member.ready;
    const memberSub = member.client.claims.sub;

    // ── LIMB 1: told, not refused ─────────────────────────────────────────────────────────────
    const handle = member.client.resources.subscribe('Item', item);
    assert.equal(await handle.snapshot, null, 'a no-read subscribe must resolve null, never the content');
    assert.deepEqual(handle.deniedNodes, [priv], 'the handle must name the node the member cannot read');
    const entry = () => member!.store.resources.Item[item] as { value?: { title?: string }; deniedNodes?: string[] };
    assert.deepEqual(entry().deniedNodes, [priv], 'the store entry must name the node too');
    assert.equal(entry().value, undefined, 'the store entry must hold no content while denied');
    let changes = 0;
    handle.onChange(() => { changes++; });
    console.error('  ✓ limb 1 — the member is told the node it cannot read; nothing of the Item reached its store');

    // ── LIMB 2: a grant, with no write, reveals it ────────────────────────────────────────────
    await admin.client.orgTree.setPermission(priv, memberSub, 'read');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && entry().value?.title !== 'behind the grant') {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(entry().value?.title, 'behind the grant',
      'after a grant with no write, the member\'s store must gain the content — the client asks again at the tree change');
    assert.deepEqual(entry().deniedNodes, [], 'deniedNodes must empty once the member can read');
    assert.deepEqual(handle.deniedNodes, []);
    assert.equal(changes, 1, 'onChange must fire exactly once, for the gain');
    console.error('  ✓ limb 2 — the grant alone revealed the Item: the store gained it and deniedNodes emptied');
    handle[Symbol.dispose]();
  } finally {
    waiter.cleanup(); // a leaked waiter's WebSocket keeps Node's event loop alive past the verdict
    try { await member?.dispose(); } catch { /* already disposed */ }
    try { member?.client[Symbol.dispose](); } catch { /* already disposed */ }
    admin?.dispose();
  }
}
