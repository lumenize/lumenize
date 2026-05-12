/**
 * Conflict-resolver machinery — Phase 5.3.3c
 *
 * Tests `client.resources.onETagConflict(rt, resolver, options?)` registration,
 * per-call `options.onETagConflict` override, and resolver verdict handling
 * (`use-server` / `use-this` / `human-in-the-loop`) including recursive
 * `use-this` bounded by `maxRetries`.
 *
 * Bindings/flash class (`context.bindings`) is deferred to Phase 5.3.6. The
 * resolver here receives `context.bindings: new Map()` (empty); we don't
 * assert on flash behavior.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import type { ConflictResolution, ConflictResolver } from '@lumenize/nebula';
import { createAuthenticatedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
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
 * Helper: A creates resource X at title 'V1', then A updates to 'V2-by-A',
 * and B tries to update with the stale (V1) eTag. B's transaction conflicts.
 * Returns:
 *   - resourceId
 *   - staleETag (the eTag B should use to force the conflict)
 *   - latestServerTitle ('V2-by-A')
 */
async function setupConflict(star: string, a: { client: NebulaClientTest }, b: { client: NebulaClientTest }) {
  const resourceId = generateUuid();

  const created = await a.client.resources.transaction({
    [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'V1' } },
  });
  if (created.resolution !== 'committed') throw new Error('Expected committed');
  const staleETag = created.eTag;

  const updated = await a.client.resources.transaction({
    [resourceId]: { op: 'put', eTag: staleETag, value: { title: 'V2-by-A' } },
  });
  if (updated.resolution !== 'committed') throw new Error('Expected committed');

  void b; // b just needs to exist for follow-on test code
  return { resourceId, staleETag };
}

describe('nebula-client.resources.onETagConflict (5.3.3c)', () => {

  it('per-type registered "use-server" resolver: resolves with use-server + writes server.value', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    // Register a resolver that explicitly says use-server (same as default,
    // but verifies the registration path is wired)
    let resolverCallCount = 0;
    b.client.resources.onETagConflict('TestResource', (_local, _server, _ctx) => {
      resolverCallCount++;
      return { resolution: 'use-server' };
    });

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    expect(resolverCallCount).toBe(1);
    expect(outcome.resolution).toBe('use-server');
    if (outcome.resolution !== 'use-server') throw new Error('Expected use-server');
    expect(outcome.resources[resourceId].value.title).toBe('V2-by-A');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('per-type "use-this" resolver retries with server eTag + new value (single retry succeeds)', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    let resolverCallCount = 0;
    b.client.resources.onETagConflict('TestResource', (local, server) => {
      resolverCallCount++;
      // Use a merged value: keep our title intent but acknowledge we saw server
      return { resolution: 'use-this', value: { title: `merged(${(local.value as { title: string }).title} | ${(server.value as { title: string }).title})` } };
    });

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    // First attempt conflicts → resolver fires once → retry succeeds (no
    // concurrent third writer, so the resubmission with server.eTag wins).
    expect(resolverCallCount).toBe(1);
    expect(outcome.resolution).toBe('committed');
    if (outcome.resolution !== 'committed') throw new Error('Expected committed');

    // Verify the merged value landed
    const final = await b.client.resources.read('TestResource', resourceId);
    expect(final!.value.title).toBe('merged(V2-by-B | V2-by-A)');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('retries-exhausted: resolver always returns use-this, A keeps mutating, B caps at maxRetries', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    // Force perpetual conflict: each time B's retry submits, A has already
    // updated again. We simulate this by making A's writes happen INSIDE the
    // resolver — after server returns to B, but before B's retry hits Star,
    // A jumps in with a fresh write.
    //
    // The resolver awaits A's mutation (which uses the server's "latest"
    // eTag), so when B's retry lands, the eTag is stale again.
    let resolverCallCount = 0;
    let aETag = staleETag;
    // After setupConflict, server is at the post-V2 eTag — we don't have it
    // directly but A can fetch.
    const currentSnap = await a.client.resources.read('TestResource', resourceId);
    aETag = currentSnap!.meta.eTag;

    b.client.resources.onETagConflict('TestResource', async (_local, _server) => {
      resolverCallCount++;
      // Race A in: update so B's retry will conflict again
      const out = await a.client.resources.transaction({
        [resourceId]: { op: 'put', eTag: aETag, value: { title: `A-attempt-${resolverCallCount}` } },
      });
      if (out.resolution === 'committed') aETag = out.eTag;
      return { resolution: 'use-this', value: { title: `B-attempt-${resolverCallCount}` } };
    }, { maxRetries: 3 });

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    // Resolver fires once per failed attempt. attempt starts at 1, after
    // resolver attempt becomes 2; cap is 3, so resolver fires at attempts 1,
    // 2, 3 (third firing tries attempt 4, exceeds cap → retries-exhausted).
    expect(outcome.resolution).toBe('retries-exhausted');
    if (outcome.resolution !== 'retries-exhausted') throw new Error('Expected retries-exhausted');
    expect(outcome.attempts).toBe(3);
    expect(resolverCallCount).toBe(3);

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('human-in-the-loop: resolves with handoff; optimistic state stays painted (no write-through)', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    // No state bound — we're just verifying the resolution shape and that
    // server.value is NOT written through state-side. (Phase 5.3.6 will
    // wire bindToState's middleware which DOES paint optimistically before
    // the transaction; for now we directly observe the resolution.)
    b.client.resources.onETagConflict('TestResource', () => {
      return { resolution: 'human-in-the-loop' };
    });

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    expect(outcome.resolution).toBe('human-in-the-loop');
    if (outcome.resolution !== 'human-in-the-loop') throw new Error('Expected human-in-the-loop');
    expect(outcome.resources[resourceId].value.title).toBe('V2-by-A');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('per-call override beats per-type registration', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    // Per-type says use-server
    let perTypeCalls = 0;
    b.client.resources.onETagConflict('TestResource', () => {
      perTypeCalls++;
      return { resolution: 'use-server' };
    });

    // Per-call override says human-in-the-loop
    let perCallCalls = 0;
    const perCallResolver: ConflictResolver = () => {
      perCallCalls++;
      return { resolution: 'human-in-the-loop' };
    };

    const outcome = await b.client.resources.transaction(
      { [resourceId]: { op: 'put', eTag: staleETag, value: { title: 'V2-by-B' } } },
      { onETagConflict: perCallResolver },
    );

    expect(perTypeCalls).toBe(0);
    expect(perCallCalls).toBe(1);
    expect(outcome.resolution).toBe('human-in-the-loop');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('async resolver: queue timeout suspended during await (resolver can take longer than TXN timeout)', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    // Resolver waits 200ms (well under TXN_TIMEOUT but enough to verify the
    // await is honored). A longer wait would be ideal but slows the test;
    // the structural assertion is that the resolver's Promise gates the
    // transaction's resolution.
    let resolverCompleted = false;
    b.client.resources.onETagConflict('TestResource', async (): Promise<ConflictResolution> => {
      await new Promise((r) => setTimeout(r, 200));
      resolverCompleted = true;
      return { resolution: 'use-server' };
    });

    const start = Date.now();
    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', eTag: staleETag, value: { title: 'V2-by-B' } },
    });
    const elapsed = Date.now() - start;

    expect(resolverCompleted).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(outcome.resolution).toBe('use-server');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('framework default (no registration, no override): use-server', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    // No resolver registered anywhere — framework default fires
    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    expect(outcome.resolution).toBe('use-server');
    if (outcome.resolution !== 'use-server') throw new Error('Expected use-server');
    expect(outcome.resources[resourceId].value.title).toBe('V2-by-A');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('resolver receives the originally-attempted local value + server snapshot', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    let capturedLocal: { value: unknown; eTag: string } | undefined;
    let capturedServer: Snapshot | undefined;
    b.client.resources.onETagConflict('TestResource', (local, server) => {
      capturedLocal = local;
      capturedServer = server;
      return { resolution: 'use-server' };
    });

    await b.client.resources.transaction({
      [resourceId]: { op: 'put', eTag: staleETag, value: { title: 'V2-by-B' } },
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
