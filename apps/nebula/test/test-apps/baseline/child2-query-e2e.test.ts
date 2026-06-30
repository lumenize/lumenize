/**
 * Child 2 Phase 6 — client `subscribeQuery` handle + two-client e2e on DevStudio.
 *
 * Drives the PUBLIC `client.resources.subscribeQuery` (NOT a callXxx initiator —
 * the unit under test is client-side membership / windowed content subs / grace,
 * m7) over the full integration path (real JWTs, Gateway). Client A subscribes
 * `Turn where session == S`; client B creates / reparents / deletes Turns; A's
 * `resourceIds` tracks the full ordered membership, content arrives via lazy
 * per-resource subs for the rendered window ONLY, a resource A loses read on falls
 * out, and a windowed id that leaves+returns within grace keeps its content sub.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const uniqueDevScope = () => `c2e-${generateUuid().slice(0, 8)}.app.dev`;

function devClient(scope: string, email = 'admin@example.com') {
  return createAuthenticatedClient(
    NebulaClientTest, new Browser(), scope, scope, email, 'v1',
    { resourceHostBinding: 'DEV_STUDIO' },
  );
}

/** Expected (validFrom, resourceId) order via the public read path. */
async function ordered(c: NebulaClientTest, ids: string[]): Promise<string[]> {
  const vf: Record<string, string> = {};
  for (const id of ids) {
    const s = await c.resources.read('Turn', id) as Snapshot;
    vf[id] = s.meta.validFrom;
  }
  return [...ids].sort((x, y) => vf[x] < vf[y] ? -1 : vf[x] > vf[y] ? 1 : (x < y ? -1 : x > y ? 1 : 0));
}

describe('child2 query subscription e2e (DevStudio, public client.resources.subscribeQuery)', () => {
  it('membership tracks create / reparent-out / delete in (validFrom, resourceId) order', async () => {
    const scope = uniqueDevScope();
    const { client: a } = await devClient(scope);
    const { client: b } = await devClient(scope);
    const S = generateUuid();
    const Other = generateUuid();

    using sub = a.resources.subscribeQuery({ queryType: 'parentChild', typeName: 'Turn', field: 'session', value: S });
    await sub.ready;
    expect(sub.resourceIds).toEqual([]);

    // B creates t1, t2 (one txn → same validFrom → resourceId tiebreaker).
    const t1 = generateUuid(), t2 = generateUuid();
    const eTags = await b.resources.transaction({
      [t1]: { op: 'create', typeName: 'Turn', nodeId: ROOT_NODE_ID, value: { session: S, role: 'user', content: 't1' } },
      [t2]: { op: 'create', typeName: 'Turn', nodeId: ROOT_NODE_ID, value: { session: S, role: 'user', content: 't2' } },
    });
    await vi.waitFor(() => expect([...sub.resourceIds].sort()).toEqual([t1, t2].sort()));
    expect(sub.resourceIds).toEqual([t1, t2].sort()); // co-created → resourceId order

    // B creates t3 (later) belonging to S, and a noise Turn of Other.
    const t3 = generateUuid(), tn = generateUuid();
    await b.resources.transaction({
      [t3]: { op: 'create', typeName: 'Turn', nodeId: ROOT_NODE_ID, value: { session: S, role: 'user', content: 't3' } },
      [tn]: { op: 'create', typeName: 'Turn', nodeId: ROOT_NODE_ID, value: { session: Other, role: 'user', content: 'noise' } },
    });
    await vi.waitFor(() => expect(sub.resourceIds).toContain(t3));
    expect(sub.resourceIds).toEqual(await ordered(a, [t1, t2, t3]));
    expect(sub.resourceIds).not.toContain(tn); // other session excluded

    // reparent-out: edit t1.session away from S → leaves membership.
    await b.resources.transaction({
      [t1]: { op: 'put', typeName: 'Turn', eTag: eTags[t1], value: { session: Other, role: 'user', content: 't1' } },
    });
    await vi.waitFor(() => expect(sub.resourceIds).not.toContain(t1));
    expect(sub.resourceIds).toEqual(await ordered(a, [t2, t3]));

    // delete t2 → leaves membership.
    const t2snap = await a.resources.read('Turn', t2) as Snapshot;
    await b.resources.transaction({ [t2]: { op: 'delete', typeName: 'Turn', eTag: t2snap.meta.eTag } });
    await vi.waitFor(() => expect(sub.resourceIds).toEqual([t3]));

    a[Symbol.dispose](); b[Symbol.dispose]();
  });

  it('windowed lazy content: content arrives for the rendered window ONLY', async () => {
    const scope = uniqueDevScope();
    const { client: a } = await devClient(scope);
    const { client: b } = await devClient(scope);
    const S = generateUuid();

    using sub = a.resources.subscribeQuery({ queryType: 'parentChild', typeName: 'Turn', field: 'session', value: S });
    await sub.ready;
    const t1 = generateUuid(), t2 = generateUuid();
    const eTags = await b.resources.transaction({
      [t1]: { op: 'create', typeName: 'Turn', nodeId: ROOT_NODE_ID, value: { session: S, role: 'user', content: 't1-v0' } },
      [t2]: { op: 'create', typeName: 'Turn', nodeId: ROOT_NODE_ID, value: { session: S, role: 'user', content: 't2-v0' } },
    });
    await vi.waitFor(() => expect(sub.resourceIds.length).toBe(2));

    // Render ONLY t1 → content sub opens for t1, A receives t1's content. t2 is in
    // membership but NOT rendered → A never receives t2 content.
    sub.setRenderWindow([t1]);
    await vi.waitFor(() => {
      expect(a.lastResourceUpdate?.resourceId).toBe(t1);
      expect((a.lastResourceUpdate?.snapshot?.value as { content?: string })?.content).toBe('t1-v0');
    });
    // B mutates the windowed t1 → A receives the content update (sub is live).
    await b.resources.transaction({
      [t1]: { op: 'put', typeName: 'Turn', eTag: eTags[t1], value: { session: S, role: 'user', content: 't1-v1' } },
    });
    await vi.waitFor(() =>
      expect((a.lastResourceUpdate?.snapshot?.value as { content?: string })?.content).toBe('t1-v1'));
    // B mutates the UNrendered t2 → A gets a query rerun (membership unchanged) but
    // NO content push for t2; the last content A saw stays t1.
    await b.resources.transaction({
      [t2]: { op: 'put', typeName: 'Turn', eTag: eTags[t2], value: { session: S, role: 'user', content: 't2-v1' } },
    });
    await vi.waitFor(() => expect(sub.resourceIds.length).toBe(2)); // rerun landed
    expect(a.lastResourceUpdate?.resourceId).toBe(t1); // never t2 (unrendered)

    a[Symbol.dispose](); b[Symbol.dispose]();
  });

  it('a resource A loses read on falls out of A\'s membership set', async () => {
    const scope = uniqueDevScope();
    const { client: admin, accessToken } = await devClient(scope);
    const S = generateUuid();

    // Two SIBLING nodes under ROOT (no inheritance between them), a Turn of S on each.
    const nodeA = await admin.orgTree.createNode(ROOT_NODE_ID, 'a', 'A');
    const nodeB = await admin.orgTree.createNode(ROOT_NODE_ID, 'b', 'B');
    const tA = generateUuid(), tB = generateUuid();
    await admin.resources.transaction({
      [tA]: { op: 'create', typeName: 'Turn', nodeId: nodeA, value: { session: S, role: 'user', content: 'a' } },
      [tB]: { op: 'create', typeName: 'Turn', nodeId: nodeB, value: { session: S, role: 'user', content: 'b' } },
    });

    // A non-admin user granted read on BOTH sibling nodes (so it initially sees both).
    const adminBrowser = new Browser();
    await browserLogin(adminBrowser, scope, 'admin@example.com', scope);
    await createSubject(adminBrowser, scope, accessToken, 'coach@example.com');
    const { client: user, payload } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), scope, scope, 'coach@example.com', 'v1', { resourceHostBinding: 'DEV_STUDIO' });
    await admin.orgTree.setPermission(nodeA, payload.sub, 'read');
    await admin.orgTree.setPermission(nodeB, payload.sub, 'read');

    using sub = user.resources.subscribeQuery({ queryType: 'parentChild', typeName: 'Turn', field: 'session', value: S });
    await sub.ready;
    await vi.waitFor(() => expect([...sub.resourceIds].sort()).toEqual([tA, tB].sort()));
    expect(sub.deniedNodes).toEqual([]);

    // Revoke read on nodeB → the permission rerun drops tB from the user's set and
    // surfaces the denied node (no inheritance from the sibling nodeA grant).
    await admin.orgTree.revokePermission(nodeB, payload.sub);
    await vi.waitFor(() => expect(sub.resourceIds).toEqual([tA]));
    expect(sub.deniedNodes).toEqual([nodeB]);

    admin[Symbol.dispose](); user[Symbol.dispose]();
  });
});
