/**
 * `client.resources.read(rt, rid)` returns the current snapshot WITHOUT writing
 * to the bound reactive store (§5.3.8) — real Star.
 *
 * This is the load-bearing distinction between `read()` (a one-shot server fetch)
 * and `subscribe()` (which populates + keeps the store path live). A factory client
 * that has never subscribed to or written a resource reads it and gets the value
 * back, but its `store.resources[rt][rid]` stays undefined.
 *
 * Why real-Star, not the jsdom MockClient: the mock exposes no `read()`, and a
 * mock that simply didn't touch the store would assert the mock, not the real
 * factory. read() is a server round-trip here.
 *
 * Capable-of-failing: the reading client never subscribes to or writes the
 * resource, so the ONLY way `store.resources.Todo[id]` could become defined is
 * if `read()` wrote it — if read() populated the store, the final assertion goes
 * red. (No active Vue component instance, so the bare store-path access in the
 * assertion can't itself trigger auto-subscribe.)
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { TransactionOutcome } from '@lumenize/nebula';
import { createNebulaClient } from '@lumenize/nebula/frontend';
import { createAuthenticatedClient, browserLogin, ORIGIN } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TYPES = `interface Todo { title: string; done: boolean; }`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

function committedETag(outcome: TransactionOutcome, rid: string): string {
  if (outcome.kind !== 'committed') throw new Error(`Expected committed, got ${outcome.kind}`);
  const r = outcome.resources[rid];
  if (r?.kind !== 'committed') throw new Error(`Expected committed resource, got ${r?.kind}`);
  return r.eTag;
}

describe('client.resources.read does not write to the bound store (§5.3.8, real Star)', () => {
  it('returns the snapshot but leaves store.resources untouched', async () => {
    const star = uniqueStar();

    // Admin installs the ontology and creates the resource (the "other" actor).
    const admin = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const galaxyName = star.split('.').slice(0, 2).join('.');
    admin.client.callGalaxyAppendOntologyVersion(galaxyName, { version: ONTOLOGY_VERSION, types: TYPES });
    await vi.waitFor(() => { expect(admin.client.callCompleted).toBe(true); });

    const todoId = generateUuid();
    const created = await admin.client.resources.transaction({
      [todoId]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'buy milk', done: false } },
    });
    committedETag(created, todoId); // assert the create committed

    // A fresh factory client that NEVER subscribes to or writes this resource.
    const browserR = new Browser();
    await browserLogin(browserR, star, 'admin@example.com', star);
    const ctx = browserR.context(ORIGIN);
    const { client, store, ready, dispose } = createNebulaClient({
      baseUrl: ORIGIN,
      authScope: star,
      activeScope: star,
      appVersion: ONTOLOGY_VERSION,
      fetch: browserR.fetch,
      WebSocket: browserR.WebSocket,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
      onShouldRefreshUI: () => {},
    });
    await ready;

    // read() returns the current snapshot from the server...
    const snap = await client.resources.read('Todo', todoId);
    expect((snap!.value as { title: string }).title).toBe('buy milk');

    // ...but did NOT populate the bound reactive store (read ≠ subscribe). The
    // path-aware store Proxy materializes an empty placeholder on mere access, so
    // assert on the LEAF value — read leaves it unset.
    expect(store.resources.Todo?.[todoId]?.value?.title).toBeUndefined();

    // Control (makes the assertion above non-vacuous): subscribe DOES populate the
    // same store path. If read() had written the value, the assertion above would
    // have failed; this proves the path can hold a value, so its emptiness is real.
    const sub = client.resources.subscribe('Todo', todoId);
    await sub.snapshot;
    await vi.waitFor(() => {
      expect(store.resources.Todo?.[todoId]?.value?.title).toBe('buy milk');
    });

    sub[Symbol.dispose]();
    await dispose();
    admin.client[Symbol.dispose]();
  });
});
