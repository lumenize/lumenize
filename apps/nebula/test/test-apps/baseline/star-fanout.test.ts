/**
 * Star fanout on mutation — Phase 5.3.2
 *
 * Tests that mutations on a Star fan out to non-originator subscribers via
 * `handleResourceUpdate`, that originators are excluded (BroadcastChannel
 * semantics), and that ontology-version installs clear the Subscribers
 * registry.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot, TransactionResult, SubscriberRow } from '@lumenize/nebula';
import { createAuthenticatedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

// Two distinct admin clients on the same Star — different browsers means
// different Gateway instances means different `clientId`s, even though the
// underlying `sub` (user identity) is the same. Sufficient for fanout
// testing: originator exclusion is keyed on `clientId`.
async function twoAdminClients(star: string) {
  const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');

  const galaxyName = star.split('.').slice(0, 2).join('.');
  a.client.callStarApplyOntology(star, {
    version: ONTOLOGY_VERSION,
    types: TEST_TYPES,
  });
  await waitForResult(a.client);

  const b = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  return { a, b };
}

async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => {
    expect(client.callCompleted).toBe(true);
  });
}

async function waitForSuccess(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}

async function createResource(
  client: NebulaClientTest,
  star: string,
  resourceId: string,
  title = 'Test Task',
  nodeId = ROOT_NODE_ID,
): Promise<string> {
  client.callStarTransaction(star, ONTOLOGY_VERSION, {
    [resourceId]: { op: 'create', typeName: 'TestResource', nodeId, value: { title } },
  });
  const result = await waitForSuccess(client) as TransactionResult;
  if (!result.ok) throw new Error('Expected create ok');
  return result.eTags[resourceId];
}

// Wait until the count reaches at least `n`. Used to assert that fanout
// from another client has arrived (subscribe delivers the initial push,
// then each fanout increments).
async function waitForUpdateCount(client: NebulaClientTest, n: number) {
  await vi.waitFor(() => {
    expect(client.resourceUpdateCount).toBeGreaterThanOrEqual(n);
  });
}

describe('star-fanout', () => {

  it('subscriber receives fanout on mutation by another client', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const resourceId = generateUuid();
    const eTag = await createResource(a.client, star, resourceId, 'Initial');

    // b subscribes
    b.client.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', resourceId);
    await waitForUpdateCount(b.client, 1); // initial push from subscribe
    expect(b.client.lastResourceUpdate?.snapshot?.value.title).toBe('Initial');

    // a mutates
    a.client.callStarTransaction(star, ONTOLOGY_VERSION, {
      [resourceId]: { op: 'put', eTag, value: { title: 'Updated by A' } },
    });
    await waitForSuccess(a.client);

    // b should now have received the fanout
    await waitForUpdateCount(b.client, 2);
    expect(b.client.lastResourceUpdate!.resourceType).toBe('TestResource');
    expect(b.client.lastResourceUpdate!.resourceId).toBe(resourceId);
    const snap = b.client.lastResourceUpdate!.snapshot as Snapshot;
    expect(snap.value.title).toBe('Updated by A');
    expect(snap.meta.eTag).not.toBe(eTag); // new eTag from the update
    expect(snap.meta.deleted).toBe(false);

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('originator excluded from own mutation fanout (BroadcastChannel)', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const resourceId = generateUuid();
    const eTag = await createResource(a.client, star, resourceId, 'Initial');

    // Both a and b subscribe to the same resource
    a.client.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', resourceId);
    await waitForUpdateCount(a.client, 1);
    b.client.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', resourceId);
    await waitForUpdateCount(b.client, 1);

    // a mutates — handleTransactionResult fires on a; fanout should reach b
    // but NOT a (originator). callStarTransaction's resetResults() zeroes
    // a's resourceUpdateCount, so the assertion is: a.count stays 0
    // through the entire mutation cycle while b's count climbs to 2.
    a.client.callStarTransaction(star, ONTOLOGY_VERSION, {
      [resourceId]: { op: 'put', eTag, value: { title: 'Self-mutation' } },
    });
    await waitForSuccess(a.client); // handleTransactionResult fires for a
    await waitForUpdateCount(b.client, 2); // proves fanout completed

    // If originator-exclusion is working, a never got fanout for its own write.
    // (callStarTransaction did reset a's count to 0, and only a non-self-fanout
    // would push it back above 0.)
    expect(a.client.resourceUpdateCount).toBe(0);
    expect(b.client.lastResourceUpdate?.snapshot?.value.title).toBe('Self-mutation');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('multiple subscribers receive same fanout', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    // Spin up a third client (also admin, distinct browser → distinct clientId)
    const c = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');

    const resourceId = generateUuid();
    const eTag = await createResource(a.client, star, resourceId, 'Initial');

    b.client.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', resourceId);
    await waitForUpdateCount(b.client, 1);
    c.client.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', resourceId);
    await waitForUpdateCount(c.client, 1);

    a.client.callStarTransaction(star, ONTOLOGY_VERSION, {
      [resourceId]: { op: 'put', eTag, value: { title: 'Broadcast' } },
    });
    await waitForSuccess(a.client);

    await waitForUpdateCount(b.client, 2);
    await waitForUpdateCount(c.client, 2);

    expect(b.client.lastResourceUpdate?.snapshot?.value.title).toBe('Broadcast');
    expect(c.client.lastResourceUpdate?.snapshot?.value.title).toBe('Broadcast');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
    c.client[Symbol.dispose]();
  });

  it('subscribers to other resources unaffected', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const r1 = generateUuid();
    const r2 = generateUuid();
    const eTag2 = await createResource(a.client, star, r2, 'R2 initial');
    await createResource(a.client, star, r1, 'R1 initial');

    // b subscribes to r1 only
    b.client.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', r1);
    await waitForUpdateCount(b.client, 1);
    const countAfterSub = b.client.resourceUpdateCount;

    // a mutates r2 (not r1)
    a.client.callStarTransaction(star, ONTOLOGY_VERSION, {
      [r2]: { op: 'put', eTag: eTag2, value: { title: 'R2 updated' } },
    });
    await waitForSuccess(a.client);

    // Brief wait for any (unwanted) fanout to settle; b's count should not move.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(b.client.resourceUpdateCount).toBe(countAfterSub);

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('delete fans out snapshot with meta.deleted=true (not null)', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const resourceId = generateUuid();
    const eTag = await createResource(a.client, star, resourceId, 'About to be deleted');

    b.client.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', resourceId);
    await waitForUpdateCount(b.client, 1);

    a.client.callStarTransaction(star, ONTOLOGY_VERSION, {
      [resourceId]: { op: 'delete', eTag },
    });
    await waitForSuccess(a.client);

    await waitForUpdateCount(b.client, 2);
    const snap = b.client.lastResourceUpdate!.snapshot as Snapshot;
    expect(snap).not.toBeNull();
    expect(snap.meta.deleted).toBe(true);
    // Value carries through from the pre-delete snapshot per resources.ts
    // semantics (soft delete preserves the last value).
    expect(snap.value.title).toBe('About to be deleted');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('ontology version install clears all Subscribers rows', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const resourceId = generateUuid();
    await createResource(a.client, star, resourceId, 'v1 resource');

    // b subscribes under v1
    b.client.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', resourceId);
    await waitForUpdateCount(b.client, 1);

    // Inspect: 1 row
    a.client.callStarInspectSubscribers(star);
    const before = await waitForSuccess(a.client) as SubscriberRow[];
    expect(before).toHaveLength(1);

    // Register v2 on Galaxy
    const galaxyName = star.split('.').slice(0, 2).join('.');
    a.client.callStarApplyOntology(star, {
      version: 'v2',
      types: TEST_TYPES,
    });
    await waitForResult(a.client);

    // Trigger Star to install v2 by issuing a v2 read — this exercises the
    // cache-miss → Galaxy fetch → #installState path, which calls
    // Subscriptions.clear() when prevLatest !== row.version.
    a.client.callStarRead(star, 'v2', resourceId);
    await waitForResult(a.client);

    // Inspect: 0 rows after install
    a.client.callStarInspectSubscribers(star);
    const after = await waitForSuccess(a.client) as SubscriberRow[];
    expect(after).toHaveLength(0);

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });
});
