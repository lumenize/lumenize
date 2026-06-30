/**
 * Child 2 Phase 3 — enumerateCurrentByField + QuerySubs registry + subscribeQuery
 * surface + initial push (Flow 1), on Star with a Parent/Child ontology.
 *
 * Covered: query evaluation (type/deleted/other-parent exclusion + (validFrom,
 * resourceId) ordering), no-denial vs has-denial delivery + onPartial, M3 canonical-
 * hash idempotency (one row for reordered/omitted-default queries), fail-closed
 * validation (unknown queryType, non-to-one field), register-succeeds-when-all-denied,
 * and m1 (ontology install signals a query-sub-only client).
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID, canonicalQueryHash } from '@lumenize/nebula';
import type { Snapshot, TransactionResult, QuerySubscriberRow } from '@lumenize/nebula';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const VERSION = 'v1';
// Child.parent is the to-one relationship (write shape: by-id string).
const TYPES = [
  'interface Parent { name: string }',
  'interface Child { parent: Parent; label: string }',
].join('\n');

const uniqueStar = () => `c2-${generateUuid().slice(0, 8)}.app.tenant-a`;

async function waitForResult(c: NebulaClientTest) {
  await vi.waitFor(() => expect(c.callCompleted).toBe(true));
}
async function waitForSuccess(c: NebulaClientTest) {
  await waitForResult(c);
  expect(c.lastError).toBeUndefined();
  return c.lastResult;
}
async function admin(star: string) {
  const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  a.client.callStarApplyOntology(star, { version: VERSION, types: TYPES });
  await waitForResult(a.client);
  return a;
}
/** Commit a batch; returns the eTags map. */
async function commit(c: NebulaClientTest, star: string, ops: Record<string, any>) {
  c.callStarTransaction(star, VERSION, ops);
  const r = await waitForSuccess(c) as TransactionResult;
  if (!r.ok) throw new Error('expected commit ok: ' + JSON.stringify(r));
  return r.eTags;
}
async function readValidFrom(c: NebulaClientTest, star: string, rid: string): Promise<string> {
  c.callStarRead(star, VERSION, rid);
  const snap = await waitForSuccess(c) as Snapshot;
  return snap.meta.validFrom;
}
async function awaitQueryPush(c: NebulaClientTest) {
  await vi.waitFor(() => expect(c.queryUpdateCount).toBeGreaterThanOrEqual(1));
}

describe('child2 query subscriptions (Phase 3)', () => {
  it('initial push: correct membership (type/deleted/other-parent excluded), (validFrom,resourceId) order', async () => {
    const star = uniqueStar();
    const { client: a } = await admin(star);
    const P = generateUuid();
    const Q = generateUuid();

    // Two children of P co-created in ONE txn (same validFrom → resourceId tiebreaker).
    const c1 = generateUuid(), c2 = generateUuid();
    await commit(a, star, {
      [c1]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: P, label: 'c1' } },
      [c2]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: P, label: 'c2' } },
    });
    // A third child of P in a later txn.
    const c3 = generateUuid();
    await commit(a, star, {
      [c3]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: P, label: 'c3' } },
    });
    // Noise that must NOT appear: a child of a DIFFERENT parent, a deleted child of P,
    // and a Parent-typed resource sharing the P id space.
    const cOther = generateUuid(), cDel = generateUuid();
    const eTags = await commit(a, star, {
      [cOther]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: Q, label: 'other' } },
      [cDel]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: P, label: 'doomed' } },
      [P]: { op: 'create', typeName: 'Parent', nodeId: ROOT_NODE_ID, value: { name: 'the parent' } },
    });
    await commit(a, star, { [cDel]: { op: 'delete', eTag: eTags[cDel] } });

    // Expected order: the three live P-children sorted by (validFrom, resourceId).
    // Read actual validFroms so the assertion is robust to cross-txn same-ms ties.
    const vf: Record<string, string> = {};
    for (const id of [c1, c2, c3]) vf[id] = await readValidFrom(a, star, id);
    const expected = [c1, c2, c3].sort((x, y) =>
      vf[x] < vf[y] ? -1 : vf[x] > vf[y] ? 1 : (x < y ? -1 : x > y ? 1 : 0));

    // A second admin (no-denial) subscribes the parentChild query.
    const { client: b } = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const query = { queryType: 'parentChild' as const, typeName: 'Child', field: 'parent', value: P };
    b.callStarSubscribeQuery(star, query);
    await awaitQueryPush(b);

    expect(b.lastQueryError).toBeUndefined();
    // No-denial subscriber: full resourceIds, no deniedNodes. Mutation: drop the
    // value[field] filter in enumerate → cOther leaks in → red.
    expect(b.lastQueryUpdate?.result.resourceIds).toEqual(expected);
    expect(b.lastQueryUpdate?.result.deniedNodes).toBeUndefined();
    expect(b.lastQueryUpdate?.result.resourceIds).not.toContain(cOther);
    expect(b.lastQueryUpdate?.result.resourceIds).not.toContain(cDel);
    expect(b.lastQueryUpdate?.result.resourceIds).not.toContain(P);
    // Correlates by the LOCALLY-computable canonical hash (subscribeQuery is void).
    expect(b.lastQueryUpdate?.queryHash).toBe(canonicalQueryHash(query));

    a[Symbol.dispose](); b[Symbol.dispose]();
  });

  it('M3: reordered keys / omitted-vs-explicit defaults collapse to ONE queryHash + one row', async () => {
    const star = uniqueStar();
    const { client: a } = await admin(star);
    const P = generateUuid();
    const c1 = generateUuid();
    await commit(a, star, {
      [c1]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: P, label: 'c1' } },
    });

    // Two logically-equal forms: omitted defaults vs explicit defaults + reordered keys.
    const formA = { queryType: 'parentChild' as const, typeName: 'Child', field: 'parent', value: P };
    const formB = { value: P, field: 'parent', typeName: 'Child', orderBy: 'validFrom' as const,
                    onPartial: 'allow' as const, queryType: 'parentChild' as const };
    expect(canonicalQueryHash(formA)).toBe(canonicalQueryHash(formB));

    a.callStarSubscribeQuery(star, formA);
    await awaitQueryPush(a);
    a.callStarSubscribeQuery(star, formB);
    await awaitQueryPush(a);

    a.callStarInspectQuerySubscribers(star);
    const rows = await waitForSuccess(a) as QuerySubscriberRow[];
    // One client, one canonical query → exactly one row (idempotent re-subscribe).
    expect(rows.filter((r) => r.clientId === a.lmz.instanceName)).toHaveLength(1);
    expect(rows[0].queryHash).toBe(canonicalQueryHash(formA));

    a[Symbol.dispose]();
  });

  it('fail-closed validation: unknown queryType + non-to-one field reject (Error push, no row)', async () => {
    const star = uniqueStar();
    const { client: a } = await admin(star);

    // Unknown queryType.
    a.callStarSubscribeQuery(star, { queryType: 'mongoLike' as any, typeName: 'Child', field: 'parent', value: 'P' });
    await vi.waitFor(() => expect(a.lastQueryError).toBeDefined());
    expect(a.lastQueryError?.message).toMatch(/queryType/i);

    // Non-to-one field ('label' is a scalar, not a relationship).
    a.callStarSubscribeQuery(star, { queryType: 'parentChild', typeName: 'Child', field: 'label', value: 'x' });
    await vi.waitFor(() => expect(a.lastQueryError).toBeDefined());
    expect(a.lastQueryError?.message).toMatch(/to-one relationship/i);

    // Nothing registered (fail closed).
    a.callStarInspectQuerySubscribers(star);
    const rows = await waitForSuccess(a) as QuerySubscriberRow[];
    expect(rows).toHaveLength(0);

    a[Symbol.dispose]();
  });

  it('has-denial subscriber: onPartial allow → {resourceIds, deniedNodes}; error → {deniedNodes} only', async () => {
    const star = uniqueStar();
    const { client: adminC, accessToken } = await admin(star);
    const P = generateUuid();

    // c1 on ROOT (user readable once granted); c2 on a private node (never granted).
    adminC.callStarCreateNode(star, ROOT_NODE_ID, 'pub', 'Pub');
    await vi.waitFor(() => expect(adminC.lastResult).toBeDefined());
    const pubNode = adminC.lastResult as number;
    adminC.callStarCreateNode(star, ROOT_NODE_ID, 'priv', 'Priv');
    await vi.waitFor(() => expect(adminC.lastResult).toBeDefined());
    const privNode = adminC.lastResult as number;

    const c1 = generateUuid(), c2 = generateUuid();
    await commit(adminC, star, {
      [c1]: { op: 'create', typeName: 'Child', nodeId: pubNode, value: { parent: P, label: 'c1' } },
      [c2]: { op: 'create', typeName: 'Child', nodeId: privNode, value: { parent: P, label: 'c2' } },
    });

    // A non-admin user granted read on pubNode only.
    const adminBrowser = new Browser();
    await browserLogin(adminBrowser, star, 'admin@example.com', star);
    await createSubject(adminBrowser, star, accessToken, 'coach@example.com');
    const { client: user, payload } =
      await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'coach@example.com');
    adminC.callStarSetPermission(star, pubNode, payload.sub, 'read');
    await waitForSuccess(adminC);

    // onPartial: 'allow' (default) → readable resourceIds + deniedNodes.
    user.callStarSubscribeQuery(star, { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: P, onPartial: 'allow' });
    await awaitQueryPush(user);
    expect(user.lastQueryUpdate?.result.resourceIds).toEqual([c1]);
    expect(user.lastQueryUpdate?.result.deniedNodes).toEqual([privNode]);

    // onPartial: 'error' (same query → same hash, replaces row) → deniedNodes only.
    user.callStarSubscribeQuery(star, { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: P, onPartial: 'error' });
    await awaitQueryPush(user);
    expect(user.lastQueryUpdate?.result.resourceIds).toBeUndefined();
    expect(user.lastQueryUpdate?.result.deniedNodes).toEqual([privNode]);

    adminC[Symbol.dispose](); user[Symbol.dispose]();
  });

  it('register succeeds even when every match is denied (just deniedNodes, no rejection)', async () => {
    const star = uniqueStar();
    const { client: adminC, accessToken } = await admin(star);
    const P = generateUuid();
    adminC.callStarCreateNode(star, ROOT_NODE_ID, 'priv', 'Priv');
    await vi.waitFor(() => expect(adminC.lastResult).toBeDefined());
    const privNode = adminC.lastResult as number;
    const c1 = generateUuid();
    await commit(adminC, star, {
      [c1]: { op: 'create', typeName: 'Child', nodeId: privNode, value: { parent: P, label: 'c1' } },
    });

    const adminBrowser = new Browser();
    await browserLogin(adminBrowser, star, 'admin@example.com', star);
    await createSubject(adminBrowser, star, accessToken, 'nope@example.com');
    const { client: user } =
      await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'nope@example.com');

    user.callStarSubscribeQuery(star, { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: P });
    await awaitQueryPush(user);
    // Registration succeeded (no error), the push is deniedNodes-only (allow + empty readable).
    expect(user.lastQueryError).toBeUndefined();
    expect(user.lastQueryUpdate?.result.deniedNodes).toEqual([privNode]);
    expect(user.lastQueryUpdate?.result.resourceIds ?? []).toEqual([]);

    // The row IS registered (authorize-at-delivery, not at registration).
    adminC.callStarInspectQuerySubscribers(star);
    const rows = await waitForSuccess(adminC) as QuerySubscriberRow[];
    expect(rows.some((r) => r.clientId === user.lmz.instanceName)).toBe(true);

    adminC[Symbol.dispose](); user[Symbol.dispose]();
  });

  it('m1: an ontology install signals a query-sub-ONLY client with one OntologyStaleError', async () => {
    const star = uniqueStar();
    const { client: a } = await admin(star);
    const P = generateUuid();
    await commit(a, star, {
      [generateUuid()]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: P, label: 'c1' } },
    });

    // A second client with ONLY a query sub (no single-resource sub).
    const { client: b } = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    b.callStarSubscribeQuery(star, { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: P });
    await awaitQueryPush(b);
    b.resetResults(); // clear lastErrorObject before the install

    // Install v2, then trigger the install via a v2 read → #installState clears BOTH
    // registries and pushes one stale signal per (binding, client) union (m1).
    a.callStarApplyOntology(star, { version: 'v2', types: TYPES });
    await waitForResult(a);
    a.callStarRead(star, 'v2', P);
    await waitForResult(a);

    // The query-sub-only client receives the OntologyStaleError. Mutation: skip
    // query-sub clients in #installState → b never gets signaled → red.
    await vi.waitFor(() => {
      expect(b.lastErrorObject?.name).toBe('OntologyStaleError');
    });

    a[Symbol.dispose](); b[Symbol.dispose]();
  });
});
