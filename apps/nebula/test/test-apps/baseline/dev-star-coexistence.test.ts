/**
 * Dev Star — P4: dev + prod coexistence & isolation.
 *
 * Proves the scenario Fix 1 unblocks: a `DEV_STAR`/`{u}.{g}.dev` instance and a
 * production `STAR`/`{u}.{g}.{prod}` instance coexist under one Galaxy and stay
 * mutually isolated, and that the existing subscribe machinery works unchanged
 * for `DevStar`.
 *
 * @see tasks/dev-star.md § P4
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { createAuthenticatedClient, uniqueGalaxyScope } from '../../test-helpers';
import { NebulaClientTest } from './index';

const TODO = `interface Todo { title: string; done: boolean; }`;

async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
}
async function waitForSuccess(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}

describe('Dev Star P4 — coexistence & isolation', () => {
  it('coexistence: a dev Star and a production Star both read the shared Galaxy under one galaxy admin', async () => {
    const { galaxy, starA, dev } = uniqueGalaxyScope();
    // One founder-admin at the galaxy; two clients at sibling star activeScopes —
    // the production tenant (`STAR`) and the dev sandbox (`DEV_STAR`). Both share
    // the single Galaxy DO `{u}.{g}` — the collision TOFU rejected, which Fix 1's
    // `<galaxy>.*` coverage (inherited by DevStar) unblocks. This specializes
    // scope-isolation's T1 to the real dev binding (couldn't live there: DEV_STAR
    // didn't exist yet). Regresses to RED if Fix 1 were reverted to TOFU.
    const { client: prodClient } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), galaxy, starA, 'admin@example.com',
    );
    const { client: devClient } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com',
    );

    prodClient.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO });
    await waitForSuccess(prodClient);

    // Production-scope aud reads the shared Galaxy.
    prodClient.callGalaxyGetLatestOntologyVersion(galaxy);
    expect(await waitForSuccess(prodClient)).not.toBeNull();

    // Dev-scope aud reads the SAME Galaxy DO with a distinct star-level aud.
    devClient.callGalaxyGetLatestOntologyVersion(galaxy);
    expect(await waitForSuccess(devClient)).not.toBeNull();

    prodClient[Symbol.dispose]();
    devClient[Symbol.dispose]();
  });

  it('isolation: a dev-scope client cannot reach a prod Star, and a prod-scope client cannot reach the dev Star', async () => {
    const { galaxy, starA, dev } = uniqueGalaxyScope();
    const { client: prodClient } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), galaxy, starA, 'admin@example.com',
    );
    const { client: devClient } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com',
    );

    // dev-scope aud → production STAR: each Star's name-derived onBeforeCall
    // rejects the other's aud (exact-pattern mismatch).
    devClient.callStarWhoAmI(starA);
    await waitForResult(devClient);
    expect(devClient.lastError).toContain('Active-scope mismatch');

    // prod-scope aud → dev DEV_STAR: rejected the same way.
    prodClient.callDevStarWhoAmI(dev);
    await waitForResult(prodClient);
    expect(prodClient.lastError).toContain('Active-scope mismatch');

    // Positive controls: each reaches its OWN star.
    devClient.callDevStarWhoAmI(dev);
    await waitForResult(devClient);
    expect(devClient.lastError).toBeUndefined();
    expect(devClient.lastResult).toContain('You are');

    prodClient.callStarWhoAmI(starA);
    await waitForResult(prodClient);
    expect(prodClient.lastError).toBeUndefined();
    expect(prodClient.lastResult).toContain('You are');

    prodClient[Symbol.dispose]();
    devClient[Symbol.dispose]();
  });

  it('subscriptions: a subscription against the dev Star delivers fanout updates (5.3 machinery works for DevStar)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    // Two galaxy-admin connections at the dev activeScope: A subscribes, B mutates.
    // (Fanout excludes the originator, so a single client wouldn't observe its own
    // write — the two-connection shape is what proves delivery.)
    const { client: a } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com',
    );
    const { client: b } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com',
    );

    a.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO });
    await waitForSuccess(a);

    // A creates + subscribes on the dev Star (createAndSubscribe → DEV_STAR).
    const rid = generateUuid();
    using sub = a.resources.createAndSubscribe('Todo', rid, ROOT_NODE_ID, { title: 'v1', done: false });
    const created = await sub.snapshot;
    expect(created).not.toBeNull();
    const eTag = (created as Snapshot).meta.eTag;

    // B mutates the same resource on the dev Star → fanout must reach A.
    const baseline = a.resourceUpdateCount;
    b.callDevStarTransaction(dev, 'v1', {
      [rid]: { op: 'put', eTag, value: { title: 'v2', done: true } },
    });
    await waitForSuccess(b);

    await vi.waitFor(() => { expect(a.resourceUpdateCount).toBeGreaterThan(baseline); });
    expect(a.lastResourceUpdate?.resourceId).toBe(rid);
    expect((a.lastResourceUpdate?.snapshot?.value as { title: string }).title).toBe('v2');

    a[Symbol.dispose]();
    b[Symbol.dispose]();
  });
});
