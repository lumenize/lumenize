/**
 * Drop-on-failed-fanout subscriber cleanup — Phase 5.3.5
 *
 * When a client closes its WebSocket and doesn't reconnect within the
 * Gateway's grace period, that client's `Subscribers` rows leak. The
 * cleanup mechanism is **reactive**, not proactive: the next time `Star.#broadcast`
 * (via `this.svc.broadcast`) tries to push to that client, the Gateway returns
 * `ClientDisconnectedError`, and Star's `onBroadcastResult` handler — the `onResult`
 * partial `svc.broadcast` completes per target — deletes the offending row inline.
 *
 * For "quiet" resources that nobody mutates after the disconnect, the row
 * stays leaked until the next deploy's push-on-clear (5.3.4b) catches it.
 * Acceptable cost — storage is trivial and the leak is bounded.
 *
 * Test config: `LUMENIZE_MESH_GRACE_PERIOD_MS=100` in the baseline miniflare
 * bindings (see vitest.config.js) so the grace period elapses fast enough
 * to keep tests under a second.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { TransactionResult, SubscriberRow } from '@lumenize/nebula';
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

async function createResource(
  client: NebulaClientTest,
  star: string,
  resourceId: string,
): Promise<string> {
  client.callStarTransaction(star, ONTOLOGY_VERSION, {
    [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Initial' } },
  });
  const result = await waitForSuccess(client) as TransactionResult;
  if (!result.ok) throw new Error('Expected create ok');
  return result.eTags[resourceId];
}

describe('drop-on-failed-fanout subscriber cleanup (5.3.5)', () => {

  it('disconnected subscriber row is dropped on next fanout attempt', async () => {
    const star = uniqueStar();

    // Client A and client B both connected, both subscribed to the same resource.
    const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const galaxyName = star.split('.').slice(0, 2).join('.');
    a.client.callGalaxyAppendOntologyVersion(galaxyName, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
    await waitForResult(a.client);

    const resourceId = generateUuid();
    const eTag = await createResource(a.client, star, resourceId);

    const b = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');

    // Both subscribe via the public API so registries are populated and Star
    // has both rows in Subscribers.
    await a.client.resources.subscribe('TestResource', resourceId).snapshot;
    await b.client.resources.subscribe('TestResource', resourceId).snapshot;

    // Sanity: 2 rows in Subscribers (one per clientId, same resourceId).
    a.client.callStarInspectSubscribers(star);
    const rowsBefore = await waitForSuccess(a.client) as SubscriberRow[];
    expect(rowsBefore).toHaveLength(2);
    const bClientId = b.client.lmz.instanceName;

    // Disconnect b. b's WebSocket closes; b's Gateway sets the grace alarm
    // for 100 ms (per vitest.config.js LUMENIZE_MESH_GRACE_PERIOD_MS).
    b.client.disconnect();

    // Wait past the grace period so b's Gateway is fully "disconnected"
    // (no active WS, no pending alarm). Generous margin to absorb any
    // miniflare-induced latency.
    await new Promise((r) => setTimeout(r, 500));

    // a triggers a mutation. Star.#broadcast fans out via svc.broadcast; one of
    // its targets is b (disconnected). The push to b's Gateway returns
    // ClientDisconnectedError → onBroadcastResult deletes b's row inline.
    a.client.callStarTransaction(star, ONTOLOGY_VERSION, {
      [resourceId]: { op: 'put', eTag, value: { title: 'Updated by a' } },
    });
    await waitForSuccess(a.client);

    // Wait for the fanout-delivery handler to settle the cleanup.
    await vi.waitFor(async () => {
      a.client.callStarInspectSubscribers(star);
      const rows = await waitForSuccess(a.client) as SubscriberRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0].clientId).not.toBe(bClientId);
    });
  });

  it('successful fanout does NOT trigger cleanup (success path is a no-op)', async () => {
    const star = uniqueStar();

    const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const galaxyName = star.split('.').slice(0, 2).join('.');
    a.client.callGalaxyAppendOntologyVersion(galaxyName, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
    await waitForResult(a.client);

    const resourceId = generateUuid();
    const eTag = await createResource(a.client, star, resourceId);

    const b = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    await a.client.resources.subscribe('TestResource', resourceId).snapshot;
    await b.client.resources.subscribe('TestResource', resourceId).snapshot;

    // b stays connected. a mutates. Star fans out to b successfully.
    a.client.callStarTransaction(star, ONTOLOGY_VERSION, {
      [resourceId]: { op: 'put', eTag, value: { title: 'Updated' } },
    });
    await waitForSuccess(a.client);

    // Wait for b's resourceUpdateCount to bump (proof the fanout landed).
    await vi.waitFor(() => {
      expect(b.client.resourceUpdateCount).toBeGreaterThanOrEqual(2);
    });

    // Both rows should still be present — the success path of
    // onBroadcastResult must not delete rows.
    a.client.callStarInspectSubscribers(star);
    const rowsAfter = await waitForSuccess(a.client) as SubscriberRow[];
    expect(rowsAfter).toHaveLength(2);
  });

});
