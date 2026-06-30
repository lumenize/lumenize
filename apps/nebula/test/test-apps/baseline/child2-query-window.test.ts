/**
 * Child 2 Phase 6 — client window management (the parts the e2e can't observe): the
 * windowed content subs are opened for the rendered ids ONLY, and an id that leaves
 * and returns WITHIN the grace window keeps its live content sub (no churn). Driven
 * through the PUBLIC `client.resources.subscribeQuery` against Star (so
 * `inspectSubscribers` can witness the per-resource content subs directly — the
 * server's Subscribers table is the only place the transient un/re-subscribe shows).
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { SubscriberRow, TransactionResult } from '@lumenize/nebula';
import { createAuthenticatedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const VERSION = 'v1';
const TYPES = ['interface Parent { name: string }', 'interface Child { parent: Parent; label: string }'].join('\n');
const uniqueStar = () => `c2w-${generateUuid().slice(0, 8)}.app.tenant-a`;

async function waitForResult(c: NebulaClientTest) { await vi.waitFor(() => expect(c.callCompleted).toBe(true)); }
async function waitForSuccess(c: NebulaClientTest) { await waitForResult(c); expect(c.lastError).toBeUndefined(); return c.lastResult; }
async function admin(star: string) {
  const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  a.client.callStarApplyOntology(star, { version: VERSION, types: TYPES });
  await waitForResult(a.client);
  return a.client;
}
/** The resource ids `clientId` currently holds single-resource content subs for. */
async function contentSubs(inspector: NebulaClientTest, star: string, clientId: string): Promise<string[]> {
  inspector.callStarInspectSubscribers(star);
  const rows = await waitForSuccess(inspector) as SubscriberRow[];
  return rows.filter((r) => r.clientId === clientId).map((r) => r.resourceId).sort();
}

describe('child2 client window management (Phase 6)', () => {
  it('content subs open for the rendered window only; leave+return within grace = no churn', async () => {
    const star = uniqueStar();
    const a = await admin(star);
    const P = generateUuid();
    const c1 = generateUuid(), c2 = generateUuid();
    a.callStarTransaction(star, VERSION, {
      [c1]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: P, label: 'c1' } },
      [c2]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: P, label: 'c2' } },
    });
    if (!((await waitForSuccess(a)) as TransactionResult).ok) throw new Error('seed failed');

    using sub = a.resources.subscribeQuery(
      { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: P },
      { renderGraceMs: 150 },
    );
    await sub.ready;
    await vi.waitFor(() => expect(sub.resourceIds.length).toBe(2));
    const clientId = a.lmz.instanceName;

    // Render ONLY c1 → exactly one content sub (c1), NOT c2 (windowed lazy hydrate).
    sub.setRenderWindow([c1]);
    await vi.waitFor(async () => expect(await contentSubs(a, star, clientId)).toEqual([c1]));

    // Bounce: drop c1 then re-add it within the grace window; wait PAST grace. The
    // content sub must SURVIVE (grace timer cancelled on re-entry) — c1 stays
    // subscribed the whole time. Mutation: remove the grace-cancel → c1's sub is
    // disposed at 150 ms and (no intervening rerun) NEVER re-subscribed → absent → red.
    sub.setRenderWindow([]);
    sub.setRenderWindow([c1]);
    await new Promise((r) => setTimeout(r, 300)); // > renderGraceMs, lets any (wrong) dispose fire
    expect(await contentSubs(a, star, clientId)).toEqual([c1]);

    // Positive control: leave c1 and DON'T return → after grace it IS released.
    sub.setRenderWindow([]);
    await vi.waitFor(async () => expect(await contentSubs(a, star, clientId)).toEqual([]));

    a[Symbol.dispose]();
  });
});
