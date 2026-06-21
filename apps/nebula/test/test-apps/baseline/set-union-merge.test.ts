/**
 * Set-union merge + client-computed aggregate (§5.3.8, the `openCount` lesson) —
 * real Star.
 *
 * Two concurrent adds to a list-type resource conflict; a `use-this` set-union
 * resolver (a pure, idempotent function of local+server — NOT a local-relative
 * increment) keeps BOTH new ids. A Vue `computed` over the subscribed list
 * reflects the merged count on every subscriber, and the stored value carries
 * NO aggregate field.
 *
 * Capable-of-failing:
 *  - a `use-server` list merge would orphan the loser's add (only one id survives);
 *  - re-introducing a STORED `openCount` would bring back the counter-merge
 *    double-count — so we assert the stored value has no such field.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { TransactionOutcome } from '@lumenize/nebula';
import { createNebulaClient } from '@lumenize/nebula/frontend';
import { computed } from '@vue/reactivity';
import { createAuthenticatedClient, browserLogin, ORIGIN } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const LIST_TYPES = `interface TodoList { items: string[]; }`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

function committedETag(outcome: TransactionOutcome, rid: string): string {
  if (outcome.kind !== 'committed') throw new Error(`Expected committed, got ${outcome.kind}`);
  const r = outcome.resources[rid];
  if (r?.kind !== 'committed') throw new Error(`Expected committed resource, got ${r?.kind}`);
  return r.eTag;
}

function makeFactoryClient(star: string, browser: Browser) {
  const ctx = browser.context(ORIGIN);
  return createNebulaClient({
    baseUrl: ORIGIN,
    authScope: star,
    activeScope: star,
    appVersion: ONTOLOGY_VERSION,
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
    onShouldRefreshUI: () => {},
  });
}

describe('set-union merge + client-computed aggregate (§5.3.8, real Star)', () => {
  it('keeps both concurrent adds; openCount computed reflects the merge on both clients; no stored aggregate', async () => {
    const star = uniqueStar();

    // Admin (the "other" actor) installs the ontology, seeds an empty list, then
    // adds 't1' — advancing the server so a second add against the seed eTag conflicts.
    const admin = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const galaxyName = star.split('.').slice(0, 2).join('.');
    admin.client.callStarApplyOntology(star, { version: ONTOLOGY_VERSION, types: LIST_TYPES });
    await vi.waitFor(() => { expect(admin.client.callCompleted).toBe(true); });

    const listId = generateUuid();
    const created = await admin.client.resources.transaction({
      [listId]: { op: 'create', typeName: 'TodoList', nodeId: ROOT_NODE_ID, value: { items: [] } },
    });
    const seedETag = committedETag(created, listId);
    await admin.client.resources.transaction({
      [listId]: { op: 'put', typeName: 'TodoList', eTag: seedETag, value: { items: ['t1'] } },
    });

    // B (factory): a set-union resolver, then add 't2' against the stale seed eTag.
    const browserB = new Browser();
    await browserLogin(browserB, star, 'admin@example.com', star);
    const bf = makeFactoryClient(star, browserB);
    await bf.ready;
    // C (factory): a read-only observer subscribed to the same list.
    const browserC = new Browser();
    await browserLogin(browserC, star, 'admin@example.com', star);
    const cf = makeFactoryClient(star, browserC);
    await cf.ready;

    bf.client.resources.onTransactionResourceResolution('TodoList', (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      const local = (res.local.value as { items: string[] }).items;
      const server = (res.server.value as { items: string[] }).items;
      // Pure, idempotent set-union of local + server (the openCount lesson — never
      // `server.length + 1`). Both adds survive; replaying it is a no-op.
      return { kind: 'use-this', value: { items: [...new Set([...server, ...local])] } };
    });

    // openCount is a CLIENT-COMPUTED aggregate over the subscribed list, never stored.
    const bOpenCount = computed(() => (bf.store.resources.TodoList?.[listId]?.value?.items?.length ?? 0));
    const cOpenCount = computed(() => (cf.store.resources.TodoList?.[listId]?.value?.items?.length ?? 0));

    // C subscribes so it receives the merged value via fanout.
    const cSub = cf.client.resources.subscribe('TodoList', listId);
    await cSub.snapshot;

    const outcome = await bf.client.resources.transaction({
      [listId]: { op: 'put', typeName: 'TodoList', eTag: seedETag, value: { items: ['t2'] } },
    });
    expect(outcome.kind).toBe('committed');

    // Set-union kept BOTH adds — neither orphaned (use-server would drop 't2').
    const final = await bf.client.resources.read('TodoList', listId);
    const items = (final!.value as { items: string[] }).items;
    expect([...items].sort()).toEqual(['t1', 't2']);

    // The computed reflects the merged set on B (its own write-through)...
    expect(bOpenCount.value).toBe(2);
    // ...and on C via the broadcast fanout.
    await vi.waitFor(() => { expect(cOpenCount.value).toBe(2); });

    // The stored value carries items only — no stored `openCount` aggregate.
    expect((final!.value as Record<string, unknown>).openCount).toBeUndefined();

    cSub[Symbol.dispose]();
    await bf.dispose();
    await cf.dispose();
    admin.client[Symbol.dispose]();
  });
});
