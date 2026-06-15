/**
 * Reconnect re-subscribe — Phase 5.3.4a
 *
 * On WebSocket reconnect (a `reconnecting → connected` state transition),
 * NebulaClient walks its `#subscriptionRegistry` and re-issues `Star.subscribe`
 * for every entry. Star's `INSERT OR REPLACE` makes this idempotent and pushes
 * a fresh initial snapshot back via `handleResourceUpdate`.
 *
 * Two angles:
 *
 *   - **Direct unit-of-behavior**: a test-only `_resubscribeAllForTest()` hook
 *     on `NebulaClient` invokes the same internal walk that the state-machine
 *     wiring calls in production. Lets us verify resubscribe semantics
 *     (registry → Star → snapshot push → write-through) without depending on
 *     unsolicited WS-close machinery in the test harness.
 *
 *   - **Integration smoke**: trigger a real `reconnecting → connected`
 *     transition by abusing the Gateway's supersede mechanism — construct a
 *     second client with the same `instanceName` + `accessToken`, the Gateway
 *     closes the first client's socket with `WS_CLOSE_SUPERSEDED` (4409), the
 *     first client schedules a reconnect, and the resubscribe walk fires
 *     automatically when it lands. Dispose of the second client immediately
 *     to avoid ping-pong on the first client's reconnect.
 *
 * The state-machine wiring itself (the `prev === 'reconnecting' && state ===
 * 'connected'` check in the constructor's `onConnectionStateChange` callback)
 * is small and visually obvious; the connection-state transitions are
 * separately covered by mesh-level tests at
 * `packages/mesh/test/lumenize-client.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { TransactionResult, SubscriberRow } from '@lumenize/nebula';
import { createAuthenticatedClient, ORIGIN } from '../../test-helpers';
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
  title = 'Initial',
): Promise<string> {
  client.callStarTransaction(star, ONTOLOGY_VERSION, {
    [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title } },
  });
  const result = await waitForSuccess(client) as TransactionResult;
  if (!result.ok) throw new Error('Expected create ok');
  return result.eTags[resourceId];
}

async function setupSubscribedClient(star: string) {
  const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');

  const galaxyName = star.split('.').slice(0, 2).join('.');
  a.client.callGalaxyAppendOntologyVersion(galaxyName, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
  await waitForResult(a.client);

  const resourceId = generateUuid();
  await createResource(a.client, star, resourceId);

  // Subscribe via the public API so #subscriptionRegistry is populated —
  // that's what #resubscribeAll() walks. (The test-initiator
  // `callStarSubscribe` bypasses the registry by calling lmz directly.)
  await a.client.resources.subscribe('TestResource', resourceId);
  // resourceUpdateCount is incremented inside the NebulaClientTest override
  // of handleResourceUpdate, which fires once on the initial-snapshot push.
  expect(a.client.resourceUpdateCount).toBeGreaterThanOrEqual(1);

  return { a, resourceId };
}

describe('nebula-client reconnect re-subscribe (5.3.4a)', () => {

  it('_resubscribeAllForTest re-issues subscribe for every registry entry', async () => {
    const star = uniqueStar();
    const { a, resourceId } = await setupSubscribedClient(star);

    // Capture the row's pre-resubscribe state.
    a.client.callStarInspectSubscribers(star);
    const rowsBefore = await waitForSuccess(a.client) as SubscriberRow[];
    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0].resourceId).toBe(resourceId);
    const subscribedAtBefore = rowsBefore[0].subscribedAt;

    // Drop the Subscribers table — without our resubscribe walk, the row
    // stays gone and no fanouts would reach a.client.
    a.client.callStarClearSubscribersForTest(star);
    await waitForResult(a.client);

    a.client.callStarInspectSubscribers(star);
    const rowsAfterClear = await waitForSuccess(a.client) as SubscriberRow[];
    expect(rowsAfterClear).toHaveLength(0);

    // Capture the baseline AFTER the inspect calls — each test initiator on
    // NebulaClientTest calls `resetResults()` which zeroes resourceUpdateCount.
    // The signal we care about is "did Star push another snapshot back?", so
    // we read the count just before triggering the walk.
    const countBeforeResubscribe = a.client.resourceUpdateCount;

    // Invoke the resubscribe walk — same logic that fires on a real
    // `reconnecting → connected` transition.
    a.client._resubscribeAllForTest();

    // Star receives the subscribe, INSERTs the row, and pushes the current
    // snapshot back via handleResourceUpdate. resourceUpdateCount increments.
    await vi.waitFor(() => {
      expect(a.client.resourceUpdateCount).toBeGreaterThan(countBeforeResubscribe);
    });

    a.client.callStarInspectSubscribers(star);
    const rowsAfter = await waitForSuccess(a.client) as SubscriberRow[];
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0].resourceId).toBe(resourceId);
    // INSERT OR REPLACE sets a fresh subscribedAt — proof Star processed the call.
    expect(rowsAfter[0].subscribedAt).not.toBe(subscribedAtBefore);
  });

  it('supersede-triggered reconnect resubscribes automatically', async () => {
    const star = uniqueStar();
    const { a } = await setupSubscribedClient(star);
    const initialUpdateCount = a.client.resourceUpdateCount;

    // Construct a second client with the same instanceName + accessToken.
    // Gateway sees an existing socket for this instanceName, closes it with
    // WS_CLOSE_SUPERSEDED (4409). a.client's #handleClose routes that to
    // #scheduleReconnect → state → 'reconnecting' → 1s backoff → reconnect.
    const aInstanceName = a.client.lmz.instanceName;
    const browserB = new Browser();
    const b = new NebulaClientTest({
      baseUrl: ORIGIN,
      authScope: star,
      activeScope: star,
      appVersion: ONTOLOGY_VERSION,
      instanceName: aInstanceName,
      accessToken: a.accessToken,
      fetch: browserB.fetch,
      WebSocket: browserB.WebSocket,
    });

    // a.client should observe the supersede close and enter 'reconnecting'.
    await vi.waitFor(() => { expect(a.client.connectionState).toBe('reconnecting'); });

    // Dispose b before its connect-and-supersede cycle can ping-pong with
    // a.client's pending reconnect. disconnect() nulls b's WS handlers
    // synchronously, so even if Gateway closes b's socket later, b doesn't
    // try to reconnect.
    b.disconnect();

    // a.client's reconnect timer (1s backoff) fires, a.client reconnects.
    // The `reconnecting → connected` transition triggers #resubscribeAll(),
    // which lmz.calls STAR.subscribe for the registered (rt, rid). Star
    // pushes the current snapshot back via handleResourceUpdate →
    // resourceUpdateCount increments.
    await vi.waitFor(() => { expect(a.client.connectionState).toBe('connected'); });
    await vi.waitFor(() => {
      expect(a.client.resourceUpdateCount).toBeGreaterThan(initialUpdateCount);
    });
  });

});
