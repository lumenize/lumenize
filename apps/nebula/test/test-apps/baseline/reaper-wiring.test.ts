/**
 * Every update the plane sends that names a reaper reaps the tab its Gateway reports gone — one
 * limb per wiring site, each asserting the persisted row.
 *
 * A limb per SITE, not per kind of subscription, because of how a reap fails. A reaper runs locally
 * on the host that broadcast, where a handler's throw is only logged, and every reaper takes
 * `(string, result?)`, so a continuation naming the WRONG reaper compiles and fails silently.
 * `ResourcesHost` makes a MISNAMED reaper fail to compile (the `@ts-expect-error` below); only a
 * row assertion per site catches a wrong one.
 *
 * Why pool-workers rather than `/live`: the rows are server-internal state no client can read, and
 * reading them takes `runInDurableObject`. The path under test — the real Gateway reporting a
 * closed socket, the plane's broadcast, the reaper on the host's `resourcesResults` — runs unchanged
 * in this lane.
 *
 * The six broadcasts to live subscribers that wire a reaper, all in the plane — the denied
 * resource update wires `onBroadcastResult` too, and is `nebula-client-denied.test.ts`'s; the
 * one-tab stale and rejected answers ride the same `#sendQueryUpdate` / `#sendRoster` helpers:
 *   1. a resource update to its subscribers                      → onBroadcastResult
 *   2. a query update to subscribers who can read every result   → onQueryBroadcastResult
 *   3. a roster update to a query's watchers                     → onQuerySubscriberListBroadcastResult
 *   4. a tree update to tree subscribers                         → onTreeBroadcastResult
 *   5. a query update to one subscriber missing some results     → onQueryBroadcastResult, on each host
 *   6. the initial roster to one new watcher                     → onQuerySubscriberListBroadcastResult
 *
 * ⓘ Site 6 cannot be made to fail deterministically in this lane: it is sent inside the watcher's
 * own subscribe call, while that tab's socket is open, so no ordering a test controls makes the
 * delivery fail. It shares its send with site 3 (`#sendRoster`), which limb 3 exercises.
 *
 * Each limb subscribes the doomed tab through the public API, confirms the row exists, closes the
 * tab (`disconnect()` sends no unsubscribe — the row stays until a reaper takes it), then causes
 * the update and waits for the row to go. Mutation per limb: point its site's `onResult` at a
 * different reaper, or drop it, and exactly that limb reds.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { newContinuation } from '@lumenize/mesh';
import type { Continuation } from '@lumenize/mesh';
import { ROOT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula';
import type { QueryDescriptor, ResourcesHost, SubscriptionKind, TransactionResult } from '@lumenize/nebula';
import {
  adminClientAt, universeAdminClient, createInvitedClient, createSubject, foundAndLogin, uniqueStar,
} from '../../test-helpers';
import { NebulaClientTest } from './index';

const VERSION = 'v1';
const TYPES = [
  'interface Parent { name: string }',
  'interface Child { parent: Parent; label: string }',
].join('\n');

// ── Compile time: a continuation naming a reaper `ResourcesHost` lacks does not compile ──────
// The plane builds every reaper continuation as `this.#ctn<ResourcesHost>()`; this is that shape.
// `npm run type-check` enforces it: a stale directive — the name became valid, or the helper lost
// its typing — fails the check. Never invoked; it exists to be type-checked.
const typedCtn = <T,>() => newContinuation() as Continuation<T>;
void (() => {
  // @ts-expect-error — `onBroadcastResults` is not a reaper on ResourcesHost's results
  typedCtn<ResourcesHost>().resourcesResults.onBroadcastResults('resource-id');
  typedCtn<ResourcesHost>().resourcesResults.onBroadcastResult('resource-id');
});

const uuid = () => crypto.randomUUID();

/** Rows of one kind a client holds in a host's `Subscriptions` table. */
async function rows(binding: 'STAR' | 'GALAXY', instance: string, kind: SubscriptionKind, clientId: string): Promise<number> {
  const stub: any = (env as any)[binding].getByName(instance);
  return (runInDurableObject as any)(stub, (_i: any, c: any) =>
    c.storage.sql.exec('SELECT COUNT(*) AS n FROM Subscriptions WHERE kind = ? AND clientId = ?', kind, clientId)
      .toArray()[0].n as number);
}

/** Close a tab without unsubscribing, and wait until it is closed. */
async function close(client: NebulaClientTest): Promise<void> {
  client.disconnect();
  await vi.waitFor(() => expect(client.connectionState).toBe('disconnected'));
}

async function commit(client: NebulaClientTest, star: string, ops: Parameters<NebulaClientTest['callStarTransaction']>[2]): Promise<void> {
  await client.callStarTransaction(star, VERSION, ops);
  await vi.waitFor(() => expect(client.callCompleted).toBe(true));
  expect(client.lastError).toBeUndefined();
  expect((client.lastResult as TransactionResult).ok).toBe(true);
}

/** A Star with the Parent/Child ontology, its star-scoped admin, and one Parent to hang Children on. */
async function starWithParent() {
  const star = uniqueStar();
  const { client: admin, accessToken } = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  admin.callStarInstallOntology(star, { version: VERSION, types: TYPES });
  await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
  expect(admin.lastError).toBeUndefined();
  const parent = uuid();
  await commit(admin, star, { [parent]: { op: 'create', typeName: 'Parent', nodeId: ROOT_NODE_ID, value: { name: 'p' } } });
  const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: parent };
  return { star, admin, accessToken, parent, query };
}

/** Another tab of the Star's admin — a subscriber who can read everything. */
async function adminTab(star: string): Promise<NebulaClientTest> {
  return (await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com')).client;
}

const child = (parent: string, nodeId: string = ROOT_NODE_ID) =>
  ({ op: 'create' as const, typeName: 'Child', nodeId, value: { parent, label: 'c' } });

describe('every update that names a reaper reaps a closed tab — one limb per wiring site', () => {
  it('1: a resource update reaps its subscriber (onBroadcastResult)', async () => {
    const { star, admin, parent } = await starWithParent();
    const doomed = await adminTab(star);
    await doomed.resources.subscribe('Parent', parent).snapshot;
    const id = doomed.lmz.instanceName!;
    expect(await rows('STAR', star, 'resource', id)).toBe(1);

    await close(doomed);
    admin.callStarRead(star, VERSION, parent);
    await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
    const eTag = (admin.lastResult as { meta: { eTag: string } }).meta.eTag;
    await commit(admin, star, { [parent]: { op: 'put', eTag, value: { name: 'p2' } } });

    await vi.waitFor(async () => expect(await rows('STAR', star, 'resource', id)).toBe(0));
  });

  it('2: a query update to a subscriber who can read every result reaps it (onQueryBroadcastResult)', async () => {
    const { star, admin, parent, query } = await starWithParent();
    const doomed = await adminTab(star);
    using handle = doomed.resources.subscribeQuery(query);
    await handle.ready;
    expect(handle.deniedNodes).toEqual([]); // positive control: this tab is in the no-denial group
    const id = doomed.lmz.instanceName!;
    expect(await rows('STAR', star, 'query', id)).toBe(1);

    await close(doomed);
    await commit(admin, star, { [uuid()]: child(parent) });

    await vi.waitFor(async () => expect(await rows('STAR', star, 'query', id)).toBe(0));
  });

  it('3: a roster update reaps its watcher, from the watcher rows only (onQuerySubscriberListBroadcastResult)', async () => {
    const { star, admin, query } = await starWithParent();
    const doomed = await adminTab(star);
    using watch = doomed.subscribeQuerySubscribers(query);
    await watch.ready;
    const id = doomed.lmz.instanceName!;
    expect(await rows('STAR', star, 'roster', id)).toBe(1);

    await close(doomed);
    // A new data-subscriber's join grows the roster, which goes to every watcher.
    using joined = admin.resources.subscribeQuery(query);
    await joined.ready;

    await vi.waitFor(async () => expect(await rows('STAR', star, 'roster', id)).toBe(0));
  });

  it('4: a tree update reaps its tree subscriber (onTreeBroadcastResult)', async () => {
    const { star, admin } = await starWithParent();
    const doomed = await adminTab(star);
    doomed.callStarSubscribeTree(star);
    await vi.waitFor(() => expect(doomed.orgTreeUpdateCount).toBeGreaterThanOrEqual(1));
    const id = doomed.lmz.instanceName!;
    expect(await rows('STAR', star, 'tree', id)).toBe(1);

    await close(doomed);
    await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'n', 'Node');

    await vi.waitFor(async () => expect(await rows('STAR', star, 'tree', id)).toBe(0));
  });

  it('4 (Galaxy): a tree update reaps its tree subscriber (onTreeBroadcastResult)', async () => {
    // The Galaxy's plane builds a tree like any host's, and its door takes tree subscriptions.
    const scope = `reap-${uuid().slice(0, 8)}.app`;
    const chatPair = { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope } as const;
    const tab = async () => (await universeAdminClient(
      NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, chatPair)).client;
    const admin = await tab();
    const doomed = await tab();
    await doomed.lmz.callAsync('GALAXY', scope, (doomed.ctn() as any).resources.subscribeTree());
    await vi.waitFor(() => expect(doomed.orgTreeUpdateCount).toBeGreaterThanOrEqual(1));
    const id = doomed.lmz.instanceName!;
    expect(await rows('GALAXY', scope, 'tree', id)).toBe(1);

    await close(doomed);
    await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'n', 'Node');

    await vi.waitFor(async () => expect(await rows('GALAXY', scope, 'tree', id)).toBe(0));
  });

  it('5 (Star): a query update to a subscriber missing some results reaps it (onQueryBroadcastResult)', async () => {
    const { star, admin, accessToken, parent, query } = await starWithParent();
    const nodeA = await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'a', 'A');
    const nodeB = await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'b', 'B');
    await commit(admin, star, { [uuid()]: child(parent, nodeA), [uuid()]: child(parent, nodeB) });

    await createSubject(new Browser(), star, accessToken, 'member@example.com');
    const { client: doomed, payload } = await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'member@example.com');
    await admin.orgTree.setPermission(nodeA, payload.sub, 'read');
    using handle = doomed.resources.subscribeQuery(query);
    await handle.ready;
    expect(handle.deniedNodes).toEqual([nodeB]); // positive control: this tab is in the has-denial group
    const id = doomed.lmz.instanceName!;
    expect(await rows('STAR', star, 'query', id)).toBe(1);

    await close(doomed);
    await commit(admin, star, { [uuid()]: child(parent, nodeA) });

    await vi.waitFor(async () => expect(await rows('STAR', star, 'query', id)).toBe(0));
  });

  it('5 (Galaxy): a chat update to a subscriber missing some results reaps it (onQueryBroadcastResult)', async () => {
    const scope = `reap-${uuid().slice(0, 8)}.app`;
    const chatPair = { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope } as const;
    const { client: admin, accessToken } = await universeAdminClient(
      NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, chatPair);
    const chat = uuid();
    const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Message', field: 'chat', value: chat };
    const message = (nodeId: string) => ({ op: 'create' as const, typeName: 'Message', nodeId, value: { chat, content: 'm' } });
    const nodeA = await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'a', 'A');
    const nodeB = await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'b', 'B');
    expect((await admin.resources.transaction({ [uuid()]: message(nodeA), [uuid()]: message(nodeB) })).kind).toBe('committed');

    const adminBrowser = new Browser();
    await foundAndLogin(adminBrowser, scope, 'admin@example.com', scope);
    await createSubject(adminBrowser, scope, accessToken, 'member@example.com');
    const { client: doomed, payload } = await createInvitedClient(
      NebulaClientTest, new Browser(), scope, scope, 'member@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, chatPair);
    await admin.orgTree.setPermission(nodeA, payload.sub, 'read');
    using handle = doomed.resources.subscribeQuery(query);
    await handle.ready;
    expect(handle.deniedNodes).toEqual([nodeB]); // positive control: this tab is in the has-denial group
    const id = doomed.lmz.instanceName!;
    expect(await rows('GALAXY', scope, 'query', id)).toBe(1);

    await close(doomed);
    expect((await admin.resources.transaction({ [uuid()]: message(nodeA) })).kind).toBe('committed');

    await vi.waitFor(async () => expect(await rows('GALAXY', scope, 'query', id)).toBe(0));
  });
});
