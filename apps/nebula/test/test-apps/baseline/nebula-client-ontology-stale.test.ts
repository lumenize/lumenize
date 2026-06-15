/**
 * Ontology-staleness signal — Phase 5.3.3d
 *
 * Star-side: mismatch paths now throw/return an `OntologyStaleError`
 * (structured signal: `name === 'OntologyStaleError'` + custom fields
 * `clientVersion` and `currentVersion`).
 *
 * Client-side: detects via `isOntologyStaleError(err)` and:
 *   - fires the constructor-registered `onShouldRefreshUI({ clientVersion, currentVersion, reason: 'ontology-stale' })`
 *   - on `transaction()` → resolves the Promise with `{ resolution: 'ontology-stale', clientVersion, currentVersion }`
 *   - on `read()` → rejects the Promise with the structured Error
 *   - on `subscribe()` → rejects the Promise with the structured Error
 *
 * The hook is fired on ALL three paths (transaction / read / subscribe) so
 * a UI bound to a listen-only resource (subscribe only, no mutations) still
 * gets the refresh prompt on next op.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { OntologyStaleInfo } from '@lumenize/nebula';
import { isOntologyStaleError } from '@lumenize/nebula';
import { createAuthenticatedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const TEST_TYPES = `interface TestResource { title: string; }`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

/**
 * Set up a Star with both v1 and v2 ontologies registered, and Star's cache
 * advanced to v2 (so a v1-pinned client's next op will hit the mismatch).
 * Returns a v1-pinned client + the `onShouldRefreshUI` spy.
 */
async function setupStaleScenario() {
  const star = uniqueStar();
  const galaxyName = star.split('.').slice(0, 2).join('.');
  const refreshHookSpy = vi.fn<(info: OntologyStaleInfo) => void>();

  // Construct the client with v1 + the hook
  const a = await createAuthenticatedClient(
    NebulaClientTest, new Browser(), star, star, 'admin@example.com',
    'v1',
    { onShouldRefreshUI: refreshHookSpy },
  );

  // Register v1, then v2 on Galaxy
  a.client.callGalaxyAppendOntologyVersion(galaxyName, { version: 'v1', types: TEST_TYPES });
  await vi.waitFor(() => { expect(a.client.callCompleted).toBe(true); });

  // Create a resource at v1 so we have something to operate on
  const resourceId = generateUuid();
  const created = await a.client.resources.transaction({
    [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'V1-resource' } },
  });
  if (created.resolution !== 'committed') throw new Error('Expected committed');
  const eTag = created.eTag;

  // Register v2 on Galaxy
  a.client.callGalaxyAppendOntologyVersion(galaxyName, { version: 'v2', types: TEST_TYPES });
  await vi.waitFor(() => { expect(a.client.callCompleted).toBe(true); });

  // Force Star to install v2 by issuing any v2 op (per-call override)
  await a.client.resources.read('TestResource', resourceId, { appVersion: 'v2' });
  // Star's cache is now at v2; refreshHookSpy hasn't been called yet because
  // this op didn't trigger mismatch — we explicitly used v2.
  expect(refreshHookSpy).not.toHaveBeenCalled();

  return { star, resourceId, eTag, client: a.client, refreshHookSpy };
}

describe('nebula-client ontology-stale signal (5.3.3d)', () => {

  it('transaction: stale-v1 → resolves with ontology-stale + fires onShouldRefreshUI', async () => {
    const { client, resourceId, eTag, refreshHookSpy } = await setupStaleScenario();

    // Constructor-pinned v1 transaction — Star has v2 cached, mismatch fires
    const outcome = await client.resources.transaction({
      [resourceId]: { op: 'put', eTag, value: { title: 'V1-write-attempt' } },
    });

    expect(outcome.resolution).toBe('ontology-stale');
    if (outcome.resolution !== 'ontology-stale') throw new Error('Expected ontology-stale');
    expect(outcome.clientVersion).toBe('v1');
    expect(outcome.currentVersion).toBe('v2');

    expect(refreshHookSpy).toHaveBeenCalledTimes(1);
    expect(refreshHookSpy).toHaveBeenCalledWith({
      reason: 'ontology-stale',
      clientVersion: 'v1',
      currentVersion: 'v2',
    });

    client[Symbol.dispose]();
  });

  it('read: stale-v1 → Promise rejects with OntologyStaleError-shaped Error + fires onShouldRefreshUI', async () => {
    const { client, resourceId, refreshHookSpy } = await setupStaleScenario();

    try {
      // Constructor-pinned v1 read — Star has v2 cached, mismatch fires
      await client.resources.read('TestResource', resourceId);
      throw new Error('Expected ontology-stale rejection');
    } catch (err) {
      expect(isOntologyStaleError(err)).toBe(true);
      if (isOntologyStaleError(err)) {
        expect(err.clientVersion).toBe('v1');
        expect(err.currentVersion).toBe('v2');
      }
    }

    expect(refreshHookSpy).toHaveBeenCalledTimes(1);
    expect(refreshHookSpy).toHaveBeenCalledWith({
      reason: 'ontology-stale',
      clientVersion: 'v1',
      currentVersion: 'v2',
    });

    client[Symbol.dispose]();
  });

  it('subscribe: stale-v1 → Promise rejects + fires onShouldRefreshUI', async () => {
    const { client, resourceId, refreshHookSpy } = await setupStaleScenario();

    try {
      await client.resources.subscribe('TestResource', resourceId);
      throw new Error('Expected ontology-stale rejection');
    } catch (err) {
      expect(isOntologyStaleError(err)).toBe(true);
      if (isOntologyStaleError(err)) {
        expect(err.clientVersion).toBe('v1');
        expect(err.currentVersion).toBe('v2');
      }
    }

    expect(refreshHookSpy).toHaveBeenCalledTimes(1);
    expect(refreshHookSpy).toHaveBeenCalledWith({
      reason: 'ontology-stale',
      clientVersion: 'v1',
      currentVersion: 'v2',
    });

    client[Symbol.dispose]();
  });

  it('no onShouldRefreshUI registered: stale signal still resolves the Promise variant', async () => {
    // Same setup but no hook
    const star = uniqueStar();
    const galaxyName = star.split('.').slice(0, 2).join('.');

    const a = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), star, star, 'admin@example.com',
      'v1',
      // no onShouldRefreshUI
    );

    a.client.callGalaxyAppendOntologyVersion(galaxyName, { version: 'v1', types: TEST_TYPES });
    await vi.waitFor(() => { expect(a.client.callCompleted).toBe(true); });

    const resourceId = generateUuid();
    const created = await a.client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'V1' } },
    });
    if (created.resolution !== 'committed') throw new Error('Expected committed');
    const eTag = created.eTag;

    a.client.callGalaxyAppendOntologyVersion(galaxyName, { version: 'v2', types: TEST_TYPES });
    await vi.waitFor(() => { expect(a.client.callCompleted).toBe(true); });

    await a.client.resources.read('TestResource', resourceId, { appVersion: 'v2' });

    // No hook registered — should still get the structured outcome without
    // any error from the framework
    const outcome = await a.client.resources.transaction({
      [resourceId]: { op: 'put', eTag, value: { title: 'V1-write' } },
    });
    expect(outcome.resolution).toBe('ontology-stale');

    a.client[Symbol.dispose]();
  });
});
