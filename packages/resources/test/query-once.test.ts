/**
 * `client.resources.query`: a query's current result, read once, through a real `NebulaClient`
 * logged in through Mesh's Registry and the plane on the package's test host.
 *
 * vitest-plugin rather than `/live` for what each case must see that a running system does not
 * show: the host's `Subscriptions` rows before and after a read, the debug line the read check
 * writes, and a thousand and one resources at one node. `confine-org-plane.test.ts` drives the
 * admin cases against the Galaxy's chat plane, beside the subscription's, and Studio's tool-call
 * marks read through this path in the `/live` scenarios that show them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { NebulaClient, ROOT_NODE_ID } from '@lumenize/resources/client';
import { isOntologyStaleError, QUERY_RESULT_CAP } from '@lumenize/resources';
import type { OntologyStaleInfo, BuildStaleInfo, QueryDescriptor } from '@lumenize/resources';
import { PLATFORM } from '../../mesh/test/auth/test-helpers';
import { loginAt, uniqueScope, type Login } from '../../mesh/test/support/login';
import { ONTOLOGY_VERSION } from './test-worker';

async function pageClient(
  login: Login, tab = 'tab1', version = ONTOLOGY_VERSION,
  onShouldRefreshUI?: (info: OntologyStaleInfo | BuildStaleInfo) => void,
): Promise<NebulaClient> {
  const browser = new Browser();
  browser.setCookie(login.cookie.name, login.cookie.value, { domain: new URL(PLATFORM).hostname, path: '/' });
  const page = browser.context(login.baseUrl);
  const client = new NebulaClient({
    instanceName: `${login.sub}.${tab}`, baseUrl: login.baseUrl, platformOrigin: PLATFORM,
    ontologyVersion: version, fetch: page.fetch, WebSocket: page.WebSocket, onShouldRefreshUI,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
  return client;
}

/** Create a Deal at `nodeId` and answer its id. */
async function deal(client: NebulaClient, nodeId: string, title: string): Promise<string> {
  const id = crypto.randomUUID();
  const outcome = await client.resources.transaction({
    [id]: { op: 'create', typeName: 'Deal', nodeId, value: { title, stage: 'open' } },
  });
  expect(outcome.kind, JSON.stringify(outcome)).toBe('committed');
  return id;
}

const OPEN: QueryDescriptor = { typeName: 'Deal', filter: { stage: 'open' } };

/**
 * A universe whose admin has made two nodes under the root, `a` and `b`, with `perNode` open Deals
 * at each, and two plain members holding no grant yet.
 */
async function twoNodes(perNode = 1) {
  const universe = uniqueScope('q');
  const adminLogin = await loginAt(universe);
  const admin = await pageClient(adminLogin);
  const a = await admin.orgTree.createNode(crypto.randomUUID(), ROOT_NODE_ID, 'a', 'A');
  const b = await admin.orgTree.createNode(crypto.randomUUID(), ROOT_NODE_ID, 'b', 'B');
  const atA: string[] = [];
  const atB: string[] = [];
  for (let i = 0; i < perNode; i++) {
    atA.push(await deal(admin, a, `A${i}`));
    atB.push(await deal(admin, b, `B${i}`));
  }
  const first = await loginAt(universe);
  const second = await loginAt(universe);
  expect(first.admin || second.admin).toBe(false);
  return { universe, admin, adminLogin, a, b, atA, atB, first, second };
}

/** Every row of the host's `Subscriptions` table, as stored. */
function subscriptionRows(universe: string): Promise<unknown[]> {
  return (runInDurableObject as any)(env.STAR.getByName(universe), (_instance: unknown, ctx: DurableObjectState) =>
    ctx.storage.sql.exec('SELECT kind, topic, clientAddress, subscribedAt FROM Subscriptions ORDER BY kind, topic, clientAddress').toArray());
}

const message = (promise: Promise<unknown>): Promise<string> =>
  promise.then(() => 'resolved', (e: Error) => e.message);

describe('a query read once', { timeout: 60000 }, () => {
  // MUTATION: register the query before answering, and the table holds a row it did not before.
  it('answers each snapshot\'s value and meta at two nodes, and writes no subscription', async () => {
    const { universe, admin, a, b, atA, atB, first } = await twoNodes();
    await admin.orgTree.setPermission(a, first.sub, 'read');
    await admin.orgTree.setPermission(b, first.sub, 'read');
    using member = await pageClient(first);

    const before = await subscriptionRows(universe);
    const result = await member.resources.query(OPEN);
    expect(await subscriptionRows(universe)).toEqual(before);

    expect(result.snapshots.map((s) => s.resourceId)).toEqual([atA[0], atB[0]]);
    expect(result.snapshots.map((s) => s.value.title)).toEqual(['A0', 'B0']);
    expect(result.snapshots.map((s) => s.meta.nodeId)).toEqual([a, b]);
    expect(result.snapshots.every((s) => s.meta.typeName === 'Deal' && s.meta.deleted === false)).toBe(true);
    expect(result.deniedNodes).toBeUndefined();
    expect(result.more).toBeUndefined();
    admin[Symbol.dispose]();
  });

  // MUTATION: skip the read evaluation, and the member gets `b`'s snapshot too.
  it('answers the nodes a member may read, and names the one they may not', async () => {
    const { admin, a, b, atA, first } = await twoNodes();
    await admin.orgTree.setPermission(a, first.sub, 'read');
    using member = await pageClient(first);

    const result = await member.resources.query(OPEN);
    expect(result.snapshots.map((s) => s.resourceId)).toEqual([atA[0]]);
    expect(result.deniedNodes).toEqual([b]);
    admin[Symbol.dispose]();
  });

  // MUTATION: read the caller's `act` chain, or the impersonating admin's dominion, and the child
  // reads both nodes.
  it('answers one descriptor by each caller\'s own grants, and an impersonated child by the subject\'s', async () => {
    const { admin, a, b, atA, atB, first, second } = await twoNodes();
    await admin.orgTree.setPermission(a, first.sub, 'read');
    await admin.orgTree.setPermission(b, second.sub, 'read');
    using one = await pageClient(first);
    using two = await pageClient(second);
    const descriptor = JSON.stringify(OPEN);

    const r1 = await one.resources.query(JSON.parse(descriptor));
    const r2 = await two.resources.query(JSON.parse(descriptor));
    expect([r1.snapshots.map((s) => s.resourceId), r1.deniedNodes]).toEqual([[atA[0]], [b]]);
    expect([r2.snapshots.map((s) => s.resourceId), r2.deniedNodes]).toEqual([[atB[0]], [a]]);

    // The admin itself reads both: dominion over the host, with no grant.
    expect((await admin.resources.query(OPEN)).snapshots).toHaveLength(2);
    using child = await admin.impersonate(first.sub);
    expect(child.claims?.act?.sub).toBe(admin.claims?.sub);
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'), { timeout: 10000 });
    const asFirst = await child.resources.query(OPEN);
    expect([asFirst.snapshots.map((s) => s.resourceId), asFirst.deniedNodes]).toEqual([[atA[0]], [b]]);
    admin[Symbol.dispose]();
  });

  // MUTATION: build `meta` from the raw `recordedClaims` column, and `access` and `aud` arrive.
  it('records who wrote each snapshot as `read` does, with no `access` and no `aud`', async () => {
    const { admin, atA } = await twoNodes();
    const { snapshots } = await admin.resources.query(OPEN);
    const queried = snapshots.find((s) => s.resourceId === atA[0])!;
    const read = await admin.resources.read('Deal', atA[0]);
    expect(queried.meta.recordedClaims).toEqual(read!.meta.recordedClaims);
    expect(Object.keys(queried.meta.recordedClaims).sort()).toEqual(['profileId', 'sub']);
    expect(queried.meta).toEqual(read!.meta);
    admin[Symbol.dispose]();
  });

  describe('the read check', () => {
    const entries: Array<{ namespace: string; message: string; data?: Record<string, unknown> }> = [];
    beforeEach(() => { entries.length = 0; setDebugSink((entry) => { entries.push(entry as never); }); });
    afterEach(() => clearDebugSink());

    // MUTATION: evaluate `read` per result rather than per node, and the line names six.
    it('evaluates each node once, however many results sit under it', async () => {
      const { admin, a, b, first } = await twoNodes(3);
      await admin.orgTree.setPermission(a, first.sub, 'read');
      using member = await pageClient(first);
      entries.length = 0;

      const result = await member.resources.query(OPEN);
      expect(result.snapshots).toHaveLength(3);
      const checked = entries.filter((e) =>
        e.namespace === 'nebula.Resources.query' && e.message === 'read checked' && e.data?.sub === first.sub);
      expect(checked.map((e) => (e.data!.nodes as string[]).slice().sort())).toEqual([[a, b].sort()]);
      admin[Symbol.dispose]();
    });
  });

  // MUTATION: drop the version gate from `requests.query`, and the stale page's read is answered.
  it('answers a page on another version stale, as `read` does', async () => {
    const universe = uniqueScope('q');
    const login = await loginAt(universe);
    using current = await pageClient(login);
    const id = await deal(current, ROOT_NODE_ID, 'Acme');
    const told: Array<OntologyStaleInfo | BuildStaleInfo> = [];
    using old = await pageClient(login, 'tab2', 'v0', (info) => { told.push(info); });

    const refused = await old.resources.query(OPEN).then(() => undefined, (e: unknown) => e);
    expect(isOntologyStaleError(refused)).toBe(true);
    expect(refused).toMatchObject({ clientVersion: 'v0', currentVersion: ONTOLOGY_VERSION });
    expect(told).toEqual([{ reason: 'ontology-stale', clientVersion: 'v0', currentVersion: ONTOLOGY_VERSION }]);
    // `read` from the same page is answered the same way.
    const readRefused = await old.resources.read('Deal', id).then(() => undefined, (e: unknown) => e);
    expect(isOntologyStaleError(readRefused)).toBe(true);
  });

  // MUTATION: answer `matches` rather than the capped slice, and a thousand and one arrive.
  it(`answers at most ${QUERY_RESULT_CAP} snapshots, and says when the query matched more`, async () => {
    const universe = uniqueScope('q');
    using client = await pageClient(await loginAt(universe));
    await deal(client, ROOT_NODE_ID, 'installs the version');
    await env.STAR.getByName(universe).seedDealsForTest(QUERY_RESULT_CAP, ROOT_NODE_ID, 'open');
    const result = await client.resources.query(OPEN);
    expect(result.snapshots).toHaveLength(QUERY_RESULT_CAP);
    expect(result.more).toBe(true);
    expect(result.snapshots[0].resourceId).toBe('seed-00000');
  });

  it.each([
    ['a filter the engine refuses', { typeName: 'Deal', filter: { nope: 1 } }, 'Deal has no field "nope"'],
    ['a filter no index can look up', { typeName: 'Deal', filter: { owner: 'p1' } }, 'This filter would read every current Deal'],
    ['a descriptor that is not an object', 'Deal', 'A query names a type and a filter: { typeName, filter }'],
  ])('refuses %s, by the message a subscription is refused with', async (_what, query, expected) => {
    const universe = uniqueScope('q');
    using client = await pageClient(await loginAt(universe));
    await deal(client, ROOT_NODE_ID, 'Acme');
    expect(await message(client.resources.query(query as QueryDescriptor))).toContain(expected);
  });
});
