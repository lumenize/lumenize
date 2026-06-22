/**
 * Live dev-loop version contract — the reload channel (Phase 5, container-free half).
 *
 * The version *injection* round-trip (DevContainer.fetch injects the real version →
 * preview ops succeed) needs a live container (run with `wrangler dev` + Docker Desktop) —
 * see the `it.skip` in `container-node/dev-container.test.ts`. What IS testable here is the reload channel
 * that re-syncs an already-loaded preview when the ontology version changes — it's a
 * pure Star↔client path, no container:
 *  - T1: a NEW ontology version fires `Star.broadcastReload` (from `#installState`) →
 *        the client's `handleReload` (Option X: the trigger is the install path, no new
 *        `@mesh` surface);
 *  - T2: `resetDevData` PRESERVES the reload subscriber across its `deleteAll`, so the
 *        post-wipe reload (Flow 1b) still reaches the preview;
 *  - T3: the client auto-subscribes to the reload channel on connect ONLY when
 *        `onReload` is configured (the bootstrap sets it for the `.dev` preview) —
 *        a client without `onReload` does NOT subscribe and gets no reload.
 *
 * @see tasks/nebula-dev-flows.md — Decision 12 + Flow 1d
 * @see tasks/nebula-studio.md § Phase 5
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { createAuthenticatedClient, uniqueGalaxyScope } from '../../test-helpers';
import { NebulaClientTest } from './index';

const TODO_V1 = `interface Todo { title: string; done: boolean; }`;
const TODO_V2 = `interface Todo { title: string; done: boolean; priority: string; }`;

async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
}
async function waitForSuccess(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}
async function devAdminClient(galaxy: string, dev: string, extraConfig?: { onReload?: () => void }) {
  return createAuthenticatedClient(NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com', 'v1', extraConfig);
}
/** Apply an ontology version to the `.dev` Star (the `setOntology` path — explicit
 *  version labels, so `#installState` sees a new version when the label changes). */
async function applyOntology(client: NebulaClientTest, dev: string, version: string, types: string) {
  client.callStarApplyOntology(dev, { version, types });
  await waitForSuccess(client);
}
/** Poll the Star's ReloadSubscribers (the fire-and-forget subscribe may not have
 *  landed yet right after connect). */
async function reloadSubscriberCount(client: NebulaClientTest, dev: string): Promise<number> {
  client.callStarInspectReloadSubscribers(dev);
  const rows = await waitForSuccess(client) as unknown[];
  return rows.length;
}

describe('Version contract — reload channel (Phase 5, container-free)', () => {
  it('T1: a new ontology version fires the reload channel to a subscribed client', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    // Establish v1 BEFORE subscribing (so the baseline reloadCount is clean).
    await applyOntology(client, dev, 'v1', TODO_V1);

    // Subscribe to the reload channel (explicit initiator — deterministic: await
    // registration before triggering, isolating the Star trigger from client wiring).
    client.callStarSubscribeReload(dev);
    await waitForSuccess(client);

    const before = client.reloadCount;
    // A DIFFERENT version → isNewVersion → #installState fires broadcastReload.
    await applyOntology(client, dev, 'v2', TODO_V2);

    // Capable-of-failing: if broadcastReload were NOT fired from #installState on a
    // new version (Option X), reloadCount would never advance.
    await vi.waitFor(() => { expect(client.reloadCount).toBeGreaterThan(before); });

    client[Symbol.dispose]();
  });

  it('T2: resetDevData preserves the reload subscriber across the wipe (Flow 1b)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    await applyOntology(client, dev, 'v1', TODO_V1);
    client.callStarSubscribeReload(dev);
    await waitForSuccess(client);
    expect(await reloadSubscriberCount(client, dev)).toBe(1);

    // Wipe. deleteAll() drops the ReloadSubscribers table; resetDevData must capture +
    // restore it (live-connection state, not dev data).
    client.callStarResetDevData(dev);
    await waitForResult(client);
    expect(client.lastError).toBeUndefined();

    // Primary capable-of-failing assertion: the row survived the wipe. Without the
    // preserve logic this is 0 (the deleteAll wiped it).
    expect(await reloadSubscriberCount(client, dev)).toBe(1);

    // Confirmation: the preserved subscriber still RECEIVES a reload. After the wipe
    // the ontology index is empty, so re-applying is a new version → broadcastReload.
    // The client never reconnected (a storage wipe doesn't drop the WS) and has no
    // onReload (so it can't re-subscribe), so delivery here can ONLY mean the
    // subscription was preserved.
    const before = client.reloadCount;
    await applyOntology(client, dev, 'v2', TODO_V2);
    await vi.waitFor(() => { expect(client.reloadCount).toBeGreaterThan(before); });

    client[Symbol.dispose]();
  });

  it('T3: only an onReload-configured client auto-subscribes on connect (the dev gate)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    // A: the dev preview (onReload set) — auto-subscribes on connect.
    // B: a non-preview client (no onReload) — must NOT subscribe.
    const { client: A } = await devAdminClient(galaxy, dev, { onReload: () => {} });
    const { client: B } = await devAdminClient(galaxy, dev);

    await applyOntology(A, dev, 'v1', TODO_V1);

    // Exactly ONE reload subscriber (A) — proves A subscribed via the connect-gate AND
    // B did not. Capable-of-failing: a subscribe-always wiring → 2; a missing
    // subscribe → 0.
    await vi.waitFor(async () => { expect(await reloadSubscriberCount(A, dev)).toBe(1); });

    const aBefore = A.reloadCount;
    const bBefore = B.reloadCount;
    await applyOntology(A, dev, 'v2', TODO_V2);

    // A (subscribed) receives the reload; B (not subscribed) does not. The wait on A is
    // the sync point — B's reload, if it were coming, rides the same broadcast fan-out,
    // so B staying at its baseline is a reliable negative (catches a gate inversion).
    await vi.waitFor(() => { expect(A.reloadCount).toBeGreaterThan(aBefore); });
    expect(B.reloadCount).toBe(bBefore);

    A[Symbol.dispose]();
    B[Symbol.dispose]();
  });
});
