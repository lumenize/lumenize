/**
 * Reconnect re-subscribe: what a reconnect restores, and what it leaves alone.
 *
 * A Client re-subscribes exactly when its host node says it lost something, never on a network blip
 * or a token rotation inside the grace period. Two angles:
 *
 *   - **The walk itself**: a test-only `_restoreSubscriptionsForTest()` hook runs the same walk
 *     `onSubscriptionRequired` runs, so the test can assert what one re-subscribe does — registry →
 *     Star → snapshot push → a fresh row — without first losing a subscription.
 *
 *   - **A supersede**: a second client with the same `instanceName` and `accessToken` makes the
 *     host node close the first one's socket with 4409. The first reconnects while the second is still
 *     connected, so it supersedes in turn and is told `subscriptionRequired: false` — this project's
 *     grace period is 100 ms, so a supersede is how a reconnect here keeps its record. It
 *     re-subscribes nothing, and its row keeps delivering.
 *
 * The 4408 and grace-expiry paths that DO re-subscribe are driven live by `resubscribe-when-lost`.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/resources';
import type { TransactionResult, SubscriberRow } from '@lumenize/resources';
import { adminClientAt, ORIGIN, pageOf } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

function uniqueStar(): string {
  return `acme-${crypto.randomUUID().slice(0, 8)}.app.tenant-a`;
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
  const a = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');

  const galaxyName = star.split('.').slice(0, 2).join('.');
  a.client.callStarInstallOntology(star, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
  await waitForResult(a.client);

  const resourceId = crypto.randomUUID();
  await createResource(a.client, star, resourceId);

  // Subscribe via the public API so #subscriptionRegistry is populated —
  // that's what #restoreSubscriptions() walks. (The test-initiator
  // `callStarSubscribe` bypasses the registry by calling lmz directly.)
  await a.client.resources.subscribe('TestResource', resourceId).snapshot;
  // resourceUpdateCount is incremented inside the NebulaClientTest override
  // of handleResourceUpdate, which fires once on the initial-snapshot push.
  expect(a.client.resourceUpdateCount).toBeGreaterThanOrEqual(1);

  return { a, resourceId };
}

describe('nebula-client reconnect re-subscribe (5.3.4a)', () => {

  it('_restoreSubscriptionsForTest re-issues subscribe for every registry entry', async () => {
    const star = uniqueStar();
    const { a, resourceId } = await setupSubscribedClient(star);

    // Capture the row's pre-resubscribe state.
    a.client.callStarInspectSubscribers(star);
    const rowsBefore = await waitForSuccess(a.client) as SubscriberRow[];
    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0].resourceId).toBe(resourceId);
    const subscribedAtBefore = rowsBefore[0].subscribedAt;

    // Delete the resource rows — without our resubscribe walk, the row
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

    // Invoke the walk — the same one `onSubscriptionRequired` runs.
    a.client._restoreSubscriptionsForTest();

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

  it('a reconnect that supersedes an open socket re-subscribes nothing, and the row keeps delivering', async () => {
    const star = uniqueStar();
    const { a, resourceId } = await setupSubscribedClient(star);
    a.client.callStarInspectSubscribers(star);
    const [rowBefore] = await waitForSuccess(a.client) as SubscriberRow[];

    // Construct a second client with the same instanceName + accessToken.
    // The host node sees an existing socket for this instanceName, closes it with
    // WS_CLOSE_SUPERSEDED (4409). a.client's #handleClose routes that to
    // #scheduleReconnect → state → 'reconnecting' → 1s backoff → reconnect.
    const aInstanceName = a.client.lmz.instanceName;
    const browserB = new Browser();
    const b = new NebulaClientTest({
      baseUrl: pageOf(star), platformOrigin: ORIGIN,
      ontologyVersion: ONTOLOGY_VERSION,
      instanceName: aInstanceName,
      accessToken: a.accessToken,
      fetch: browserB.fetch,
      WebSocket: browserB.WebSocket,
    });

    // a.client should observe the supersede close and enter 'reconnecting'.
    await vi.waitFor(() => { expect(a.client.connectionState).toBe('reconnecting'); });

    // a.client's reconnect timer (1s backoff) fires while b is still connected, so a supersedes b
    // and is told `subscriptionRequired: false`. Then b is disposed, before its own reconnect timer
    // can ping-pong: disconnect() clears it and nulls b's handlers.
    await vi.waitFor(() => { expect(a.client.connectionState).toBe('connected'); });
    b.disconnect();

    // A round trip on the reconnected socket, so a re-subscribe the reconnect sent has landed by
    // its answer. MUTATION: restore the blanket re-subscribe on reconnect, and the row is rewritten.
    a.client.callStarInspectSubscribers(star);
    const rowsAfter = await waitForSuccess(a.client) as SubscriberRow[];
    expect(rowsAfter).toEqual([rowBefore]);

    // The row still delivers: another tab's write reaches this one as a push. (A writer's own tab
    // is excluded from its write's fan-out, so the write comes from a second client.)
    const writer = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const snapshot = await writer.client.resources.read('TestResource', resourceId);
    writer.client.callStarTransaction(star, ONTOLOGY_VERSION, {
      [resourceId]: { op: 'put', eTag: snapshot!.meta.eTag, value: { title: 'After the supersede' } },
    });
    await waitForSuccess(writer.client);
    await vi.waitFor(() => {
      expect(a.client.lastResourceUpdate?.snapshot?.value).toEqual({ title: 'After the supersede' });
    });
    writer.client[Symbol.dispose]();
  });
});
