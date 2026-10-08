/**
 * A subscriber who cannot read a resource is told, not refused (ADR-008) — the client half.
 *
 * `.snapshot` resolves `null`, the handle's and the store entry's `deniedNodes` name the node, and
 * `onChange` fires when access is lost or gained. A loss drops the entry's `value` and `meta`, so a
 * `v-model` write to it submits nothing. A client watching the org tree asks again at each tree
 * change, for exactly what its last update denied.
 *
 * Driven through the public API only — `client.resources.subscribe`, and an auto-subscribed read of
 * the store `createNebulaClient` builds — never a `callStar*` initiator, because the unit under test
 * is the client's own state. The member is a real invited login at the Star. The grant-reveals
 * limbs live in `child2-query-permission.test.ts`, and the server's raw denied frame in
 * `star-subscribe.test.ts` and `child2-recheck.test.ts`.
 *
 * In-lane rather than `/live` because each limb reads something a running stack does not show from
 * outside: the plane's subscribe marker, the store's drop warning, a row count after a reap. The
 * grant limb, the one a user sees, also runs live as `grant-reveals-denied`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { effectScope } from '@vue/reactivity';
import { ROOT_NODE_ID } from '@lumenize/resources';
import { CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula';
import type { QueryDescriptor, Snapshot, TransactionResult } from '@lumenize/resources';
import { createNebulaClient } from '@lumenize/resources/frontend';
import {
  adminClientAt, universeAdminClient, browserLogin, foundAndLogin, createSubject, createInvitedClient, ORIGIN, pageOf, ownerOf, addressOfClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const VERSION = 'v1';
const TYPES = [
  'interface TestResource { title: string }',
  'interface Parent { name: string }',
  'interface Child { parent: Parent; label: string }',
].join('\n');
const uuid = () => crypto.randomUUID();
const uniqueStar = () => `den-${uuid().slice(0, 8)}.app.tenant-a`;

let sink: any[] = [];
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e)); });
afterEach(() => clearDebugSink());

async function commit(admin: NebulaClientTest, star: string, ops: Parameters<NebulaClientTest['callStarTransaction']>[2]) {
  admin.callStarTransaction(star, VERSION, ops);
  await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
  expect(admin.lastError).toBeUndefined();
  const result = admin.lastResult as TransactionResult;
  expect(result.ok).toBe(true);
  return (result as { ok: true; eTags: Record<string, string> }).eTags;
}

/**
 * A Star with two sibling nodes under ROOT — `pub`, which the member can read, and `priv`, which
 * they cannot (siblings, so no grant inherits across) — a resource on each, and a member logged in
 * through a `createNebulaClient` factory, which watches the tree like every client it builds.
 */
async function starWithMember() {
  const star = uniqueStar();
  const { client: admin, accessToken } = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  admin.callStarInstallOntology(star, { version: VERSION, types: TYPES });
  await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
  const pub = await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'pub', 'Pub');
  const priv = await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'priv', 'Priv');
  const open = uuid();
  const closed = uuid();
  const eTags = await commit(admin, star, {
    [open]: { op: 'create', typeName: 'TestResource', nodeId: pub, value: { title: 'open' } },
    [closed]: { op: 'create', typeName: 'TestResource', nodeId: priv, value: { title: 'secret' } },
  });

  const adminBrowser = new Browser();
  await createSubject(adminBrowser, star, accessToken, 'member@example.com');
  const browser = new Browser();
  const { payload } = await browserLogin(browser, star, 'member@example.com', star);
  await admin.orgTree.setPermission(pub, payload.sub, 'read');
  const ctx = browser.context(pageOf(star));
  const member = createNebulaClient({
    baseUrl: pageOf(star), platformOrigin: ORIGIN, ontologyVersion: VERSION,
    fetch: ctx.fetch, WebSocket: ctx.WebSocket,
    sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
    onShouldRefreshUI: () => {},
  });
  await member.ready;
  // The factory's tree subscription has answered, so a later tree update is a real change.
  await vi.waitFor(() => expect((member.store.lmz.orgTree.value as { nodes?: unknown })?.nodes).toBeInstanceOf(Map));
  return { star, admin, member, memberSub: payload.sub, pub, priv, open, closed, eTags };
}

const entry = (member: { store: Record<string, any> }, rid: string) => member.store.resources.TestResource?.[rid];

describe('a subscriber who cannot read a resource is told, not refused — the client', () => {
  it('a no-read subscribe resolves null, and its handle and store entry name the node; a reader\'s name none', async () => {
    const { member, priv, open, closed } = await starWithMember();

    using denied = member.client.resources.subscribe('TestResource', closed);
    // Mutation: treat the denied frame as a snapshot or an Error → this resolves otherwise → red.
    expect(await denied.snapshot).toBeNull();
    expect(denied.deniedNodes).toEqual([priv]);
    // Mutation: don't mirror the denial into the store → the entry never names the node → red.
    expect(entry(member, closed)?.deniedNodes).toEqual([priv]);
    expect(entry(member, closed)?.value).toBeUndefined();

    using readable = member.client.resources.subscribe('TestResource', open);
    expect(((await readable.snapshot) as Snapshot).value).toEqual({ title: 'open' });
    expect(readable.deniedNodes).toEqual([]);
    expect(entry(member, open)?.deniedNodes).toEqual([]);
    expect(entry(member, open)?.value).toEqual({ title: 'open' });
  });

  it('an auto-subscribed store read of a no-read resource is told too, and raises no auto-subscribe warning', async () => {
    const { member, priv, closed } = await starWithMember();

    const scope = effectScope();
    scope.run(() => entry(member, closed)?.value); // the read that auto-subscribes
    await vi.waitFor(() => expect(entry(member, closed)?.deniedNodes).toEqual([priv]));
    expect(entry(member, closed)?.value).toBeUndefined();
    // A permission denial is not a failed subscribe: `.snapshot` resolved `null` rather than
    // rejecting, so the factory logged nothing. Mutation: reject `.snapshot` for a denial → the
    // warning appears → red.
    await member.client.resources.read('TestResource', closed).catch(() => {}); // a round trip, so any warning has landed
    expect(sink.filter((e) => e.message === 'auto-subscribe failed')).toEqual([]);
    scope.stop();
  });

  it('an established handle turns denied after a revoke and a write: onChange fires, the entry keeps nothing, and a v-model write submits nothing', async () => {
    const { star, admin, member, memberSub, pub, open, eTags } = await starWithMember();

    using handle = member.client.resources.subscribe('TestResource', open);
    await handle.snapshot;
    let changes = 0;
    handle.onChange(() => { changes++; });
    expect(entry(member, open)?.meta?.eTag).toBe(eTags[open]);

    // Revoke, then write. The loss shows at the next update, not at the revoke.
    await admin.orgTree.revokePermission(pub, memberSub);
    await commit(admin, star, { [open]: { op: 'put', eTag: eTags[open], value: { title: 'after-revoke' } } });

    // Mutations: drop the client's handling of an established subscription, or skip onChange → red.
    await vi.waitFor(() => expect(handle.deniedNodes).toEqual([pub]));
    expect(changes).toBe(1);
    // Mutations: don't mirror the denial into the store, or keep the eTag on a loss → red.
    expect(entry(member, open)?.deniedNodes).toEqual([pub]);
    expect(entry(member, open)?.value).toBeUndefined();
    expect(entry(member, open)?.meta?.eTag).toBeUndefined();

    // A v-model write to the denied entry: dropped at the middleware, since there is no eTag to
    // submit against, and nothing it could have committed appears.
    entry(member, open).value = { title: 'hijack' };
    member.flush();
    expect(sink.filter((e) => e.message === 'synced-state write dropped: this subscriber cannot read the resource'
      && e.data?.rid === open)).toHaveLength(1);
    expect(entry(member, open)?.meta?.eTag).toBeUndefined();
    admin.callStarRead(star, VERSION, open);
    await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
    expect((admin.lastResult as Snapshot).value).toEqual({ title: 'after-revoke' });
  });

  it('a tree change re-subscribes exactly what was denied — one subscribe, not one per subscription', async () => {
    const { admin, member, priv, open, closed } = await starWithMember();
    const clientAddress = addressOfClient(member.client);
    // A query with no results, so it has nothing to deny.
    const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: uuid() };

    using readable = member.client.resources.subscribe('TestResource', open);
    await readable.snapshot;
    using denied = member.client.resources.subscribe('TestResource', closed);
    await denied.snapshot;
    expect(denied.deniedNodes).toEqual([priv]); // positive control: one subscription IS denied
    using q = member.client.resources.subscribeQuery(query);
    await q.ready;
    expect(q.deniedNodes).toEqual([]); // …and the query is not

    const subscribes = () => sink.filter((e) => e.namespace === 'nebula.Resources.subscribers'
      && (e.data?.event === 'subscribe-resource' || e.data?.event === 'subscribe') && e.data?.clientAddress === clientAddress);
    sink.length = 0;
    await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'unrelated', 'Unrelated');
    await vi.waitFor(() => expect(subscribes().length).toBeGreaterThanOrEqual(1));
    // A round trip on the same socket, so every re-subscribe the tree change caused has landed.
    await member.client.resources.read('TestResource', open);
    // Mutations: run #restoreSubscriptions on each tree update (3), or drop the ask-again (0) → red.
    expect(subscribes().map((e) => e.data.resourceId)).toEqual([closed]);
    expect(denied.deniedNodes).toEqual([priv]); // still denied: nothing changed but the tree
  });

  it('a denied resource subscriber that disconnects is reaped at the next write — on a Star', async () => {
    const { star, admin, closed, eTags } = await starWithMember();
    const rows = async (clientAddress: string) => (runInDurableObject as any)((env as any).STAR.getByName(star), (_i: any, c: any) =>
      c.storage.sql.exec(`SELECT COUNT(*) AS n FROM Subscriptions WHERE kind = 'resource' AND topic = ? AND clientAddress = ?`,
        closed, clientAddress).toArray()[0].n as number);

    const adminBrowser = new Browser();
    const { accessToken } = await foundAndLogin(adminBrowser, star, ownerOf('admin@example.com'), star);
    await createSubject(adminBrowser, star, accessToken, 'doomed@example.com');
    const { client: doomed } = await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'doomed@example.com');
    expect(await doomed.resources.subscribe('TestResource', closed).snapshot).toBeNull();
    const doomedAddress = addressOfClient(doomed);
    expect(await rows(doomedAddress)).toBe(1);

    doomed.disconnect();
    await vi.waitFor(() => expect(doomed.connectionState).toBe('disconnected'));
    await commit(admin, star, { [closed]: { op: 'put', eTag: eTags[closed], value: { title: 'next' } } });
    // Mutation: send the denied update without the resource reaper → the row stays → red.
    await vi.waitFor(async () => expect(await rows(doomedAddress)).toBe(0));
  });

  it('a denied resource subscriber that disconnects is reaped at the next write — on a Galaxy', async () => {
    const scope = `den-${uuid().slice(0, 8)}.app`;
    const chatPair = { resourceHostBinding: 'GALAXY' } as const;
    const { client: admin, accessToken } = await universeAdminClient(
      NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, chatPair);
    const chat = uuid();
    const nodeB = await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'b', 'B');
    const m = uuid();
    expect((await admin.resources.transaction({
      [m]: { op: 'create', typeName: 'Message', nodeId: nodeB, value: { chat, content: 'm' } },
    })).kind).toBe('committed');
    const rows = async (clientAddress: string) => (runInDurableObject as any)((env as any).GALAXY.getByName(scope), (_i: any, c: any) =>
      c.storage.sql.exec(`SELECT COUNT(*) AS n FROM Subscriptions WHERE kind = 'resource' AND topic = ? AND clientAddress = ?`,
        m, clientAddress).toArray()[0].n as number);

    const adminBrowser = new Browser();
    await createSubject(adminBrowser, scope, accessToken, 'doomed@example.com');
    const { client: doomed } = await createInvitedClient(
      NebulaClientTest, new Browser(), scope, scope, 'doomed@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, chatPair);
    expect(await doomed.resources.subscribe('Message', m).snapshot).toBeNull();
    const doomedAddress = addressOfClient(doomed);
    expect(await rows(doomedAddress)).toBe(1);

    doomed.disconnect();
    await vi.waitFor(() => expect(doomed.connectionState).toBe('disconnected'));
    const current = await admin.resources.read('Message', m) as Snapshot;
    expect((await admin.resources.transaction({
      [m]: { op: 'put', typeName: 'Message', eTag: current.meta.eTag, value: { chat, content: 'm2' } },
    })).kind).toBe('committed');
    await vi.waitFor(async () => expect(await rows(doomedAddress)).toBe(0));
  });
});

