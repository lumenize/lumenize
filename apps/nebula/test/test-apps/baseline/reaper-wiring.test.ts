/**
 * Every update the plane sends that names a reaper reaps the tab its host node reports gone — one
 * limb per wiring site, each asserting the persisted row.
 *
 * A limb per SITE, not per kind of subscription, because of how a reap fails. A reaper runs at the
 * fire-back door of the host that broadcast, where a handler's throw is only logged, and the reapers
 * take the same kinds of argument — strings, then the result — so a continuation naming the WRONG
 * reaper compiles and fails silently.
 * `ResourcesHost` makes a MISNAMED reaper fail to compile (the `@ts-expect-error` below); only a
 * row assertion per site catches a wrong one.
 *
 * Why vitest-plugin rather than `/live`: the rows are server-internal state no client can read, and
 * reading them takes `runInDurableObject`. The path under test — the real host node reporting a
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
 *
 * The first answer to a new subscriber is three more sites — a resource's first snapshot
 * (`onBroadcastResult`), the tree's (`onTreeBroadcastResult`), and the Profile's
 * (`onProfileBroadcastResult`). Like site 6, each is sent inside the subscriber's own subscribe,
 * so no tab a test drives can be gone by then. Their limbs subscribe a tab that never connected to
 * its host node, by a hand-built envelope carrying a real admin's claims: that host node answers the
 * first snapshot with `ClientDisconnectedError`, which is the one deterministic way to fail it. Mutation per limb: give the site the logging `onPushUndelivered` instead.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { setDebugSink, clearDebugSink, type DebugLogOutput } from '@lumenize/debug';
import { Browser } from '@lumenize/testing';
import { preprocess } from '@lumenize/structured-clone';
import { newContinuation } from '@lumenize/mesh';
import type { Continuation } from '@lumenize/mesh';
import { ROOT_NODE_ID } from '@lumenize/resources';
import { CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula';
import type { QueryDescriptor, ResourcesHost, SubscriptionKind, TransactionResult } from '@lumenize/resources';
import { adminClientAt, universeAdminClient, createInvitedClient, createSubject, uniqueStar, addressOfClient } from '../../test-helpers';
import { NebulaClientTest } from './index';
import { splitAddress } from '@lumenize/mesh';

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
  typedCtn<ResourcesHost>().resourcesResults.onBroadcastResults('resource-id', 'sent-at');
  typedCtn<ResourcesHost>().resourcesResults.onBroadcastResult('resource-id', 'sent-at');
});

const uuid = () => crypto.randomUUID();

/** Rows of one kind a client holds in a host's `Subscriptions` table. */
async function rows(binding: 'STAR' | 'GALAXY', instance: string, kind: SubscriptionKind, clientAddress: string): Promise<number> {
  const stub: any = (env as any)[binding].getByName(instance);
  return (runInDurableObject as any)(stub, (_i: any, c: any) =>
    c.storage.sql.exec('SELECT COUNT(*) AS n FROM Subscriptions WHERE kind = ? AND clientAddress = ?', kind, clientAddress)
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
    const id = addressOfClient(doomed);
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
    const id = addressOfClient(doomed);
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
    const id = addressOfClient(doomed);
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
    const id = addressOfClient(doomed);
    expect(await rows('STAR', star, 'tree', id)).toBe(1);

    await close(doomed);
    await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'n', 'Node');

    await vi.waitFor(async () => expect(await rows('STAR', star, 'tree', id)).toBe(0));
  });

  it('4 (Galaxy): a tree update reaps its tree subscriber (onTreeBroadcastResult)', async () => {
    // The Galaxy's plane builds a tree like any host's, and its door takes tree subscriptions.
    const scope = `reap-${uuid().slice(0, 8)}.app`;
    const chatPair = { resourceHostBinding: 'GALAXY' } as const;
    const tab = async () => (await universeAdminClient(
      NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, chatPair)).client;
    const admin = await tab();
    const doomed = await tab();
    await doomed.lmz.callAsync('GALAXY', scope, (doomed.ctn() as any).resources.subscribeTree());
    await vi.waitFor(() => expect(doomed.orgTreeUpdateCount).toBeGreaterThanOrEqual(1));
    const id = addressOfClient(doomed);
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
    const id = addressOfClient(doomed);
    expect(await rows('STAR', star, 'query', id)).toBe(1);

    await close(doomed);
    await commit(admin, star, { [uuid()]: child(parent, nodeA) });

    await vi.waitFor(async () => expect(await rows('STAR', star, 'query', id)).toBe(0));
  });

  it('5 (Galaxy): a chat update to a subscriber missing some results reaps it (onQueryBroadcastResult)', async () => {
    const scope = `reap-${uuid().slice(0, 8)}.app`;
    const chatPair = { resourceHostBinding: 'GALAXY' } as const;
    const { client: admin, accessToken } = await universeAdminClient(
      NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, chatPair);
    const chat = uuid();
    const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Message', field: 'chat', value: chat };
    const message = (nodeId: string) => ({ op: 'create' as const, typeName: 'Message', nodeId, value: { chat, content: 'm' } });
    const nodeA = await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'a', 'A');
    const nodeB = await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'b', 'B');
    expect((await admin.resources.transaction({ [uuid()]: message(nodeA), [uuid()]: message(nodeB) })).kind).toBe('committed');

    const adminBrowser = new Browser();
    await createSubject(adminBrowser, scope, accessToken, 'member@example.com');
    const { client: doomed, payload } = await createInvitedClient(
      NebulaClientTest, new Browser(), scope, scope, 'member@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, chatPair);
    await admin.orgTree.setPermission(nodeA, payload.sub, 'read');
    using handle = doomed.resources.subscribeQuery(query);
    await handle.ready;
    expect(handle.deniedNodes).toEqual([nodeB]); // positive control: this tab is in the has-denial group
    const id = addressOfClient(doomed);
    expect(await rows('GALAXY', scope, 'query', id)).toBe(1);

    await close(doomed);
    expect((await admin.resources.transaction({ [uuid()]: message(nodeA) })).kind).toBe('committed');

    await vi.waitFor(async () => expect(await rows('GALAXY', scope, 'query', id)).toBe(0));
  });
});

/** The claims a real access token carries — its JWT payload. */
function claimsOf(accessToken: string): { sub: string } & Record<string, unknown> {
  return JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
}

/**
 * Run `chain` at `binding`/`instance` as a tab hosted on the Star `star` that never connected,
 * carrying `accessToken`'s claims, and return that tab's address. The Star holds no socket for it,
 * so it answers any push with `ClientDisconnectedError`.
 */
async function subscribeAsAbsentTab(
  binding: string, instance: string, star: string, accessToken: string, chain: unknown[],
): Promise<string> {
  const claims = claimsOf(accessToken);
  const tab = { type: 'LumenizeClient', bindingName: 'STAR', instanceName: `${star}/${claims.sub}.absent-${uuid().slice(0, 8)}` };
  const ack = await (env as any)[binding].getByName(instance).__executeOperation({
    version: 1,
    chain: preprocess(chain),
    callContext: {
      callChain: [tab],
      originAuth: { sub: claims.sub, claims },
    },
    metadata: { callee: { type: 'LumenizeDO', bindingName: binding, instanceName: instance } },
  });
  expect(ack).toEqual({ $ack: true });
  return `${tab.bindingName}/${tab.instanceName}`;
}

const through = (...path: string[]) => (...args: unknown[]) =>
  [...path.map((key) => ({ type: 'get', key })), { type: 'apply', args }];

describe('the first answer to a new subscriber reaps a tab that is already gone', () => {
  /** Whether the reaper's receipt names `tab`: the push it reaps for went to that address. */
  const reaped = (entries: DebugLogOutput[], tab: string) =>
    entries.some((e) => e.message === 'update not delivered' && e.data?.clientAddress === tab);

  it('7: a resource\'s first snapshot (onBroadcastResult)', async () => {
    const entries: DebugLogOutput[] = [];
    setDebugSink((e) => entries.push(e));
    try {
      const { star, accessToken, parent } = await starWithParent();
      const tab = await subscribeAsAbsentTab('STAR', star, star, accessToken,
        through('resources', 'subscribe')(VERSION, 'Parent', parent));
      // Fixture guard: the push went to the tab's address, so its row was written under it.
      await vi.waitFor(() => expect(reaped(entries, tab)).toBe(true));
      // The row was written and is gone: under the mutation it stays at 1.
      await vi.waitFor(async () => expect(await rows('STAR', star, 'resource', tab)).toBe(0));
    } finally {
      clearDebugSink();
    }
  });

  it('8: the tree\'s first snapshot (onTreeBroadcastResult)', async () => {
    const entries: DebugLogOutput[] = [];
    setDebugSink((e) => entries.push(e));
    try {
      const { star, accessToken } = await starWithParent();
      const tab = await subscribeAsAbsentTab('STAR', star, star, accessToken, through('resources', 'subscribeTree')());
      await vi.waitFor(() => expect(reaped(entries, tab)).toBe(true));
      await vi.waitFor(async () => expect(await rows('STAR', star, 'tree', tab)).toBe(0));
    } finally {
      clearDebugSink();
    }
  });

  it('9: the Profile\'s first snapshot (onProfileBroadcastResult)', async () => {
    const { star, accessToken } = await starWithParent();
    const profileId = uuid();
    await subscribeAsAbsentTab('PROFILE', profileId, star, accessToken, through('subscribe')());
    await vi.waitFor(async () => {
      const n = await (runInDurableObject as any)((env as any).PROFILE.getByName(profileId), (_i: any, c: any) =>
        c.storage.sql.exec('SELECT COUNT(*) AS n FROM Subscribers').toArray()[0].n as number);
      expect(n).toBe(0);
    });
  });
});

/**
 * A reaper's answer and the gone tab's re-subscribe race: the host node fires the failure back in the
 * turn it gives up, and the tab may come back and subscribe again while that fire-back is in flight.
 * The reaper deletes only a row no newer than the push that failed, which rides its continuation as
 * `sentAt`, so the re-subscribe's row survives.
 *
 * Why a hand-built fire-back: the window is the few milliseconds the fire-back spends in flight, and
 * no product path widens it, so neither a `/live` run nor a real host node in this lane can land the
 * re-subscribe inside it on demand. The fire-back is what the tab's host node sends, on a chain the host
 * started: the host's continuation, filled with `ClientDisconnectedError`, ending at the tab. Each
 * limb's second half is the positive control: the same fire-back with a later `sentAt` reaps.
 */
describe('a re-subscribe that lands before its reaper keeps its row', () => {
  afterEach(() => clearDebugSink());

  const gone = () => Object.assign(new Error('Client did not reconnect within grace period'), { name: 'ClientDisconnectedError' });
  const anHourBefore = (iso: string) => new Date(Date.parse(iso) - 3_600_000).toISOString();

  /** The fire-back a tab's host node sends `host` when a push to `tab` fails, filling `chain`. */
  async function fireBack(binding: string, host: string, tab: string, chain: unknown[]): Promise<void> {
    const node = { type: 'LumenizeDO', bindingName: binding, instanceName: host };
    const ack = await (env as any)[binding].getByName(host).__handleResponse({
      version: 1,
      chain: preprocess(chain),
      callContext: {
        callChain: [node, { type: 'LumenizeClient', ...splitAddress(tab) }],
      },
      metadata: { callee: node },
    });
    expect(ack).toEqual({ $ack: true });
  }

  /** Wait for the reaper's receipt for `tab`, logged whether or not it deleted anything. */
  async function receipt(entries: DebugLogOutput[], tab: string, count: number): Promise<void> {
    await vi.waitFor(() => expect(entries.filter((e) => e.message === 'update not delivered'
      && e.data?.clientAddress === tab).length).toBe(count));
  }

  it('on the Resources plane', async () => {
    const entries: DebugLogOutput[] = [];
    setDebugSink((e) => entries.push(e));
    const { star, parent } = await starWithParent();
    const tab = await adminTab(star);
    await tab.resources.subscribe('Parent', parent).snapshot;
    const id = addressOfClient(tab);
    const subscribedAt: string = await (runInDurableObject as any)((env as any).STAR.getByName(star), (_i: any, c: any) =>
      c.storage.sql.exec(`SELECT subscribedAt FROM Subscriptions WHERE kind = 'resource' AND clientAddress = ?`, id)
        .toArray()[0].subscribedAt);

    // A push sent an hour before this row was written failed, and its reaper arrives now.
    await fireBack('STAR', star, id, through('resourcesResults', 'onBroadcastResult')(parent, anHourBefore(subscribedAt), gone()));
    await receipt(entries, id, 1);
    // MUTATION: drop the `subscribedAt <= ?` guard, and the newer row goes.
    expect(await rows('STAR', star, 'resource', id)).toBe(1);

    await fireBack('STAR', star, id, through('resourcesResults', 'onBroadcastResult')(parent, subscribedAt, gone()));
    await vi.waitFor(async () => expect(await rows('STAR', star, 'resource', id)).toBe(0));
    tab[Symbol.dispose]();
  });

  it('on a Profile', async () => {
    const entries: DebugLogOutput[] = [];
    setDebugSink((e) => entries.push(e));
    const { star } = await starWithParent();
    const tab = await adminTab(star);
    const profileId = uuid();
    await tab.subscribeProfile(profileId).snapshot;
    const id = addressOfClient(tab);
    const profile = (env as any).PROFILE.getByName(profileId);
    const subscribedAt: string = await (runInDurableObject as any)(profile, (_i: any, c: any) =>
      c.storage.sql.exec('SELECT subscribedAt FROM Subscribers WHERE clientAddress = ?', id).toArray()[0].subscribedAt);
    const subscribers = async () => (runInDurableObject as any)(profile, (_i: any, c: any) =>
      c.storage.sql.exec('SELECT COUNT(*) AS n FROM Subscribers WHERE clientAddress = ?', id).toArray()[0].n as number);

    await fireBack('PROFILE', profileId, id, through('onProfileBroadcastResult')(anHourBefore(subscribedAt), gone()));
    await receipt(entries, id, 1);
    // MUTATION: drop the `subscribedAt <= ?` guard, and the newer row goes.
    expect(await subscribers()).toBe(1);

    await fireBack('PROFILE', profileId, id, through('onProfileBroadcastResult')(subscribedAt, gone()));
    await vi.waitFor(async () => expect(await subscribers()).toBe(0));
    tab[Symbol.dispose]();
  });
});
