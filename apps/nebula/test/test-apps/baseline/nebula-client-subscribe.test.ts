/**
 * NebulaClient.resources.subscribe + state write-through — Phase 5.3.3a
 *
 * Tests the foundational client-side surface:
 *   - `new NebulaClient({ ontologyVersion, ... })` constructor wiring
 *   - `client.bindToState(state)` minimal-binding
 *   - `client.resources.subscribe(rt, rid)` returning a Promise that resolves
 *     on the first `handleResourceUpdate` for `(rt, rid)`
 *   - `handleResourceUpdate` writes through to bound state at
 *     `resources.{rt}.{rid}.{value, meta}` and triggers JurisJS
 *     hierarchical-notify-with-deepEquals (subscribers at deep paths
 *     fire only on real changes)
 *   - Coalescing: concurrent subscribe(rt, rid) calls share a single Promise settlement
 *
 * Fanout (Phase 5.3.2) is exercised here too — that's how we observe the
 * write-through happening after a non-self mutation.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot, TransactionResult } from '@lumenize/nebula';
import { createState } from '@lumenize/state';
import { createAuthenticatedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

async function twoAdminClients(star: string) {
  const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');

  const galaxyName = star.split('.').slice(0, 2).join('.');
  a.client.callGalaxyAppendOntologyVersion(galaxyName, {
    version: ONTOLOGY_VERSION,
    types: TEST_TYPES,
  });
  await waitForResult(a.client);

  const b = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  return { a, b };
}

async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => {
    expect(client.callCompleted).toBe(true);
  });
}

async function waitForSuccess(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}

async function createResource(
  client: NebulaClientTest,
  star: string,
  resourceId: string,
  title = 'Test Task',
): Promise<string> {
  client.callStarTransaction(star, ONTOLOGY_VERSION, {
    [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title } },
  });
  const result = await waitForSuccess(client) as TransactionResult;
  if (!result.ok) throw new Error('Expected create ok');
  return result.eTags[resourceId];
}

describe('nebula-client.resources.subscribe (5.3.3a)', () => {

  it('subscribe() resolves with the initial snapshot', async () => {
    const star = uniqueStar();
    const { a } = await twoAdminClients(star);
    const resourceId = generateUuid();
    const eTag = await createResource(a.client, star, resourceId, 'Initial value');

    const snap = await a.client.resources.subscribe('TestResource', resourceId);
    expect(snap).not.toBeNull();
    expect(snap!.value.title).toBe('Initial value');
    expect(snap!.meta.eTag).toBe(eTag);
    expect(snap!.meta.typeName).toBe('TestResource');

    a.client[Symbol.dispose]();
  });

  it('subscribe() returns null-or-rejection on non-existent resource', async () => {
    const star = uniqueStar();
    const { a } = await twoAdminClients(star);

    // Phase 5.3.1 makes subscribe-before-create reject. The Promise should
    // reject; we should NOT get a null resolve.
    await expect(
      a.client.resources.subscribe('TestResource', generateUuid()),
    ).rejects.toThrow(/not found/);

    a.client[Symbol.dispose]();
  });

  it('handleResourceUpdate writes value + meta through to bound state', async () => {
    const star = uniqueStar();
    const { a } = await twoAdminClients(star);
    const resourceId = generateUuid();
    await createResource(a.client, star, resourceId, 'Bound');

    const state = createState();
    a.client.bindToState(state);

    await a.client.resources.subscribe('TestResource', resourceId);

    expect(state.getState(`resources.TestResource.${resourceId}.value`)).toEqual({ title: 'Bound' });
    const meta = state.getState(`resources.TestResource.${resourceId}.meta`) as any;
    expect(meta.typeName).toBe('TestResource');
    expect(meta.eTag).toBeDefined();
    expect(meta.deleted).toBe(false);

    a.client[Symbol.dispose]();
  });

  it('fanout pushes write through to bound state on subscriber (deep-binding directives stay reactive)', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const resourceId = generateUuid();
    const eTag = await createResource(a.client, star, resourceId, 'Original');

    const bState = createState();
    b.client.bindToState(bState);

    // Subscribe a deep path in B's state — this is the simulated x-text="…value.title" binding.
    const titleObservations: unknown[] = [];
    bState.subscribe(`resources.TestResource.${resourceId}.value.title`, (v) => {
      titleObservations.push(v);
    });

    await b.client.resources.subscribe('TestResource', resourceId);
    // Initial subscribe fired the title binding — subscribers fire for ancestor writes via 5.3.0's extended subscribe
    expect(titleObservations).toContain('Original');
    const observationsAfterInitial = titleObservations.length;

    // A mutates the resource value
    a.client.callStarTransaction(star, ONTOLOGY_VERSION, {
      [resourceId]: { op: 'put', eTag, value: { title: 'Updated' } },
    });
    await waitForSuccess(a.client);

    // B's state should converge to the new value via fanout → handleResourceUpdate → write-through
    await vi.waitFor(() => {
      const v = bState.getState(`resources.TestResource.${resourceId}.value`) as any;
      expect(v?.title).toBe('Updated');
    });

    // The deep-path subscriber should have fired again (title changed)
    expect(titleObservations.length).toBeGreaterThan(observationsAfterInitial);
    expect(titleObservations.at(-1)).toBe('Updated');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('deep-binding subscriber does NOT fire when an unrelated field changes (deep-equals dedup)', async () => {
    // Inline setup with a two-field type rather than reusing twoAdminClients
    // (which pins the v1 ontology to a one-field TestResource). Two clients,
    // shared v1 ontology with `{ title; body }`.
    const star = uniqueStar();
    const TWO_FIELD_TYPES = `interface TwoField { title: string; body: string; }`;

    const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const galaxyName = star.split('.').slice(0, 2).join('.');
    a.client.callGalaxyAppendOntologyVersion(galaxyName, {
      version: ONTOLOGY_VERSION,
      types: TWO_FIELD_TYPES,
    });
    await waitForResult(a.client);
    const b = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');

    const resourceId = generateUuid();
    a.client.callStarTransaction(star, ONTOLOGY_VERSION, {
      [resourceId]: { op: 'create', typeName: 'TwoField', nodeId: ROOT_NODE_ID, value: { title: 'T', body: 'B' } },
    });
    const createResult = await waitForSuccess(a.client) as TransactionResult;
    if (!createResult.ok) throw new Error('Expected create ok');
    const eTag = createResult.eTags[resourceId];

    const bState = createState();
    b.client.bindToState(bState);

    const titleFires: unknown[] = [];
    const bodyFires: unknown[] = [];
    bState.subscribe(`resources.TwoField.${resourceId}.value.title`, (v) => { titleFires.push(v); });
    bState.subscribe(`resources.TwoField.${resourceId}.value.body`, (v) => { bodyFires.push(v); });

    await b.client.resources.subscribe('TwoField', resourceId);
    const titleFiresAfterInit = titleFires.length;
    const bodyFiresAfterInit = bodyFires.length;

    // A mutates ONLY the title — body stays the same
    a.client.callStarTransaction(star, ONTOLOGY_VERSION, {
      [resourceId]: { op: 'put', eTag, value: { title: 'T-new', body: 'B' } },
    });
    await waitForSuccess(a.client);

    await vi.waitFor(() => {
      expect(titleFires.length).toBeGreaterThan(titleFiresAfterInit);
    });

    // After write-through completes, the body subscriber should NOT have fired
    // because deep-equals dedup gated the no-op fanout.
    expect(bodyFires.length).toBe(bodyFiresAfterInit);
    expect(titleFires.at(-1)).toBe('T-new');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('coalesces concurrent subscribe() calls to the same (rt, rid)', async () => {
    const star = uniqueStar();
    const { a } = await twoAdminClients(star);
    const resourceId = generateUuid();
    await createResource(a.client, star, resourceId, 'Coalesced');

    const p1 = a.client.resources.subscribe('TestResource', resourceId);
    const p2 = a.client.resources.subscribe('TestResource', resourceId);
    const p3 = a.client.resources.subscribe('TestResource', resourceId);

    const [s1, s2, s3] = await Promise.all([p1, p2, p3]);
    expect(s1!.value.title).toBe('Coalesced');
    expect(s2!.value.title).toBe('Coalesced');
    expect(s3!.value.title).toBe('Coalesced');
    // All three resolved with the same snapshot (deep-equal check)
    expect(s1!.meta.eTag).toBe(s2!.meta.eTag);
    expect(s2!.meta.eTag).toBe(s3!.meta.eTag);

    a.client[Symbol.dispose]();
  });

  it('subscribe() Promise rejects when ontology version is stale at construction', async () => {
    const star = uniqueStar();
    const { a } = await twoAdminClients(star);
    const resourceId = generateUuid();
    await createResource(a.client, star, resourceId, 'Stale-test');

    // Register v2 on Galaxy
    const galaxyName = star.split('.').slice(0, 2).join('.');
    a.client.callGalaxyAppendOntologyVersion(galaxyName, {
      version: 'v2',
      types: TEST_TYPES,
    });
    await waitForResult(a.client);

    // Make Star learn v2 by issuing a v2 read
    a.client.callStarRead(star, 'v2', resourceId);
    await waitForResult(a.client);

    // Subscribe with the v1-pinned client — Star will detect mismatch
    await expect(
      a.client.resources.subscribe('TestResource', resourceId),
    ).rejects.toThrow(/Ontology version mismatch/);

    a.client[Symbol.dispose]();
  });
});
