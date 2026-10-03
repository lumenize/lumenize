/**
 * What a permission change does to a subscriber, now that the server re-runs nothing on one.
 *
 * A grant or a revoke writes no resource, so nothing is sent at the time it lands. A client
 * watching the org tree — every client `createNebulaClient` builds — hears the tree change and
 * asks again for exactly what its last update denied, so a grant reaches it with no write. A client
 * not watching the tree learns of either at the next update to what it watches, from the write
 * that caused it. The demote-self-heal case at the end stays on the query row's stored dominion
 * verdict: it is derived per subscribe-time token, so a non-admin token stores 0 and is denied.
 *
 * The grant and revoke limbs drive the public API (`client.resources.*`), never a `callStar*`
 * initiator, because the client's own ask-again is part of what they test.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID, CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, DEFAULT_CHAT_ID } from '@lumenize/nebula';
import type { TransactionResult, QuerySubscriberRow, QueryDescriptor, Snapshot } from '@lumenize/nebula';
import { createNebulaClient } from '@lumenize/nebula/frontend';
import {
  adminClientAt, universeAdminClient, createInvitedClient, createPlatformAdminClient, browserLogin, createSubject, ORIGIN, pageOf,
} from '../../test-helpers';
import { NebulaClientTest } from './index';

const VERSION = 'v1';
const TYPES = [
  'interface Parent { name: string }',
  'interface Child { parent: Parent; label: string }',
].join('\n');
const CHAT_QUERY: QueryDescriptor = { queryType: 'parentChild', typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID };
const uniqueUniverse = () => `c2p-${crypto.randomUUID().slice(0, 8)}`;

async function waitForResult(c: NebulaClientTest) { await vi.waitFor(() => expect(c.callCompleted).toBe(true)); }
async function waitForSuccess(c: NebulaClientTest) { await waitForResult(c); expect(c.lastError).toBeUndefined(); return c.lastResult; }
async function admin(star: string) {
  const a = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  a.client.callStarInstallOntology(star, { version: VERSION, types: TYPES });
  await waitForResult(a.client);
  return a;
}
async function commit(c: NebulaClientTest, star: string, ops: Record<string, any>) {
  c.callStarTransaction(star, VERSION, ops);
  const r = await waitForSuccess(c) as TransactionResult;
  if (!r.ok) throw new Error('expected commit ok: ' + JSON.stringify(r));
  return r.eTags;
}
async function nextPush(c: NebulaClientTest, prev: number) {
  await vi.waitFor(() => expect(c.queryUpdateCount).toBeGreaterThan(prev));
}

/** A Star whose `priv` node holds one Child of `P` the member cannot read, and the member invited. */
async function privateChild() {
  const star = `${uniqueUniverse()}.app.tenant-a`;
  const { client: a, accessToken } = await admin(star);
  const P = crypto.randomUUID();
  const priv = await a.orgTree.createNode(crypto.randomUUID(), ROOT_NODE_ID, 'priv', 'Priv');
  const c1 = crypto.randomUUID();
  await commit(a, star, { [c1]: { op: 'create', typeName: 'Child', nodeId: priv, value: { parent: P, label: 'c1' } } });
  const adminBrowser = new Browser();
  await createSubject(adminBrowser, star, accessToken, 'coach@example.com');
  const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: P };
  return { star, a, P, priv, c1, query };
}

describe('a permission change and a query subscriber', () => {
  it('watching the tree: a grant with no write reveals what was denied — the query\'s ids and the resource', async () => {
    const { star, a, priv, c1, query } = await privateChild();
    const browser = new Browser();
    const { payload } = await browserLogin(browser, star, 'coach@example.com', star);
    const ctx = browser.context(pageOf(star));
    const member = createNebulaClient({
      baseUrl: pageOf(star), platformOrigin: ORIGIN, ontologyVersion: VERSION,
      fetch: ctx.fetch, WebSocket: ctx.WebSocket,
      sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
      onShouldRefreshUI: () => {},
    });
    await member.ready;
    await vi.waitFor(() => expect((member.store.lmz.orgTree.value as { nodes?: unknown })?.nodes).toBeInstanceOf(Map));

    using q = member.client.resources.subscribeQuery(query);
    await q.ready;
    expect(q.resourceIds).toEqual([]);
    expect(q.deniedNodes).toEqual([priv]);
    using r = member.client.resources.subscribe('Child', c1);
    expect(await r.snapshot).toBeNull();
    expect(r.deniedNodes).toEqual([priv]);
    let changes = 0;
    r.onChange(() => { changes++; });

    // GRANT read on priv — no resource write, so the tree change is the only thing that happens.
    // Mutation: drop the client's ask-again → neither the query nor the resource changes → red.
    await a.orgTree.setPermission(priv, payload.sub, 'read');
    await vi.waitFor(() => expect(q.resourceIds).toEqual([c1]));
    expect(q.deniedNodes).toEqual([]);
    await vi.waitFor(() => expect(r.deniedNodes).toEqual([]));
    expect(changes).toBe(1);
    const entry = member.store.resources.Child[c1];
    expect(entry.deniedNodes).toEqual([]);
    expect(entry.value).toEqual({ parent: query.value, label: 'c1' });

    a[Symbol.dispose]();
  });

  it('on the Galaxy too: a collaborator denied the chat is granted with no post, and sees the messages at the next tree change', async () => {
    // Where Studio grants a collaborator: the Galaxy hosts a tree like any plane, and the client
    // asks again there exactly as it does on a Star.
    const scope = `${uniqueUniverse()}.app`;
    const pair = { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope };
    const { client: owner, accessToken } = await universeAdminClient(
      NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, pair,
    );
    const posted = await owner.postUserMessage('before the grant');
    const adminBrowser = new Browser();
    await createSubject(adminBrowser, scope, accessToken, 'collaborator@example.com');
    const browser = new Browser();
    const { payload } = await browserLogin(browser, scope, 'collaborator@example.com', scope);
    const ctx = browser.context(pageOf(scope));
    const member = createNebulaClient({
      baseUrl: pageOf(scope), platformOrigin: ORIGIN, ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION, ...pair,
      fetch: ctx.fetch, WebSocket: ctx.WebSocket,
      sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
      onShouldRefreshUI: () => {},
    });
    await member.ready;
    await vi.waitFor(() => expect((member.store.lmz.orgTree.value as { nodes?: unknown })?.nodes).toBeInstanceOf(Map));

    using chat = member.client.resources.subscribeQuery(CHAT_QUERY);
    await chat.ready;
    expect(chat.resourceIds).toEqual([]);
    expect(chat.deniedNodes).toEqual([CHAT_NODE_ID]);

    // Mutation: drop the client's ask-again → the query never changes → red.
    await owner.orgTree.setPermission(CHAT_NODE_ID, payload.sub, 'read');
    await vi.waitFor(() => expect(chat.resourceIds).toContain(posted));
    expect(chat.deniedNodes).toEqual([]);
    owner[Symbol.dispose]();
  });

  it('not watching the tree: a grant with no write changes nothing, and the next write\'s push is the first to carry the new ids', async () => {
    const { star, a, P, priv, c1, query } = await privateChild();
    const { client: user, payload } = await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'coach@example.com');

    using q = user.resources.subscribeQuery(query);
    await q.ready;
    expect(q.deniedNodes).toEqual([priv]);
    const seen: string[][] = [];
    q.onChange(() => { seen.push([...q.resourceIds]); });

    await a.orgTree.setPermission(priv, payload.sub, 'read');
    const c2 = crypto.randomUUID();
    await commit(a, star, { [c2]: { op: 'create', typeName: 'Child', nodeId: priv, value: { parent: P, label: 'c2' } } });

    // Exactly one push since the grant, and it is the write's — it carries c2. Mutation: keep the
    // permission-change re-run wired under another name → a push carrying only [c1] comes first → red.
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));
    expect(seen).toEqual([[c1, c2]]);
    expect(q.deniedNodes).toEqual([]);

    a[Symbol.dispose](); user[Symbol.dispose]();
  });

  it('a revoke shows at the next write: the id is gone and its node denied', async () => {
    const { star, a, P, priv, c1, query } = await privateChild();
    const { client: user, payload } = await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'coach@example.com');
    await a.orgTree.setPermission(priv, payload.sub, 'read');

    using q = user.resources.subscribeQuery(query);
    await q.ready;
    expect(q.resourceIds).toEqual([c1]);

    await a.orgTree.revokePermission(priv, payload.sub);
    const c2 = crypto.randomUUID();
    await commit(a, star, { [c2]: { op: 'create', typeName: 'Child', nodeId: priv, value: { parent: P, label: 'c2' } } });
    await vi.waitFor(() => expect(q.deniedNodes).toEqual([priv]));
    expect(q.resourceIds).toEqual([]);

    a[Symbol.dispose](); user[Symbol.dispose]();
  });

  it('demote self-heal (D16): dominionOverHostAtSubscribe is derived per subscribe-time token', async () => {
    const universe = uniqueUniverse();
    const star = `${universe}.app.tenant-a`;
    // The Star's admin creates a private child.
    const { client: a, accessToken } = await admin(star);
    const P = crypto.randomUUID();
    a.callStarCreateNode(star, ROOT_NODE_ID, 'priv', 'Priv');
    await vi.waitFor(() => expect(a.lastResult).toBeDefined());
    const priv = a.lastResult as string;
    const c1 = crypto.randomUUID();
    await commit(a, star, { [c1]: { op: 'create', typeName: 'Child', nodeId: priv, value: { parent: P, label: 'c1' } } });
    const query = { queryType: 'parentChild' as const, typeName: 'Child', field: 'parent', value: P };

    // A second admin (access.scopeAdmin, NO DAG grant) subscribes → sees the private child via the
    // stored dominionOverHostAtSubscribe bypass; its row carries dominionOverHostAtSubscribe = 1.
    // ⚠️ PLATFORM bootstrap admin (`*`), not a second universe admin: one admin per universe
    // (`claim-universe` is the sole admin-minting path, slug unique), so the old
    // `universe-admin@example.com` identity is unmintable. `*` covers this Star.
    const { client: uni } = await createPlatformAdminClient(NebulaClientTest, new Browser(), star);
    uni.callStarSubscribeQuery(star, query);
    await nextPush(uni, 0);
    expect(uni.lastQueryUpdate?.result.resourceIds).toEqual([c1]); // bypass → sees it
    // Re-subscribe (same admin token, same client) → INSERT OR REPLACE → still ONE row.
    uni.callStarSubscribeQuery(star, query);
    await nextPush(uni, 0);

    // A NON-admin user (a demoted admin's token looks exactly like this: access.scopeAdmin
    // false, no DAG grant) subscribes the SAME query → its row stores dominionOverHostAtSubscribe = 0
    // → DENIED. Mutation: registerQuerySubscriber hardcodes dominionOverHostAtSubscribe = 1 (keeps the
    // stale bypass) → this non-admin would WRONGLY see c1 → red.
    const adminBrowser = new Browser();
    await createSubject(adminBrowser, star, accessToken, 'demoted@example.com');
    const { client: ex } = await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'demoted@example.com');
    ex.callStarSubscribeQuery(star, query);
    await nextPush(ex, 0);
    expect(ex.lastQueryUpdate?.result.resourceIds ?? []).toEqual([]);
    expect(ex.lastQueryUpdate?.result.deniedNodes).toEqual([priv]);

    // Inspect the stored dominionOverHostAtSubscribe flags: admin row = 1 (one row), ex row = 0.
    a.callStarInspectQuerySubscribers(star);
    const rows = await waitForSuccess(a) as QuerySubscriberRow[];
    const uniRows = rows.filter((r) => r.clientId === uni.lmz.instanceName);
    expect(uniRows).toHaveLength(1);
    expect(uniRows[0].dominionOverHostAtSubscribe).toBe(1);
    const exRow = rows.find((r) => r.clientId === ex.lmz.instanceName);
    expect(exRow?.dominionOverHostAtSubscribe).toBe(0);

    a[Symbol.dispose](); uni[Symbol.dispose](); ex[Symbol.dispose]();
  });
});
