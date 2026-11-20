/**
 * A query subscription that takes a filter, through a real `NebulaClient` and the plane.
 *
 * vitest-plugin rather than `/live` for what each case must see that a running system does not
 * show on demand: a host's index catalogue, a push that was NOT sent, a row compiled before queries
 * took a filter, a type at its bound of two hundred live queries, and a thousand resources in one
 * result. The `/live` scenario `query-by-filter` drives the same path through Nebula's pages with
 * two members, where the permission half is shown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { NebulaClient, ROOT_NODE_ID } from '@lumenize/resources/client';
import { canonicalQueryHash, MAX_LIVE_QUERIES_PER_TYPE, QUERY_RESULT_CAP } from '@lumenize/resources';
import type { QueryDescriptor } from '@lumenize/resources';
import { PLATFORM } from '../../../mesh/test/auth/test-helpers';
import { loginAt, uniqueScope, type Login } from '../../../mesh/test/support/login';
import { ONTOLOGY_VERSION, TYPES } from '../test-worker';

async function pageClient(login: Login, tab = 'tab1', version = ONTOLOGY_VERSION): Promise<NebulaClient> {
  const browser = new Browser();
  browser.setCookie(login.cookie.name, login.cookie.value, { domain: new URL(PLATFORM).hostname, path: '/' });
  const page = browser.context(login.baseUrl);
  const client = new NebulaClient({
    instanceName: `${login.sub}.${tab}`, baseUrl: login.baseUrl, platformOrigin: PLATFORM,
    ontologyVersion: version, fetch: page.fetch, WebSocket: page.WebSocket,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
  return client;
}

/** Create a Deal and answer its id. */
async function deal(client: NebulaClient, value: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  const outcome = await client.resources.transaction({ [id]: { op: 'create', typeName: 'Deal', nodeId: ROOT_NODE_ID, value } });
  expect(outcome.kind, JSON.stringify(outcome)).toBe('committed');
  return id;
}

/** Replace a Deal's value, from the version the host holds. */
async function put(client: NebulaClient, id: string, value: Record<string, unknown>): Promise<void> {
  const current = await client.resources.read('Deal', id);
  const outcome = await client.resources.transaction({ [id]: { op: 'put', typeName: 'Deal', ifValidFromMatches: current!.meta.validFrom, value } });
  expect(outcome.kind, JSON.stringify(outcome)).toBe('committed');
}

async function remove(client: NebulaClient, id: string): Promise<void> {
  const current = await client.resources.read('Deal', id);
  const outcome = await client.resources.transaction({ [id]: { op: 'delete', typeName: 'Deal', ifValidFromMatches: current!.meta.validFrom } });
  expect(outcome.kind, JSON.stringify(outcome)).toBe('committed');
}

const rejection = async (ready: Promise<void>): Promise<string> => ready.then(() => 'resolved', (e: Error) => e.message);

describe('a query subscription takes a filter', { timeout: 120000 }, () => {
  it('delivers the resources that match, and reruns only for a write that touches the result', async () => {
    const universe = uniqueScope();
    using client = await pageClient(await loginAt(universe));
    const acme = await deal(client, { title: 'Acme', stage: 'open', amount: 1500 });
    await deal(client, { title: 'Globex', stage: 'lead', amount: 9000 });

    using open = client.resources.subscribeQuery({ typeName: 'Deal', filter: { stage: 'open', amount: { $gt: 1000 } } });
    let pushes = 0;
    open.onChange(() => { pushes++; });
    await open.ready;
    expect(open.resourceIds).toEqual([acme]);
    expect(open.more).toBe(false);
    const settled = async (expected: string[]) => {
      const before = pushes;
      await vi.waitFor(() => expect(pushes).toBeGreaterThan(before));
      expect(open.resourceIds).toEqual(expected);
    };

    // Entering: a new Deal that matches.
    let wait = settled([acme, expect.any(String) as unknown as string]);
    const initech = await deal(client, { title: 'Initech', stage: 'open', amount: 2000 });
    await wait;
    expect(open.resourceIds).toEqual([acme, initech]);

    // A write of the same type that matches neither before nor after sends nothing. The Deal that
    // enters next is the barrier: exactly one push arrives for the two writes.
    const quiet = pushes;
    const hooli = await deal(client, { title: 'Hooli', stage: 'lead', amount: 50 });
    await put(client, hooli, { title: 'Hooli', stage: 'lead', amount: 60 });
    const umbrella = await deal(client, { title: 'Umbrella', stage: 'open', amount: 3000 });
    await vi.waitFor(() => expect(open.resourceIds).toEqual([acme, initech, umbrella]));
    expect(pushes).toBe(quiet + 1);

    // Staying: a matching Deal written again moves to the end of the order.
    wait = settled([initech, umbrella, acme]);
    await put(client, acme, { title: 'Acme renewal', stage: 'open', amount: 1600 });
    await wait;

    // Leaving: it no longer matches.
    wait = settled([umbrella, acme]);
    await put(client, initech, { title: 'Initech', stage: 'won', amount: 2000 });
    await wait;

    // Entering by an edit: the one that matched neither now matches.
    wait = settled([umbrella, acme, hooli]);
    await put(client, hooli, { title: 'Hooli', stage: 'open', amount: 6000 });
    await wait;

    // Deleted while matching.
    wait = settled([acme, hooli]);
    await remove(client, umbrella);
    await wait;
  });

  it('refuses a filter the engine refuses, and one no index can look up, by the engine\'s message', async () => {
    using client = await pageClient(await loginAt(uniqueScope()));
    await deal(client, { title: 'Acme', stage: 'open', owner: 'p1' });
    const refused = (query: QueryDescriptor) => rejection(client.resources.subscribeQuery(query).ready);

    expect(await refused({ typeName: 'Deal', filter: { nope: 1 } })).toBe('Deal has no field "nope"');
    expect(await refused({ typeName: 'Deal', filter: { scores: 1 } })).toBe('Deal.scores cannot be queried: it is a Map');
    expect(await refused({ typeName: 'Nope', filter: {} })).toBe('The ontology has no type named "Nope"');
    expect(await refused({ typeName: 'Deal', filter: { owner: 'p1' } })).toContain('This filter would read every current Deal');
    expect(await refused({ typeName: 'Deal' } as never)).toContain('A filter is an object of fields and conditions');
    // Nothing was registered for any of them.
    using all = client.resources.subscribeQuery({ typeName: 'Deal', filter: {} });
    await all.ready;
    expect(all.resourceIds).toHaveLength(1);
  });

  describe('an allowed scan', () => {
    const entries: Array<{ namespace: string; message: string; data?: Record<string, unknown> }> = [];
    beforeEach(() => { entries.length = 0; setDebugSink((entry) => { entries.push(entry as never); }); });
    afterEach(() => clearDebugSink());

    it('runs, and the host logs the query that scans and no query an index serves', async () => {
      using client = await pageClient(await loginAt(uniqueScope()));
      const acme = await deal(client, { title: 'Acme', stage: 'open', owner: 'p1' });
      await deal(client, { title: 'Globex', stage: 'open', owner: 'p2' });
      const scanning: QueryDescriptor = { typeName: 'Deal', filter: { owner: 'p1' }, allowScan: true };
      using mine = client.resources.subscribeQuery(scanning);
      await mine.ready;
      expect(mine.resourceIds).toEqual([acme]);
      using open = client.resources.subscribeQuery({ typeName: 'Deal', filter: { stage: 'open' } });
      await open.ready;

      const logged = entries.filter((entry) => entry.namespace === 'nebula.Resources.query' && entry.message === 'query scans');
      expect(logged.map((entry) => [entry.data?.typeName, entry.data?.queryHash, entry.data?.allowScan]))
        .toEqual([['Deal', canonicalQueryHash(scanning), true]]);
    });
  });

  it('a write holding a value a query would read wrongly is refused, and writes nothing', async () => {
    using client = await pageClient(await loginAt(uniqueScope()));
    const id = crypto.randomUUID();
    const outcome = await client.resources.transaction({
      [id]: { op: 'create', typeName: 'Deal', nodeId: ROOT_NODE_ID, value: { title: 'Infinite', stage: 'open', amount: Infinity } },
    });
    expect(outcome.kind).not.toBe('committed');
    expect(JSON.stringify(outcome)).toContain('Deal.amount is Infinity, which a query cannot compare');
    using all = client.resources.subscribeQuery({ typeName: 'Deal', filter: {} });
    await all.ready;
    expect(all.resourceIds).toEqual([]);
    // The same number where no query reaches is stored.
    await deal(client, { title: 'Scored', stage: 'open', scores: new Map([['k', Infinity]]) });
  });

  it('holds a type to its bound of live queries, counting queries and not subscribers', async () => {
    const universe = uniqueScope();
    const login = await loginAt(universe);
    using client = await pageClient(login);
    const query = (i: number): QueryDescriptor => ({ typeName: 'Deal', filter: { stage: 'open', amount: { $gt: i } } });
    const held = Array.from({ length: MAX_LIVE_QUERIES_PER_TYPE }, (_, i) => client.resources.subscribeQuery(query(i)));
    await Promise.all(held.map((handle) => handle.ready));

    expect(await rejection(client.resources.subscribeQuery(query(MAX_LIVE_QUERIES_PER_TYPE)).ready))
      .toContain(`Deal already has ${MAX_LIVE_QUERIES_PER_TYPE} different live queries here`);
    // Another subscriber to a query already live is admitted, and so is a query on another type.
    using second = await pageClient(login, 'tab2');
    using again = second.resources.subscribeQuery(query(0));
    await again.ready;
    using notes = client.resources.subscribeQuery({ typeName: 'Note', filter: { board: crypto.randomUUID() } });
    await notes.ready;
    // Releasing one makes room for another.
    held[0]![Symbol.dispose]();
    again[Symbol.dispose]();
    await vi.waitFor(async () => {
      using retry = client.resources.subscribeQuery(query(MAX_LIVE_QUERIES_PER_TYPE + 1));
      expect(await rejection(retry.ready)).toBe('resolved');
    });
    for (const handle of held) handle[Symbol.dispose]();
  });

  it(`sends at most ${QUERY_RESULT_CAP} ids, and says when the query matched more`, async () => {
    const universe = uniqueScope();
    using client = await pageClient(await loginAt(universe));
    await deal(client, { title: 'first', stage: 'lead' });
    const host = env.STAR.getByName(universe);
    await host.seedDealsForTest(QUERY_RESULT_CAP, ROOT_NODE_ID, 'open');

    using open = client.resources.subscribeQuery({ typeName: 'Deal', filter: { stage: 'open' } });
    await open.ready;
    expect(open.resourceIds).toHaveLength(QUERY_RESULT_CAP);
    expect(open.more).toBe(false);

    const extra = await deal(client, { title: 'one more', stage: 'open' });
    await vi.waitFor(() => expect(open.more).toBe(true));
    expect(open.resourceIds).toHaveLength(QUERY_RESULT_CAP);
    // The first by order are kept, so the newest write is the one left off.
    expect(open.resourceIds).not.toContain(extra);
    expect(open.resourceIds[0]).toBe('seed-00000');
  });
});

describe('a host\'s indexes match the version it installs', { timeout: 60000 }, () => {
  it('creates what the version declares, and drops what the next version does not', async () => {
    const universe = uniqueScope();
    const login = await loginAt(universe);
    using client = await pageClient(login);
    await deal(client, { title: 'Acme', stage: 'open' }); // the first op installs the version
    const host = env.STAR.getByName(universe);
    expect(await host.queryIndexesForTest()).toEqual(['idx_Snapshots_q_Deal:stage,amount', 'idx_Snapshots_q_Note:board']);

    // The next version keeps one index, drops one and adds one.
    const next = TYPES.replace('/** @index stage, amount */', '/** @index owner */');
    await host.installTypesForTest('v2', next);
    expect(await host.queryIndexesForTest()).toEqual(['idx_Snapshots_q_Deal:owner', 'idx_Snapshots_q_Note:board']);

    // A query the new index serves now runs, and one only the dropped index served is refused.
    using v2 = await pageClient(login, 'tab2', 'v2');
    using mine = v2.resources.subscribeQuery({ typeName: 'Deal', filter: { owner: 'p1' } });
    expect(await rejection(mine.ready)).toBe('resolved');
    expect(await rejection(v2.resources.subscribeQuery({ typeName: 'Deal', filter: { stage: 'open' } }).ready))
      .toContain(`Deal's indexes start with "owner"`);
  });

  it('a version compiled before queries took a filter refuses every query, and says to build again', async () => {
    const universe = uniqueScope();
    const login = await loginAt(universe);
    using client = await pageClient(login);
    await deal(client, { title: 'Acme', stage: 'open' });
    const host = env.STAR.getByName(universe);
    await host.installTypesForTest('old', TYPES, { fields: false });
    expect(await host.queryIndexesForTest()).toEqual([]);

    using old = await pageClient(login, 'tab2', 'old');
    expect(await rejection(old.resources.subscribeQuery({ typeName: 'Deal', filter: { stage: 'open' } }).ready))
      .toBe('This app was built before queries could filter. Build it again, and its queries will run');
    // Its writes still land, unchecked for what a query would read wrongly.
    await deal(old, { title: 'Infinite', stage: 'open', amount: Infinity });
  });
});

describe('canonicalQueryHash', () => {
  const hash = canonicalQueryHash;
  it('is one hash for filters that differ only in the order of their keys, at any depth', () => {
    expect(hash({ typeName: 'Deal', filter: { stage: 'open', amount: { $gt: 1, $lt: 9 } } }))
      .toBe(hash({ typeName: 'Deal', filter: { amount: { $lt: 9, $gt: 1 }, stage: 'open' } }));
    expect(hash({ typeName: 'Deal', filter: { $and: [{ b: 1, a: 2 }] } })).toBe(hash({ typeName: 'Deal', filter: { $and: [{ a: 2, b: 1 }] } }));
    expect(hash({ typeName: 'Deal', filter: { stage: 'open' } })).toBe(hash({ typeName: 'Deal', filter: { stage: 'open' }, allowScan: false }));
  });

  it('differs for another type, value, list order, Date or allowed scan', () => {
    const base = hash({ typeName: 'Deal', filter: { stage: 'open' } });
    const others = [
      hash({ typeName: 'Task', filter: { stage: 'open' } }),
      hash({ typeName: 'Deal', filter: { stage: 'lead' } }),
      hash({ typeName: 'Deal', filter: { stage: 'open' }, allowScan: true }),
      hash({ typeName: 'Deal', filter: { stage: { $in: ['open', 'lead'] } } }),
      hash({ typeName: 'Deal', filter: { stage: { $in: ['lead', 'open'] } } }),
      hash({ typeName: 'Deal', filter: { due: new Date('2026-01-01T00:00:00Z') } }),
      hash({ typeName: 'Deal', filter: { due: new Date('2026-01-02T00:00:00Z') } }),
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });
});
