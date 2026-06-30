/**
 * Child 2 Phase 5 — query rerun on permission change (Flow 3 trigger B / D6).
 *
 * The capability hangs an ALL-live-queries rerun off DagTree's `onChanged` (in
 * addition to the host hook). Covered: the grant hole (granting read with NO
 * resource write makes the newly-readable resources appear); revoking shrinks the
 * set + adds the node to `deniedNodes`; and the demote-self-heal foundation (D16) —
 * `accessAdmin` is derived per subscribe-time token, so a non-admin token stores
 * `accessAdmin = 0` and is denied (a demoted admin's re-subscribe clears the bypass).
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { TransactionResult, QuerySubscriberRow } from '@lumenize/nebula';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const VERSION = 'v1';
const TYPES = [
  'interface Parent { name: string }',
  'interface Child { parent: Parent; label: string }',
].join('\n');
const uniqueUniverse = () => `c2p-${generateUuid().slice(0, 8)}`;

async function waitForResult(c: NebulaClientTest) { await vi.waitFor(() => expect(c.callCompleted).toBe(true)); }
async function waitForSuccess(c: NebulaClientTest) { await waitForResult(c); expect(c.lastError).toBeUndefined(); return c.lastResult; }
async function admin(star: string) {
  const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  a.client.callStarApplyOntology(star, { version: VERSION, types: TYPES });
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

describe('child2 query rerun on permission change (Phase 5)', () => {
  it('grant hole: granting read (no resource write) reveals members; revoke shrinks + denies', async () => {
    const star = `${uniqueUniverse()}.app.tenant-a`;
    const { client: a, accessToken } = await admin(star);
    const P = generateUuid();
    a.callStarCreateNode(star, ROOT_NODE_ID, 'priv', 'Priv');
    await vi.waitFor(() => expect(a.lastResult).toBeDefined());
    const priv = a.lastResult as number;
    const c1 = generateUuid();
    await commit(a, star, { [c1]: { op: 'create', typeName: 'Child', nodeId: priv, value: { parent: P, label: 'c1' } } });

    // A non-admin user with NO grant subscribes → denied push.
    const adminBrowser = new Browser();
    await browserLogin(adminBrowser, star, 'admin@example.com', star);
    await createSubject(adminBrowser, star, accessToken, 'coach@example.com');
    const { client: user, payload } = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'coach@example.com');
    user.callStarSubscribeQuery(star, { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: P });
    await nextPush(user, 0);
    expect(user.lastQueryUpdate?.result.resourceIds ?? []).toEqual([]);
    expect(user.lastQueryUpdate?.result.deniedNodes).toEqual([priv]);

    // GRANT read on priv — NO resource write. The permission-change rerun (trigger B)
    // is the ONLY thing that can update the screen. Mutation: skip the permission
    // trigger → user never sees c1 → red.
    let n = user.queryUpdateCount;
    a.callStarSetPermission(star, priv, payload.sub, 'read');
    await waitForSuccess(a);
    await nextPush(user, n);
    expect(user.lastQueryUpdate?.result.resourceIds).toEqual([c1]);
    expect(user.lastQueryUpdate?.result.deniedNodes).toBeUndefined();

    // REVOKE → rerun → set shrinks back to empty + the node returns to deniedNodes.
    n = user.queryUpdateCount;
    a.callStarRevokePermission(star, priv, payload.sub);
    await waitForSuccess(a);
    await nextPush(user, n);
    expect(user.lastQueryUpdate?.result.resourceIds ?? []).toEqual([]);
    expect(user.lastQueryUpdate?.result.deniedNodes).toEqual([priv]);

    a[Symbol.dispose](); user[Symbol.dispose]();
  });

  it('demote self-heal (D16): accessAdmin is derived per subscribe-time token', async () => {
    const universe = uniqueUniverse();
    const star = `${universe}.app.tenant-a`;
    // Founder star-admin first (sole ROOT admin grant) creates a private child.
    const { client: a, accessToken } = await admin(star);
    const P = generateUuid();
    a.callStarCreateNode(star, ROOT_NODE_ID, 'priv', 'Priv');
    await vi.waitFor(() => expect(a.lastResult).toBeDefined());
    const priv = a.lastResult as number;
    const c1 = generateUuid();
    await commit(a, star, { [c1]: { op: 'create', typeName: 'Child', nodeId: priv, value: { parent: P, label: 'c1' } } });
    const query = { queryType: 'parentChild' as const, typeName: 'Child', field: 'parent', value: P };

    // A UNIVERSE admin (access.admin, NO DAG grant) subscribes → sees the private
    // child via the stored accessAdmin bypass; its row carries accessAdmin = 1.
    const { client: uni } = await createAuthenticatedClient(NebulaClientTest, new Browser(), universe, star, 'universe-admin@example.com');
    uni.callStarSubscribeQuery(star, query);
    await nextPush(uni, 0);
    expect(uni.lastQueryUpdate?.result.resourceIds).toEqual([c1]); // bypass → sees it
    // Re-subscribe (same admin token, same client) → INSERT OR REPLACE → still ONE row.
    uni.callStarSubscribeQuery(star, query);
    await nextPush(uni, 0);

    // A NON-admin user (a demoted admin's token looks exactly like this: access.admin
    // false, no DAG grant) subscribes the SAME query → its row stores accessAdmin = 0
    // → DENIED. Mutation: registerQuerySubscriber hardcodes accessAdmin = 1 (keeps the
    // stale bypass) → this non-admin would WRONGLY see c1 → red.
    const adminBrowser = new Browser();
    await browserLogin(adminBrowser, star, 'admin@example.com', star);
    await createSubject(adminBrowser, star, accessToken, 'demoted@example.com');
    const { client: ex } = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'demoted@example.com');
    ex.callStarSubscribeQuery(star, query);
    await nextPush(ex, 0);
    expect(ex.lastQueryUpdate?.result.resourceIds ?? []).toEqual([]);
    expect(ex.lastQueryUpdate?.result.deniedNodes).toEqual([priv]);

    // Inspect the stored accessAdmin flags: admin row = 1 (one row), ex row = 0.
    a.callStarInspectQuerySubscribers(star);
    const rows = await waitForSuccess(a) as QuerySubscriberRow[];
    const uniRows = rows.filter((r) => r.clientId === uni.lmz.instanceName);
    expect(uniRows).toHaveLength(1);
    expect(uniRows[0].accessAdmin).toBe(1);
    const exRow = rows.find((r) => r.clientId === ex.lmz.instanceName);
    expect(exRow?.accessAdmin).toBe(0);

    a[Symbol.dispose](); uni[Symbol.dispose](); ex[Symbol.dispose]();
  });
});
