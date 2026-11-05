/**
 * `ClientResources` restores what a Client subscribed to when its host may have lost it: on the
 * reconnect after the host reports a loss, and on the reconnect after a token whose admin verdict
 * changed.
 *
 * vitest-plugin rather than `/live`, for what each limb has to do that no running system lets a
 * scenario do on demand. The first evicts the host node and deletes its subscription rows, standing
 * in for the reapers a failed push would have run, then reads the rows back from the host's storage.
 * The second demotes an admin, which no product path does yet, and lets the token lapse on a clock
 * the Worker and every Durable Object follow (`vi.setSystemTime`). `resubscribe-when-lost` drives the
 * losses a scenario can cause, through Nebula's pages.
 *
 * The Client is a real `NebulaClient`, refreshing off the platform host's cookie as a page's does,
 * logged in through Mesh's Registry (ADR-009 rung 2) and connected to `ResourcesHostDO`.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { REGISTRY_INSTANCE_NAME } from '@lumenize/mesh/auth';
import { NebulaClient, ROOT_NODE_ID } from '@lumenize/resources/client';
import type { QueryDescriptor } from '@lumenize/resources';
import { PLATFORM } from '../../mesh/test/auth/test-helpers';
import { loginAt, uniqueScope, type Login } from '../../mesh/test/support/login';
import { ONTOLOGY_VERSION } from './test-worker';

/** A `NebulaClient` on `login`'s page, holding the platform host's refresh cookie as a browser does. */
async function pageClient(login: Login, beforeConnect?: (client: NebulaClient) => void): Promise<NebulaClient> {
  const browser = new Browser();
  browser.setCookie(login.cookie.name, login.cookie.value, { domain: new URL(PLATFORM).hostname, path: '/' });
  const page = browser.context(login.baseUrl);
  const client = new NebulaClient({
    instanceName: `${login.sub}.tab1`, baseUrl: login.baseUrl, platformOrigin: PLATFORM,
    ontologyVersion: ONTOLOGY_VERSION, fetch: page.fetch, WebSocket: page.WebSocket,
  });
  beforeConnect?.(client);
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
  return client;
}

/** The host's subscription rows for one Client, by kind. */
async function rowsOf(host: string, clientAddress: string): Promise<Array<{ kind: string; dominion: number | null }>> {
  return runInDurableObject(env.STAR.getByName(host), (_i: unknown, ctx: DurableObjectState) =>
    ctx.storage.sql.exec(
      `SELECT kind, dominionOverHostAtSubscribe AS dominion FROM Subscriptions WHERE clientAddress = ? ORDER BY kind`,
      clientAddress,
    ).toArray() as Array<{ kind: string; dominion: number | null }>);
}

/** A Board and a Note on it, created by `client`; returns their ids. */
async function boardWithNote(client: NebulaClient): Promise<{ boardId: string; noteId: string }> {
  const boardId = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  const outcome = await client.resources.transaction({
    [boardId]: { op: 'create', typeName: 'Board', nodeId: ROOT_NODE_ID, value: { title: 'b' } },
    [noteId]: { op: 'create', typeName: 'Note', nodeId: ROOT_NODE_ID, value: { title: 'n', board: boardId } },
  });
  expect(outcome.kind).toBe('committed');
  return { boardId, noteId };
}

describe('ClientResources restores its subscriptions', { timeout: 60000 }, () => {
  // MUTATIONS, each a loop of `#restoreSubscriptions` skipped in turn: the resource subscriptions,
  // the queries, the rosters, the org tree. Each leaves its kind's row missing after the reconnect.
  it('on the reconnect after the host reports them lost: resources, queries, rosters and the org tree', async () => {
    const universe = uniqueScope('r');
    const login = await loginAt(universe); // the universe's first login, its admin
    // The tree listener goes on before the first connection, as the factory's does, so the tree is
    // subscribed from the start.
    using client = await pageClient(login, (c) => c.onOrgTreeUpdate(() => {}));
    const address = `STAR/${universe}/${client.lmz.instanceName}`;

    const { boardId, noteId } = await boardWithNote(client);
    using note = client.resources.subscribe('Note', noteId);
    await note.snapshot;
    const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Note', field: 'board', value: boardId };
    using notes = client.resources.subscribeQuery(query);
    await notes.ready;
    using roster = client.subscribeQuerySubscribers(query);
    await roster.ready;
    const every = ['query', 'resource', 'roster', 'tree'];
    await vi.waitFor(async () => expect((await rowsOf(universe, address)).map((r) => r.kind)).toEqual(every));

    // What the host's reapers would have dropped after failed pushes, then an evicted host, whose
    // reconnecting Clients it has no record of, so each is told `subscriptionRequired: true`.
    await runInDurableObject(env.STAR.getByName(universe), (_i: unknown, ctx: DurableObjectState) => {
      ctx.storage.sql.exec('DELETE FROM Subscriptions WHERE clientAddress = ?', address);
    });
    expect(await rowsOf(universe, address)).toEqual([]);
    await runInDurableObject(env.STAR.getByName(universe), (_i: unknown, ctx: DurableObjectState) => {
      ctx.abort('a host evicted, in a test');
    }).catch(() => { /* the abort rejects the call that ordered it */ });
    await vi.waitFor(() => expect(client.connectionState).toBe('reconnecting'), { timeout: 5000 });
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });

    await vi.waitFor(async () => expect((await rowsOf(universe, address)).map((r) => r.kind)).toEqual(every),
      { timeout: 10000 });
  });

  // MUTATION: never mark the verdict changed in `onClaimsChange`, and the row keeps the admin's.
  it('on the reconnect after a token whose admin verdict changed', async () => {
    const universe = uniqueScope('r');
    const login = await loginAt(universe);
    using client = await pageClient(login);
    const address = `STAR/${universe}/${client.lmz.instanceName}`;
    const { noteId } = await boardWithNote(client);
    using note = client.resources.subscribe('Note', noteId);
    await note.snapshot;
    expect((await rowsOf(universe, address)).map((r) => r.dominion)).toEqual([1]);

    const claims = client.claims;
    await (env.AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME) as unknown as {
      setIdentityAdmin(sub: string, scopeAdmin: boolean, callerClaims: unknown): Promise<void>;
    }).setIdentityAdmin(claims.sub, false, claims);

    // The token lapses, so the next call rotates the socket onto a freshly minted, demoted one.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + 20 * 60_000);
      // The org tree, which every member may read (ADR-008), so the call itself succeeds demoted.
      await client.lmz.callAsync('STAR', universe, (client.ctn() as any).resources.orgTree.getState());
      await vi.waitFor(async () => expect((await rowsOf(universe, address)).map((r) => r.dominion)).toEqual([0]),
        { timeout: 10000 });
    } finally {
      vi.useRealTimers();
    }
  });
});
