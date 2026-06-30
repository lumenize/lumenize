/**
 * Child 2 Phase 4 — query rerun on commit (Flow 3 trigger A): `#rerunQueriesForCommit`.
 *
 * The query channel re-delivers by RERUNNING live queries whose `typeName` was
 * touched, re-pushing the full membership (client replaces). Covered: create /
 * reparent-in / reparent-out / delete membership transitions (ordered); the
 * delivery split (no-denial shared payload vs has-denial individualized); an
 * unrelated typeName triggers NO push; a content-only edit reruns with unchanged
 * ids (idempotent); a read-denied resource stays absent.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot, TransactionResult } from '@lumenize/nebula';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const VERSION = 'v1';
const TYPES = [
  'interface Parent { name: string }',
  'interface Child { parent: Parent; label: string }',
].join('\n');
const uniqueStar = () => `c2r-${generateUuid().slice(0, 8)}.app.tenant-a`;

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
async function vf(c: NebulaClientTest, star: string, id: string): Promise<string> {
  c.callStarRead(star, VERSION, id);
  return (await waitForSuccess(c) as Snapshot).meta.validFrom;
}
/** Expected (validFrom, resourceId) order for a set of resource ids. */
async function ordered(c: NebulaClientTest, star: string, ids: string[]): Promise<string[]> {
  const m: Record<string, string> = {};
  for (const id of ids) m[id] = await vf(c, star, id);
  return [...ids].sort((x, y) => m[x] < m[y] ? -1 : m[x] > m[y] ? 1 : (x < y ? -1 : x > y ? 1 : 0));
}
async function nextPush(c: NebulaClientTest, prev: number) {
  await vi.waitFor(() => expect(c.queryUpdateCount).toBeGreaterThan(prev));
}

describe('child2 query rerun on commit (Phase 4)', () => {
  it('create / reparent-in / reparent-out / delete each re-push the correct ordered membership', async () => {
    const star = uniqueStar();
    const { client: a } = await admin(star);
    const { client: b } = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const P = generateUuid(), Q = generateUuid();
    const query = { queryType: 'parentChild' as const, typeName: 'Child', field: 'parent', value: P };

    b.callStarSubscribeQuery(star, query);
    await nextPush(b, 0);
    expect(b.lastQueryUpdate?.result.resourceIds).toEqual([]); // empty initially

    // create: c1 joins
    const c1 = generateUuid();
    let n = b.queryUpdateCount;
    const e1 = await commit(a, star, { [c1]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: P, label: 'c1' } } });
    await nextPush(b, n);
    expect(b.lastQueryUpdate?.result.resourceIds).toEqual([c1]);

    // create: c2 joins
    const c2 = generateUuid();
    n = b.queryUpdateCount;
    await commit(a, star, { [c2]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: P, label: 'c2' } } });
    await nextPush(b, n);
    expect(b.lastQueryUpdate?.result.resourceIds).toEqual(await ordered(a, star, [c1, c2]));

    // reparent-in: c3 starts under Q, then its parent field is edited to P
    const c3 = generateUuid();
    const e3 = await commit(a, star, { [c3]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: Q, label: 'c3' } } });
    n = b.queryUpdateCount;
    await commit(a, star, { [c3]: { op: 'put', eTag: e3[c3], value: { parent: P, label: 'c3' } } });
    await nextPush(b, n);
    expect(b.lastQueryUpdate?.result.resourceIds).toEqual(await ordered(a, star, [c1, c2, c3]));

    // reparent-out: c1's parent edited away to Q → leaves membership
    n = b.queryUpdateCount;
    await commit(a, star, { [c1]: { op: 'put', eTag: e1[c1], value: { parent: Q, label: 'c1' } } });
    await nextPush(b, n);
    expect(b.lastQueryUpdate?.result.resourceIds).toEqual(await ordered(a, star, [c2, c3]));

    // delete: c2 removed → leaves membership
    n = b.queryUpdateCount;
    await commit(a, star, { [c2]: { op: 'delete', eTag: (await commitETag(a, star, c2)) } });
    await nextPush(b, n);
    expect(b.lastQueryUpdate?.result.resourceIds).toEqual([c3]);

    a[Symbol.dispose](); b[Symbol.dispose]();
  });

  it('a mutation to an UNRELATED typeName triggers no query push', async () => {
    const star = uniqueStar();
    const { client: a } = await admin(star);
    const { client: b } = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const P = generateUuid();
    b.callStarSubscribeQuery(star, { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: P });
    await nextPush(b, 0);

    const baseline = b.queryUpdateCount;
    // Unrelated: a Parent-typed resource. typeName 'Parent' ∉ {Child} → no rerun.
    await commit(a, star, { [P]: { op: 'create', typeName: 'Parent', nodeId: ROOT_NODE_ID, value: { name: 'p' } } });
    // Related anchor: a Child create DOES push. When it lands, count must be
    // baseline+1 (only the related one). Mutation: drop the touched-type filter →
    // the unrelated Parent create also pushed → count baseline+2 → red.
    const c1 = generateUuid();
    await commit(a, star, { [c1]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: P, label: 'c1' } } });
    await nextPush(b, baseline);
    expect(b.lastQueryUpdate?.result.resourceIds).toEqual([c1]);
    expect(b.queryUpdateCount).toBe(baseline + 1);

    a[Symbol.dispose](); b[Symbol.dispose]();
  });

  it('content-only edit reruns with unchanged ids (idempotent client replace)', async () => {
    const star = uniqueStar();
    const { client: a } = await admin(star);
    const { client: b } = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const P = generateUuid();
    const c1 = generateUuid();
    const e = await commit(a, star, { [c1]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: P, label: 'c1' } } });
    b.callStarSubscribeQuery(star, { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: P });
    await nextPush(b, 0);
    expect(b.lastQueryUpdate?.result.resourceIds).toEqual([c1]);

    // Content-only edit (label changes, parent unchanged) → rerun, same membership.
    const n = b.queryUpdateCount;
    await commit(a, star, { [c1]: { op: 'put', eTag: e[c1], value: { parent: P, label: 'renamed' } } });
    await nextPush(b, n);
    expect(b.lastQueryUpdate?.result.resourceIds).toEqual([c1]); // unchanged set

    a[Symbol.dispose](); b[Symbol.dispose]();
  });

  it('delivery split: no-denial gets full ids; has-denial gets readable subset + deniedNodes', async () => {
    const star = uniqueStar();
    const { client: a, accessToken } = await admin(star);
    const P = generateUuid();
    a.callStarCreateNode(star, ROOT_NODE_ID, 'pub', 'Pub');
    await vi.waitFor(() => expect(a.lastResult).toBeDefined());
    const pub = a.lastResult as number;
    a.callStarCreateNode(star, ROOT_NODE_ID, 'priv', 'Priv');
    await vi.waitFor(() => expect(a.lastResult).toBeDefined());
    const priv = a.lastResult as number;

    // user granted read on pub only.
    const adminBrowser = new Browser();
    await browserLogin(adminBrowser, star, 'admin@example.com', star);
    await createSubject(adminBrowser, star, accessToken, 'coach@example.com');
    const { client: user, payload } = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'coach@example.com');
    a.callStarSetPermission(star, pub, payload.sub, 'read');
    await waitForSuccess(a);

    // A no-denial admin subscriber + the has-denial user, same query.
    const { client: b } = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const query = { queryType: 'parentChild' as const, typeName: 'Child', field: 'parent', value: P };
    b.callStarSubscribeQuery(star, query); await nextPush(b, 0);
    user.callStarSubscribeQuery(star, query); await nextPush(user, 0);

    // create c1 (pub, user-readable) + c2 (priv, denied) in one txn.
    const c1 = generateUuid(), c2 = generateUuid();
    const nb = b.queryUpdateCount, nu = user.queryUpdateCount;
    await commit(a, star, {
      [c1]: { op: 'create', typeName: 'Child', nodeId: pub, value: { parent: P, label: 'c1' } },
      [c2]: { op: 'create', typeName: 'Child', nodeId: priv, value: { parent: P, label: 'c2' } },
    });
    await nextPush(b, nb); await nextPush(user, nu);

    // No-denial admin: both ids.
    expect(b.lastQueryUpdate?.result.resourceIds).toEqual(await ordered(a, star, [c1, c2]));
    expect(b.lastQueryUpdate?.result.deniedNodes).toBeUndefined();
    // Has-denial user: only the readable id + the denied node. Mutation: broadcast
    // the no-denial payload to everyone → user would see c2 (denied) → red.
    expect(user.lastQueryUpdate?.result.resourceIds).toEqual([c1]);
    expect(user.lastQueryUpdate?.result.resourceIds).not.toContain(c2);
    expect(user.lastQueryUpdate?.result.deniedNodes).toEqual([priv]);

    a[Symbol.dispose](); b[Symbol.dispose](); user[Symbol.dispose]();
  });
});

/** Read a child's current eTag (for delete in the transitions test). */
async function commitETag(c: NebulaClientTest, star: string, id: string): Promise<string> {
  c.callStarRead(star, VERSION, id);
  return (await waitForSuccess(c) as Snapshot).meta.eTag;
}
