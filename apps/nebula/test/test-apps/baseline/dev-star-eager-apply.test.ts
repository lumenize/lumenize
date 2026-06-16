/**
 * Dev Star — P2: eager version application.
 *
 * A new ontology version applies *eagerly* to the dev Star on `deploy_to_dev`
 * (here driven by the `callDevStarDeployToDev` initiator), reusing the
 * production apply path (`Star.#installState` via the `protected
 * applyFetchedState` hook) rather than duplicating it. The apply is a cross-DO
 * mesh round-trip, so "success" is the **continuation landing** — observed via
 * the `nebula.Star.applyFetchedState` debug marker (a synchronous return would
 * prove nothing, and the null path must not masquerade as a `vi.waitFor`
 * timeout).
 *
 * @see tasks/dev-star.md § P2
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { setDebugSink, clearDebugSink, type DebugSink } from '@lumenize/debug';
import { ROOT_NODE_ID } from '@lumenize/nebula';
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
async function devAdminClient(galaxy: string, dev: string) {
  return createAuthenticatedClient(NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com');
}

type ApplyMarker = { namespace: string; data?: { instanceName?: string; version?: string; reason?: string } };

describe('Dev Star P2 — eager version application', () => {
  it('eager-applies the latest Galaxy version on deployToDev (continuation lands, no lazy step)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);
    const entries: ApplyMarker[] = [];
    const sink: DebugSink = (e) => { entries.push(e as ApplyMarker); };
    setDebugSink(sink);
    try {
      client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO });
      await waitForSuccess(client);

      // Baseline: nothing applied to the dev Star yet (no lazy read forced it).
      client.callDevStarInspectOntologyKv(dev);
      let kv = await waitForSuccess(client) as { index: string[]; rowVersions: string[] };
      expect(kv.index).toEqual([]);
      expect(kv.rowVersions).toEqual([]);

      entries.length = 0;
      client.callDevStarDeployToDev(dev);
      await waitForResult(client);          // deployToDev dispatched (admin gate passed)
      expect(client.lastError).toBeUndefined();

      // Success == the apply continuation lands (cross-DO round-trip), not a return.
      await vi.waitFor(() => {
        expect(entries.some(e => e.namespace === 'nebula.Star.applyFetchedState'
          && e.data?.instanceName === dev && e.data?.version === 'v1')).toBe(true);
      });

      // KV now reflects v1 — applied eagerly, with NO resource op having triggered
      // a lazy cache-miss fetch.
      client.callDevStarInspectOntologyKv(dev);
      kv = await waitForSuccess(client) as { index: string[]; rowVersions: string[] };
      expect(kv.index).toEqual(['v1']);
      expect(kv.rowVersions).toEqual(['v1']);
    } finally {
      clearDebugSink();
    }
    client[Symbol.dispose]();
  });

  it('deployToDev against an un-published Galaxy is a deliberate no-op, not an error (null-state)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);
    const entries: ApplyMarker[] = [];
    const sink: DebugSink = (e) => { entries.push(e as ApplyMarker); };
    setDebugSink(sink);
    try {
      // No appendOntologyVersion → getLatestOntologyVersion() returns null.
      entries.length = 0;
      client.callDevStarDeployToDev(dev);
      await waitForResult(client);
      expect(client.lastError).toBeUndefined();

      // The continuation RAN and was an intentional no-op (reason 'null') — the
      // marker proves it's a real no-op, not a vi.waitFor timeout masquerade.
      await vi.waitFor(() => {
        expect(entries.some(e => e.namespace === 'nebula.Star.applyFetchedState'
          && e.data?.instanceName === dev && e.data?.reason === 'null')).toBe(true);
      });
      // Capable-of-failing: an 'applied' marker for this instance would mean the
      // null path wrongly installed something.
      expect(entries.some(e => e.namespace === 'nebula.Star.applyFetchedState'
        && e.data?.instanceName === dev && e.data?.version !== undefined)).toBe(false);

      // Nothing installed; no throw.
      client.callDevStarInspectOntologyKv(dev);
      const kv = await waitForSuccess(client) as { index: string[]; rowVersions: string[] };
      expect(kv.index).toEqual([]);
      expect(kv.rowVersions).toEqual([]);
    } finally {
      clearDebugSink();
    }
    client[Symbol.dispose]();
  });

  it('a second-version eager-apply clears subscribers (the isNewVersion && prevLatest branch, M5)', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);
    const entries: ApplyMarker[] = [];
    const sink: DebugSink = (e) => { entries.push(e as ApplyMarker); };
    setDebugSink(sink);
    try {
      // Apply v1 eagerly.
      client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO });
      await waitForSuccess(client);
      client.callDevStarDeployToDev(dev);
      await waitForResult(client);
      await vi.waitFor(() => {
        expect(entries.some(e => e.namespace === 'nebula.Star.applyFetchedState'
          && e.data?.instanceName === dev && e.data?.version === 'v1')).toBe(true);
      });

      // Create a resource and subscribe to it in ONE call via the public
      // `createAndSubscribe` helper — for a `.dev`-scope client this routes to
      // DEV_STAR (dogfoods both the helper and slug-derived binding selection) and
      // leaves a live subscriber row on the dev Star. `using` disposes at the end
      // of this block — after the v2 apply below — so the row stays live for it.
      const rid = generateUuid();
      using sub = client.resources.createAndSubscribe('Todo', rid, ROOT_NODE_ID, { title: 'x', done: false });
      expect(await sub.snapshot).not.toBeNull();

      client.callDevStarInspectSubscribers(dev);
      let subs = await waitForSuccess(client) as unknown[];
      expect(subs.length).toBe(1);

      // Apply a SECOND, different version eagerly → #installState takes the
      // isNewVersion && prevLatest branch: clears subscribers (+ pushes
      // OntologyStaleError to the dropped subscriber). The fresh v1 install above
      // never exercised this branch (prevLatest was undefined).
      entries.length = 0;
      client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v2', types: TODO });
      await waitForSuccess(client);
      client.callDevStarDeployToDev(dev);
      await waitForResult(client);
      await vi.waitFor(() => {
        expect(entries.some(e => e.namespace === 'nebula.Star.applyFetchedState'
          && e.data?.instanceName === dev && e.data?.version === 'v2')).toBe(true);
      });

      client.callDevStarInspectSubscribers(dev);
      subs = await waitForSuccess(client) as unknown[];
      expect(subs.length).toBe(0); // cleared by the second-version apply
    } finally {
      clearDebugSink();
    }
    client[Symbol.dispose]();
  });
});
