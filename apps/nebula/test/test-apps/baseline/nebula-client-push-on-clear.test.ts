/**
 * Push-on-clear ontology-stale notification — Phase 5.3.4b
 *
 * When `Star.#installState()` upgrades the cached ontology, it drops the
 * `Subscribers` table (`Subscriptions.clear()` returns the distinct
 * `(subscriberBinding, clientId)` pairs that were dropped). Before the rows
 * go away, Star sends each such subscriber a single `OntologyStaleError`
 * push via the existing fanout plumbing using sentinel rt='' / rid=''.
 *
 * The client's `handleResourceUpdate` already routes `OntologyStaleError`
 * into `#dispatchOntologyStale` regardless of which `(rt, rid)` pair carried
 * it. The server doesn't store per-subscriber `clientVersion` on the
 * Subscribers row, so the wire's `clientVersion` is empty and the client
 * substitutes its own pinned version.
 *
 * Two angles tested here:
 *   1. **Grouping**: a single client with N subscribed resources receives
 *      exactly **one** notification (distinct on `(binding, clientId)`),
 *      not N.
 *   2. **Version substitution**: the `OntologyStaleInfo` passed to
 *      `onShouldRefreshUI` carries the client's pinned `clientVersion`
 *      (substituted from the empty wire value) and Star's new
 *      `currentVersion`.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { OntologyStaleInfo, TransactionResult, SubscriberRow } from '@lumenize/nebula';
import { createAuthenticatedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

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
  ontologyVersion: string,
): Promise<string> {
  client.callStarTransaction(star, ontologyVersion, {
    [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Initial' } },
  });
  const result = await waitForSuccess(client) as TransactionResult;
  if (!result.ok) throw new Error('Expected create ok');
  return result.eTags[resourceId];
}

describe('nebula-client push-on-clear ontology-stale (5.3.4b)', () => {

  it('client subscribed to N resources receives one onShouldRefreshUI on version install', async () => {
    const star = uniqueStar();
    const galaxyName = star.split('.').slice(0, 2).join('.');
    const refreshHookSpy = vi.fn<(info: OntologyStaleInfo) => void>();

    // Build a v1-pinned client with the refresh hook registered. The hook is
    // the user-facing signal that push-on-clear arrived.
    const a = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), star, star, 'admin@example.com',
      'v1',
      { onShouldRefreshUI: refreshHookSpy },
    );

    // Register v1 ontology on Galaxy. The first op at v1 will install it on
    // Star (cache miss → fetch → install). prevLatest is empty before that
    // first install, so push-on-clear does NOT fire for it (#installState
    // skips clear when there's no prior version — see star.ts).
    a.client.callStarApplyOntology(star, { version: 'v1', types: TEST_TYPES });
    await waitForResult(a.client);

    // Create 3 resources at v1 (this also lazily installs v1 on Star).
    const resourceIds = [generateUuid(), generateUuid(), generateUuid()];
    for (const rid of resourceIds) {
      await createResource(a.client, star, rid, 'v1');
    }

    // Subscribe via the public API so #subscriptionRegistry is populated and
    // Star's Subscribers table gets a row per (rt, rid).
    for (const rid of resourceIds) {
      await a.client.resources.subscribe('TestResource', rid).snapshot;
    }

    // Verify 3 rows exist on Star — proves we have N>1 rows mapping to the
    // same (binding, clientId), the case grouping needs to dedupe.
    a.client.callStarInspectSubscribers(star);
    const rowsBefore = await waitForSuccess(a.client) as SubscriberRow[];
    expect(rowsBefore).toHaveLength(3);

    // Setup may have fired the spy at most zero times (no version bump yet
    // — v1 was the first install). Reset to a known-clean baseline before
    // triggering the v2 install.
    refreshHookSpy.mockReset();

    // Append v2 to Galaxy.
    a.client.callStarApplyOntology(star, { version: 'v2', types: TEST_TYPES });
    await waitForResult(a.client);

    // Trigger Star.#installState(v2): use a v2 read via per-call override.
    // Star's cache is at v1 → cache miss → Galaxy returns v2 state → doRead
    // sees fetchedState.row.version === ontologyVersion (both v2) → installState
    // → Subscribers cleared + push-on-clear fires.
    await a.client.resources.read('TestResource', resourceIds[0], { appVersion: 'v2' });

    // The push-on-clear arrives via handleResourceUpdate(sentinel-rt, sentinel-rid,
    // OntologyStaleError). The client's #dispatchOntologyStale substitutes the
    // pinned 'v1' for the wire's empty clientVersion. Wait briefly for the
    // mesh callback to land.
    await vi.waitFor(() => { expect(refreshHookSpy).toHaveBeenCalled(); });

    // Grouping invariant: exactly one notification, not three (one per row).
    expect(refreshHookSpy).toHaveBeenCalledTimes(1);

    // Version substitution invariant: clientVersion is the pinned 'v1',
    // currentVersion is the newly-installed 'v2'.
    expect(refreshHookSpy).toHaveBeenCalledWith({
      reason: 'ontology-stale',
      clientVersion: 'v1',
      currentVersion: 'v2',
    });

    // Subscribers table is now empty — push-on-clear ran after the drop.
    a.client.callStarInspectSubscribers(star);
    const rowsAfter = await waitForSuccess(a.client) as SubscriberRow[];
    expect(rowsAfter).toHaveLength(0);
  });

});
