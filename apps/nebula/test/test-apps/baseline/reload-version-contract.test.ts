/**
 * The preview-reload channel, post-collapse (container-free half).
 *
 * The trigger is BUILD COMPLETION, announced by the GALAXY that just ran the build —
 * ONE reload per turn. The ontology-install trigger is RETIRED (the version label is
 * baked into the build, so an install without a build gives a reload nothing new to
 * fetch; keeping both double-reloaded every ontology-touching turn), and this file
 * asserts it STAYS dead. The Star's channel is PARKED (publish's future refresh
 * signal): registration + wipe-preservation still hold, and delivery is proven through
 * the test-only fan (its production trigger is not built).
 *
 *  - T1: a chat turn whose `build` tool succeeds fires the GALAXY reload channel to a
 *        subscribed client — and an ontology INSTALL does NOT (the retired trigger).
 *  - T2: `resetDevData` PRESERVES the Star's reload subscriber across its `deleteAll`
 *        (live-connection state, not dev data), and the preserved row still receives.
 *  - T3: the client's connect-gate routes by PAIR: an `onReload` client with a CHAT
 *        pair subscribes on the GALAXY; one without subscribes its resource pair (the
 *        Star's parked channel); no `onReload` → no subscription anywhere.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { universeAdminClient, uniqueGalaxyScope } from '../../test-helpers';
import { NebulaClientTest } from './index';

const TODO_V1 = `interface Todo { title: string; done: boolean; }`;
const TODO_V2 = `interface Todo { title: string; done: boolean; priority: string; }`;

/** One fake model round that calls the build tool, then one that marks complete. */
const BUILD_THEN_COMPLETE = [
  { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
    { id: 'b1', type: 'function', function: { name: 'build', arguments: '{}' } },
  ] } }] },
  { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'mark_complete', arguments: '{}' } },
  ] } }] },
];
/** A text-only script — the turn completes with NO build call (no reload may fire). */
const NO_BUILD = [
  { choices: [{ message: { content: 'just chatting', reasoning_content: '', tool_calls: [] } }] },
];

async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
}
async function waitForSuccess(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}
async function devAdminClient(galaxy: string, dev: string, extraConfig?: Record<string, unknown>) {
  return universeAdminClient(NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com', 'v1', extraConfig);
}
async function applyOntology(client: NebulaClientTest, dev: string, version: string, types: string) {
  client.callStarApplyOntology(dev, { version, types });
  await waitForSuccess(client);
}
async function starReloadSubscribers(client: NebulaClientTest, dev: string): Promise<number> {
  client.callStarInspectReloadSubscribers(dev);
  const rows = await waitForSuccess(client) as unknown[];
  return rows.length;
}
async function galaxyReloadSubscribers(client: NebulaClientTest, galaxy: string): Promise<number> {
  client.callGalaxyInspectReloadSubscribers(galaxy);
  const rows = await waitForSuccess(client) as unknown[];
  return rows.length;
}

describe('Preview-reload channel — build-completion trigger (post-collapse)', () => {
  it('T1: a successful build tool call fires the GALAXY channel — and an ontology install does NOT (retired trigger)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    client.callGalaxySubscribeReload(galaxy);
    await waitForSuccess(client);
    // ALSO subscribe the STAR channel — the retired install-trigger's fan target.
    // Without this observer, restoring that trigger would fire into an empty table
    // and the negative below could never red.
    client.callStarSubscribeReload(dev);
    await waitForSuccess(client);

    // NEGATIVE first: an ontology install (old trigger, deliberately retired) fires
    // nothing on EITHER channel.
    const beforeInstall = client.reloadCount;
    await applyOntology(client, dev, 'v1', TODO_V1);
    await applyOntology(client, dev, 'v2', TODO_V2);

    // POSITIVE: a chat turn whose build succeeds fires exactly one reload.
    const beforeBuild = client.reloadCount;
    client.callGalaxyChatScripted(galaxy, 'build it', BUILD_THEN_COMPLETE);
    await vi.waitFor(() => { expect(client.reloadCount).toBe(beforeBuild + 1); }, { timeout: 15000 });
    // The installs above never fired (checked AFTER the build sync point, so a slow
    // install-path reload would have landed by now — not a too-early read).
    expect(beforeBuild).toBe(beforeInstall);

    // A turn with NO build call fires nothing (the trigger is build completion, not
    // turn completion).
    const beforeChat = client.reloadCount;
    client.callGalaxyChatScripted(galaxy, 'just talk', NO_BUILD);
    await waitForResult(client);
    expect(client.reloadCount).toBe(beforeChat);

    client[Symbol.dispose]();
  });

  it('T2: resetDevData preserves the Star reload subscriber across the wipe, and it still receives', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    await applyOntology(client, dev, 'v1', TODO_V1);
    client.callStarSubscribeReload(dev);
    await waitForSuccess(client);
    expect(await starReloadSubscribers(client, dev)).toBe(1);

    // Wipe. deleteAll() drops the ReloadSubscribers table; resetDevData must capture +
    // restore it (live-connection state, not dev data).
    client.callStarResetDevData(dev);
    await waitForResult(client);
    expect(client.lastError).toBeUndefined();
    expect(await starReloadSubscribers(client, dev)).toBe(1);

    // The preserved subscriber still RECEIVES — driven through the test fan (the
    // channel is parked: its production trigger is publish's, not built). The client
    // never reconnected and has no onReload, so delivery can ONLY mean preservation.
    const before = client.reloadCount;
    client.callStarBroadcastReloadForTest(dev);
    await vi.waitFor(() => { expect(client.reloadCount).toBeGreaterThan(before); }, { timeout: 15000 });

    client[Symbol.dispose]();
  });

  it('T3: the connect-gate routes by PAIR — chat pair → Galaxy; none → the resource pair; no onReload → nowhere', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    // A: onReload + a CHAT pair (Studio's shape) → subscribes on the GALAXY.
    const { client: A } = await devAdminClient(galaxy, dev, {
      onReload: () => {}, chatHostBinding: 'GALAXY', chatScope: galaxy,
    });
    // B: onReload, NO chat pair (the preview's shape) → subscribes its resource pair (the Star).
    const { client: B } = await devAdminClient(galaxy, dev, { onReload: () => {} });
    // C: no onReload → no subscription anywhere.
    const { client: C } = await devAdminClient(galaxy, dev);

    await vi.waitFor(async () => {
      expect(await galaxyReloadSubscribers(C, galaxy)).toBe(1); // A alone
      expect(await starReloadSubscribers(C, dev)).toBe(1);      // B alone
    }, { timeout: 15000 });

    // A receives the Galaxy's build-completion push; B (Star-parked) and C do not.
    const a0 = A.reloadCount, b0 = B.reloadCount, c0 = C.reloadCount;
    C.callGalaxyChatScripted(galaxy, 'build it', BUILD_THEN_COMPLETE);
    await vi.waitFor(() => { expect(A.reloadCount).toBe(a0 + 1); }, { timeout: 15000 });
    expect(B.reloadCount).toBe(b0);
    expect(C.reloadCount).toBe(c0);

    A[Symbol.dispose](); B[Symbol.dispose](); C[Symbol.dispose]();
  });
});
