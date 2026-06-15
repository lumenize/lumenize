/**
 * Conflict resolution through the conflict-outcome engine — v3.
 *
 * Tests `client.resources.onTransactionResourceResolution(rt, handler, options?)`
 * registration, the per-call override (a map keyed by `resourceId`), and the
 * handler verdicts on `'conflict-pending'` (`use-server` / `use-this` /
 * `human-in-the-loop`) including recursive `use-this` bounded by `maxRetries`.
 * Drives a REAL Star — this is the no-mock backing for the engine's unit suite
 * (the test-fidelity obligation in tasks/nebula-frontend.md).
 *
 * Two-level outcome (v3): the await-site sees the transaction-wide
 * `TransactionOutcome.kind` (`committed` whenever every op landed — even via
 * `use-server`; `rejected` for a per-op failure / human-in-the-loop /
 * retries-exhausted); per-resource detail is delivered to the handler and
 * mirrored on `outcome.resources[rid]`.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot, TransactionOutcome, ResourceHandler } from '@lumenize/nebula';
import { createAuthenticatedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

/** Pull the committed eTag for `rid` out of a committed outcome. */
function committedETag(outcome: TransactionOutcome, rid: string): string {
  if (outcome.kind !== 'committed') throw new Error(`Expected committed, got ${outcome.kind}`);
  const r = outcome.resources[rid];
  if (r?.kind !== 'committed') throw new Error(`Expected committed resource, got ${r?.kind}`);
  return r.eTag;
}

/** Server snapshot from a per-resource `use-server` / `human-in-the-loop` resolution. */
function resolutionSnapshot(outcome: TransactionOutcome, rid: string): Snapshot {
  if (outcome.kind !== 'committed' && outcome.kind !== 'rejected') {
    throw new Error(`Expected committed/rejected, got ${outcome.kind}`);
  }
  const r = outcome.resources[rid];
  if (r?.kind !== 'use-server' && r?.kind !== 'human-in-the-loop') {
    throw new Error(`Expected use-server/human-in-the-loop, got ${r?.kind}`);
  }
  return r.snapshot as unknown as Snapshot;
}

async function setupAdminClient(star: string) {
  const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  const galaxyName = star.split('.').slice(0, 2).join('.');
  a.client.callGalaxyAppendOntologyVersion(galaxyName, {
    version: ONTOLOGY_VERSION,
    types: TEST_TYPES,
  });
  await vi.waitFor(() => { expect(a.client.callCompleted).toBe(true); });
  return a;
}

/** Two independent admin clients on the same Star, sharing the same scope. */
async function twoAdminClients(star: string) {
  const a = await setupAdminClient(star);
  const b = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  return { a, b };
}

/**
 * A creates resource X at title 'V1', updates it to 'V2-by-A', and returns the
 * stale (V1) eTag B should submit against to force a conflict.
 */
async function setupConflict(star: string, a: { client: NebulaClientTest }, b: { client: NebulaClientTest }) {
  const resourceId = generateUuid();

  const created = await a.client.resources.transaction({
    [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'V1' } },
  });
  const staleETag = committedETag(created, resourceId);

  const updated = await a.client.resources.transaction({
    [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-A' } },
  });
  if (updated.kind !== 'committed') throw new Error('Expected committed');

  void b; // b just needs to exist for follow-on test code
  return { resourceId, staleETag };
}

describe('nebula-client.resources.onTransactionResourceResolution (v3)', () => {

  it('per-type "use-server" handler: top-level committed, per-resource use-server writes server.value', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    let conflictCalls = 0;
    b.client.resources.onTransactionResourceResolution('TestResource', (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      conflictCalls++;
      return { kind: 'use-server' };
    });

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    expect(conflictCalls).toBe(1);
    expect(outcome.kind).toBe('committed'); // use-server is below the bucket
    expect(outcome.kind === 'committed' && outcome.resources[resourceId]?.kind).toBe('use-server');
    expect((resolutionSnapshot(outcome, resourceId).value as { title: string }).title).toBe('V2-by-A');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('per-type "use-this" handler retries with the server eTag + merged value (single retry succeeds)', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    let conflictCalls = 0;
    b.client.resources.onTransactionResourceResolution('TestResource', (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      conflictCalls++;
      const local = res.local.value as { title: string };
      const server = res.server.value as { title: string };
      return { kind: 'use-this', value: { title: `merged(${local.title} | ${server.title})` } };
    });

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    expect(conflictCalls).toBe(1);
    expect(outcome.kind).toBe('committed');

    const final = await b.client.resources.read('TestResource', resourceId);
    expect((final!.value as { title: string }).title).toBe('merged(V2-by-B | V2-by-A)');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('retries-exhausted: handler always returns use-this, A keeps mutating, B caps at maxRetries', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    // Force perpetual conflict: A races a fresh write in from inside B's
    // handler, so B's retry baseline is stale again every round.
    let conflictCalls = 0;
    const currentSnap = await a.client.resources.read('TestResource', resourceId);
    let aETag = currentSnap!.meta.eTag;

    b.client.resources.onTransactionResourceResolution('TestResource', async (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      conflictCalls++;
      const out = await a.client.resources.transaction({
        [resourceId]: { op: 'put', typeName: 'TestResource', eTag: aETag, value: { title: `A-attempt-${conflictCalls}` } },
      });
      if (out.kind === 'committed') aETag = committedETag(out, resourceId);
      return { kind: 'use-this', value: { title: `B-attempt-${conflictCalls}` } };
    }, { maxRetries: 3 });

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    // v3 maxRetries semantics: `maxRetries: 3` permits 3 RETRIES after the
    // initial submission → 4 submissions, 4 conflict-pending firings (the 4th's
    // use-this verdict is discarded when the cap is hit), `attempts: 3`. (The
    // engine fires the handler to learn the verdict before it can know whether
    // to honor it — so the exhausting attempt still fires the handler once.)
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.retryable).toBe(true);
    const r = outcome.kind === 'rejected' ? outcome.resources[resourceId] : undefined;
    expect(r?.kind).toBe('retries-exhausted');
    expect(r?.kind === 'retries-exhausted' && r.attempts).toBe(3);
    expect(conflictCalls).toBe(4);

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('human-in-the-loop: top-level rejected; optimistic state stays painted (no write-through)', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    b.client.resources.onTransactionResourceResolution('TestResource', (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      return { kind: 'human-in-the-loop' };
    });

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.resources[resourceId]?.kind).toBe('human-in-the-loop');
    expect((resolutionSnapshot(outcome, resourceId).value as { title: string }).title).toBe('V2-by-A');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('per-call override (keyed by resourceId) beats per-type registration', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    let perTypeCalls = 0;
    b.client.resources.onTransactionResourceResolution('TestResource', (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      perTypeCalls++;
      return { kind: 'use-server' };
    });

    let perCallCalls = 0;
    const perCallHandler: ResourceHandler = (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      perCallCalls++;
      return { kind: 'human-in-the-loop' };
    };

    const outcome = await b.client.resources.transaction(
      { [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } } },
      { onTransactionResourceResolution: { [resourceId]: perCallHandler } },
    );

    expect(perTypeCalls).toBe(0); // the keyed per-call entry handled this rid; per-type never saw conflict-pending
    expect(perCallCalls).toBe(1);
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.resources[resourceId]?.kind).toBe('human-in-the-loop');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('async handler: queue timeout suspended during await (handler can take longer than the txn timeout)', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    let resolverCompleted = false;
    b.client.resources.onTransactionResourceResolution('TestResource', async (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      await new Promise((r) => setTimeout(r, 200));
      resolverCompleted = true;
      return { kind: 'use-server' };
    });

    const start = Date.now();
    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });
    const elapsed = Date.now() - start;

    expect(resolverCompleted).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(outcome.kind).toBe('committed');
    expect(outcome.kind === 'committed' && outcome.resources[resourceId]?.kind).toBe('use-server');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('framework default (no registration, no override): use-server', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    expect(outcome.kind).toBe('committed');
    expect(outcome.kind === 'committed' && outcome.resources[resourceId]?.kind).toBe('use-server');
    expect((resolutionSnapshot(outcome, resourceId).value as { title: string }).title).toBe('V2-by-A');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('handler receives the originally-attempted local value + server snapshot at conflict-pending', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    let capturedLocal: { value: unknown; eTag: string } | undefined;
    let capturedServer: Snapshot | undefined;
    b.client.resources.onTransactionResourceResolution('TestResource', (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      capturedLocal = res.local;
      capturedServer = res.server as unknown as Snapshot;
      return { kind: 'use-server' };
    });

    await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    expect(capturedLocal).toBeDefined();
    expect((capturedLocal!.value as { title: string }).title).toBe('V2-by-B');
    expect(capturedLocal!.eTag).toBe(staleETag);
    expect(capturedServer).toBeDefined();
    expect((capturedServer!.value as { title: string }).title).toBe('V2-by-A');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });
});
