/**
 * Studio compile pipeline — P3: reload channel + local end-to-end preview.
 *
 * The preview can't ride resource subscriptions (`Subscriptions.subscribe`
 * hard-throws unless the target is a pre-existing, typeName-matched,
 * read-permitted resource, and a compile triggers no resource broadcast). So a
 * non-resource per-Star reload channel modeled on `subscribeTree`:
 * `Star.subscribeReload` registers; `DevStar.compileSFC` → `Star.broadcastReload`
 * fans out `handleReload`. End-to-end: edit `.vue` → compile → reload fires →
 * a subsequent `onRequest` re-fetch returns the NEW bytes.
 *
 * @see tasks/nebula-studio-compile-pipeline.md § Phase 3
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { createAuthenticatedClient, uniqueGalaxyScope } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ORIGIN = 'http://localhost';
const sfc = (marker: string) => `<template><div>${marker}</div></template>
<script setup lang="ts">const n: number = 1;</script>`;

async function waitForSuccess(client: NebulaClientTest) {
  await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}

describe('Studio compile P3 — reload channel + e2e preview', () => {
  it('subscribeReload registers cleanly; a compile fires handleReload and serves the new bytes', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await createAuthenticatedClient(NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com');

    // (1) subscribeReload registers WITHOUT the resource-existence / typeName /
    // OntologyStale errors a resource subscribe to a nonexistent resource would
    // throw. In-order WS delivery means the inspect (issued right after) observes
    // the row; lastError stays undefined throughout.
    client.callDevStarSubscribeReload(dev);
    client.callDevStarInspectReloadSubscribers(dev);
    expect(await waitForSuccess(client)).toBe(1);
    expect(client.lastError).toBeUndefined();

    // (2) compile a .vue → bundle stored → handleReload fires. Capable-of-failing:
    // reloadCount bumps ONLY when the real svc.broadcast executes (no broadcast →
    // no bump → the waitFor times out).
    const before1 = client.reloadCount;
    client.callDevStarCompileSFC(dev, 'App.vue', sfc('MARKER_V1'));
    await waitForSuccess(client);
    await vi.waitFor(() => { expect(client.reloadCount).toBeGreaterThan(before1); });

    // (3) a subsequent onRequest re-fetch returns the V1 bytes.
    let js = await (await new Browser().fetch(`${ORIGIN}/dev-star/${dev}/App.js`)).text();
    expect(js).toContain('MARKER_V1');

    // (4) edit the .vue → recompile → reload fires again → re-fetch returns the
    // NEW bytes, not the stale V1.
    const before2 = client.reloadCount;
    client.callDevStarCompileSFC(dev, 'App.vue', sfc('MARKER_V2'));
    await waitForSuccess(client);
    await vi.waitFor(() => { expect(client.reloadCount).toBeGreaterThan(before2); });

    js = await (await new Browser().fetch(`${ORIGIN}/dev-star/${dev}/App.js`)).text();
    expect(js).toContain('MARKER_V2');
    expect(js).not.toContain('MARKER_V1');

    client[Symbol.dispose]();
  });

  it('a compile with no reload subscribers is a no-op broadcast (does not throw)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await createAuthenticatedClient(NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com');

    // No subscribeReload → broadcastReload sees zero subscribers and returns early.
    client.callDevStarCompileSFC(dev, 'App.vue', sfc('NOSUB'));
    const result = await waitForSuccess(client) as { path: string; errors: string[] };
    expect(result.errors).toEqual([]);
    expect(client.reloadCount).toBe(0);   // nothing to deliver

    client[Symbol.dispose]();
  });
});
