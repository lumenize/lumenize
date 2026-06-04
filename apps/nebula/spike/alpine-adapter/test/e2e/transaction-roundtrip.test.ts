/**
 * Phase 0b — End-to-end transaction round-trip.
 *
 * Verifies the factory + reshaped NebulaClient + real Star DO chain:
 *   1. Admin sets up an ontology version + creates a resource
 *   2. Factory store auto-subscribes to the resource (effectScope tracking)
 *   3. setState on a value field → factory's middleware emits real transaction
 *   4. Star processes, returns committed eTag → factory writes through
 *      store.lmz.connection.* and meta.eTag.
 */
import { describe, it, expect, vi } from 'vitest';
import { effect, effectScope } from '@vue/reactivity';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { TransactionResult } from '@lumenize/nebula';
import { createNebulaClient } from '../../src/create-nebula-client';
import { adaptNebulaClient } from '../../src/nebula-client-adapter';
import { NebulaClientTest } from '../nebula-client-test';

const ORIGIN = 'http://localhost';
const AUTH_PREFIX = '/auth';
const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; status: string; }`;

function uniqueScope(): { authScope: string; activeScope: string; galaxyName: string } {
  const authScope = `acme-${crypto.randomUUID().slice(0, 8)}`;
  const activeScope = `${authScope}.app.tenant-a`;
  // galaxyName is the first two scope segments
  const galaxyName = `${authScope}.app`;
  return { authScope, activeScope, galaxyName };
}

async function bootstrapAdmin(browser: Browser, authScope: string, email: string): Promise<void> {
  const mlResp = await browser.fetch(`${ORIGIN}${AUTH_PREFIX}/${authScope}/email-magic-link?_test=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(mlResp.status).toBe(200);
  const { magic_link } = await mlResp.json() as { magic_link: string };
  await browser.fetch(magic_link);
}

async function createClient(browser: Browser, authScope: string, activeScope: string): Promise<NebulaClientTest> {
  const ctx = browser.context(ORIGIN);
  const client = new NebulaClientTest({
    baseUrl: ORIGIN,
    authScope,
    activeScope,
    ontologyVersion: ONTOLOGY_VERSION,
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'));
  return client;
}

async function setupAdminClient(): Promise<{ client: NebulaClientTest; activeScope: string }> {
  const { authScope, activeScope, galaxyName } = uniqueScope();
  const browser = new Browser();
  await bootstrapAdmin(browser, authScope, 'admin@example.com');
  const client = await createClient(browser, authScope, activeScope);

  client.callGalaxyAppendOntologyVersion(galaxyName, {
    version: ONTOLOGY_VERSION,
    types: TEST_TYPES,
  });
  await vi.waitFor(() => expect(client.callCompleted).toBe(true));

  return { client, activeScope };
}

async function createResource(
  client: NebulaClientTest,
  activeScope: string,
  resourceId: string,
  value: { title: string; status: string },
): Promise<string> {
  client.callStarTransaction(activeScope, ONTOLOGY_VERSION, {
    [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value },
  });
  await vi.waitFor(() => expect(client.callCompleted).toBe(true));
  const result = client.lastResult as TransactionResult;
  if (!result.ok) throw new Error('create failed: ' + JSON.stringify(result));
  return result.eTags[resourceId];
}

describe('Phase 0b — transaction round-trip via factory', () => {
  it('local setState → real Star.transaction → committed → store.meta.eTag advances', async () => {
    const { client, activeScope } = await setupAdminClient();
    const rid = crypto.randomUUID();
    const initialETag = await createResource(client, activeScope, rid, {
      title: 'original',
      status: 'todo',
    });

    // Wrap client with factory
    const factory = createNebulaClient(adaptNebulaClient(client), { unsubscribeGraceMs: 100 });

    // Subscribe via effectScope: when an effect reads the resource, factory
    // auto-subscribes (via real Star.subscribe), the initial snapshot lands,
    // and store.resources.TestResource[rid].meta.eTag should equal initialETag.
    const scope = effectScope();
    scope.run(() => {
      effect(() => {
        // Touch the resource so refcount → 1 → real subscribe
        void factory.store.resources?.TestResource?.[rid]?.value?.title;
      });
    });

    await vi.waitFor(() => {
      expect(factory.store.resources.TestResource[rid].meta.eTag).toBe(initialETag);
    });

    // Now perform a local setState on a value field. The factory's syncedState
    // middleware sees the write and emits a transaction via the adapter.
    factory.store.resources.TestResource[rid].value.title = 'updated-by-factory';

    // Verify the meta.eTag advances after the real Star.transaction lands.
    await vi.waitFor(() => {
      const eTag = factory.store.resources.TestResource[rid].meta.eTag;
      expect(eTag).not.toBe(initialETag);
      expect(typeof eTag).toBe('string');
      expect((eTag as string).length).toBeGreaterThan(0);
    });

    // Optimistic write should still be in place (committed never reverts).
    expect(factory.store.resources.TestResource[rid].value.title).toBe('updated-by-factory');

    scope.stop();
    client[Symbol.dispose]();
  });
});
