/**
 * OrgTree dedicated channel (Phase 5.3.7-v3 / P8 server side).
 *
 * The org/permission tree is NOT a resource — it's a per-Star singleton on its
 * own channel: `subscribeTree` registers in `TreeSubscribers` (keyed by clientId
 * alone), and every tree mutation broadcasts the synthesized `getState()` to ALL
 * subscribers INCLUDING the originator (no optimistic local write, so the echo is
 * the only update path). Delivery is `handleOrgTreeUpdate` — wholly separate from
 * the resource `handleResourceUpdate` path.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { TransactionResult } from '@lumenize/nebula';
import { createAuthenticatedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
}
async function waitForSuccess(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}

async function twoAdminClients(star: string) {
  const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  const galaxyName = star.split('.').slice(0, 2).join('.');
  a.client.callStarApplyOntology(star, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
  await waitForResult(a.client);
  const b = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  return { a, b, galaxyName };
}

async function createResource(client: NebulaClientTest, star: string, resourceId: string, title = 'Test'): Promise<string> {
  client.callStarTransaction(star, ONTOLOGY_VERSION, {
    [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title } },
  });
  const result = await waitForSuccess(client) as TransactionResult;
  if (!result.ok) throw new Error('Expected create ok');
  return result.eTags[resourceId];
}

type TreeState = { nodes: Map<number, { slug: string; label: string }>; edges: Set<string>; permissions: Map<number, unknown> };

describe('orgTree dedicated channel (P8 server)', () => {
  it('subscribeTree registers a TreeSubscribers row and pushes the initial snapshot', async () => {
    const star = uniqueStar();
    const { a } = await twoAdminClients(star);

    a.client.callStarSubscribeTree(star);
    await vi.waitFor(() => expect(a.client.orgTreeUpdateCount).toBeGreaterThan(0));
    // Wire fidelity: nodes Map + edges Set survive the structured-clone hop.
    const tree = a.client.lastOrgTree as TreeState;
    expect(tree.nodes).toBeInstanceOf(Map);
    expect(tree.edges).toBeInstanceOf(Set);
    expect(tree.nodes.has(ROOT_NODE_ID)).toBe(true);

    a.client.callStarInspectTreeSubscribers(star);
    expect(await waitForSuccess(a.client)).toHaveLength(1);

    a.client[Symbol.dispose]();
  });

  it('a tree mutation broadcasts to all subscribers INCLUDING the originator', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);

    a.client.callStarSubscribeTree(star);
    await vi.waitFor(() => expect(a.client.orgTreeUpdateCount).toBeGreaterThan(0));
    b.client.callStarSubscribeTree(star);
    await vi.waitFor(() => expect(b.client.orgTreeUpdateCount).toBeGreaterThan(0));
    const bBaseline = b.client.orgTreeUpdateCount;

    // A mutates the tree. A is the ORIGINATOR and still receives the echo
    // (unlike resource fanout, which excludes the originator).
    a.client.callStarCreateNode(star, ROOT_NODE_ID, 'team', 'Team'); // resets a's captures
    await waitForSuccess(a.client); // createNode result

    await vi.waitFor(() => {
      expect(a.client.orgTreeUpdateCount).toBeGreaterThan(0); // originator got the echo
      const tA = a.client.lastOrgTree as TreeState;
      expect([...tA.nodes.values()].some((n) => n.slug === 'team')).toBe(true);
    });
    await vi.waitFor(() => {
      expect(b.client.orgTreeUpdateCount).toBeGreaterThan(bBaseline); // 2nd subscriber got it too
      const tB = b.client.lastOrgTree as TreeState;
      expect([...tB.nodes.values()].some((n) => n.slug === 'team')).toBe(true);
    });

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('the tree subscription survives an ontology install (resource Subscribers cleared, TreeSubscribers not)', async () => {
    const star = uniqueStar();
    const { a, galaxyName } = await twoAdminClients(star);

    // Install v1 (a real op) so the v2 install below is a genuine version change.
    await createResource(a.client, star, generateUuid(), 'v1-seed');
    a.client.callStarSubscribeTree(star);
    await vi.waitFor(() => expect(a.client.orgTreeUpdateCount).toBeGreaterThan(0));

    // Append v2 + trigger its install (a v2 op cache-misses → Star fetches + installs
    // → #installState clears resource Subscribers; it must NOT touch TreeSubscribers).
    a.client.callStarApplyOntology(star, { version: 'v2', types: TEST_TYPES });
    await waitForSuccess(a.client);
    a.client.callStarTransaction(star, 'v2', {
      [generateUuid()]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'v2' } },
    });
    await waitForResult(a.client);

    a.client.callStarInspectTreeSubscribers(star);
    expect(await waitForSuccess(a.client)).toHaveLength(1); // survived the install

    a.client[Symbol.dispose]();
  });

  it('no cross-channel leak: resource fanout and tree broadcast are fully isolated (+ positive control)', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);

    // A real resource whose resourceId collides with the tree's conceptual name.
    const rid = 'orgTree';
    const eTag = await createResource(a.client, star, rid, 'a real resource');

    // A subscribes BOTH the resource and the tree.
    a.client.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', rid);
    await vi.waitFor(() => expect(a.client.resourceUpdateCount).toBeGreaterThan(0));
    a.client.callStarSubscribeTree(star); // resets A's captures → resourceUpdateCount=0, orgTreeUpdateCount→1
    await vi.waitFor(() => expect(a.client.orgTreeUpdateCount).toBe(1));
    expect(a.client.resourceUpdateCount).toBe(0); // reset by the subscribeTree initiator

    // B mutates the RESOURCE (B originator → A gets the resource fanout).
    b.client.callStarTransaction(star, ONTOLOGY_VERSION, {
      [rid]: { op: 'put', eTag, value: { title: 'mutated' } },
    });
    await vi.waitFor(() => expect(a.client.resourceUpdateCount).toBe(1)); // POSITIVE: resource delivered
    expect(a.client.orgTreeUpdateCount).toBe(1); // NO LEAK: tree channel untouched by the resource mutation

    // B mutates the TREE (broadcast → A, the only tree subscriber).
    b.client.callStarCreateNode(star, ROOT_NODE_ID, 'leak-check', 'Leak Check');
    await vi.waitFor(() => expect(a.client.orgTreeUpdateCount).toBe(2)); // POSITIVE: tree delivered
    expect(a.client.resourceUpdateCount).toBe(1); // NO LEAK: resource channel untouched by the tree mutation

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  // ── P8b: client.orgTree.* mutators (awaited callRaw, reject-on-failure) ──

  it('client.orgTree mutators resolve on success and reject on failure', async () => {
    const star = uniqueStar();
    const { a } = await twoAdminClients(star);

    const nodeId = await a.client.orgTree.createNode(ROOT_NODE_ID, 'team', 'Team');
    expect(typeof nodeId).toBe('number');
    expect(nodeId).toBeGreaterThan(ROOT_NODE_ID);

    await a.client.orgTree.relabelNode(nodeId, 'Renamed Team'); // resolves (void)
    await a.client.orgTree.setPermission(nodeId, generateUuid(), 'write'); // resolves

    // Reject-on-failure: deleting a non-existent node → NodeNotFoundError rejects
    // the awaited call (NOT connection-gated, NOT swallowed).
    await expect(a.client.orgTree.deleteNode(999999)).rejects.toThrow();

    a.client[Symbol.dispose]();
  });

  it('a client.orgTree mutation broadcasts the updated tree back to a subscriber (originator)', async () => {
    const star = uniqueStar();
    const { a } = await twoAdminClients(star);

    a.client.callStarSubscribeTree(star); // resets captures → initial snapshot lands
    await vi.waitFor(() => expect(a.client.orgTreeUpdateCount).toBeGreaterThan(0));
    const before = a.client.orgTreeUpdateCount; // orgTree.* is callRaw (NOT a resetting initiator)

    const nodeId = await a.client.orgTree.createNode(ROOT_NODE_ID, 'team2', 'Team2');
    await vi.waitFor(() => {
      expect(a.client.orgTreeUpdateCount).toBeGreaterThan(before);
      const tree = a.client.lastOrgTree as TreeState;
      expect(tree.nodes.has(nodeId)).toBe(true);
      expect([...tree.nodes.values()].some((n) => n.slug === 'team2')).toBe(true);
    });

    a.client[Symbol.dispose]();
  });
});
