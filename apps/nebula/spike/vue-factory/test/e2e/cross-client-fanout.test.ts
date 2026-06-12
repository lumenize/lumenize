/**
 * Phase 0b — Cross-client fanout: a mutation from one admin client lands in
 * a second client's factory store via real Star.fanout (different code path
 * than the transaction-originator's own commit-eTag write).
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

describe('Phase 0b — cross-client fanout', () => {
  it('client A mutates → client B observes update in factory store', async () => {
    const authScope = `acme-${crypto.randomUUID().slice(0, 8)}`;
    const activeScope = `${authScope}.app.tenant-a`;
    const galaxyName = `${authScope}.app`;

    // Two independent browsers — different cookie jars, different WS connections.
    const browserA = new Browser();
    const browserB = new Browser();

    await bootstrapAdmin(browserA, authScope, 'admin@example.com');
    // browser B logs in as same admin (different browser session, same identity)
    await bootstrapAdmin(browserB, authScope, 'admin@example.com');

    const clientA = await createClient(browserA, authScope, activeScope);

    // Set up ontology (client A admin → Galaxy)
    clientA.callGalaxyAppendOntologyVersion(galaxyName, {
      version: ONTOLOGY_VERSION,
      types: TEST_TYPES,
    });
    await vi.waitFor(() => expect(clientA.callCompleted).toBe(true));

    // Client A creates a resource
    const rid = crypto.randomUUID();
    clientA.callStarTransaction(activeScope, ONTOLOGY_VERSION, {
      [rid]: {
        op: 'create',
        typeName: 'TestResource',
        nodeId: ROOT_NODE_ID,
        value: { title: 'shared-original', status: 'todo' },
      },
    });
    await vi.waitFor(() => expect(clientA.callCompleted).toBe(true));
    const initialResult = clientA.lastResult as TransactionResult;
    if (!initialResult.ok) throw new Error('create failed');
    const initialETag = initialResult.eTags[rid];

    // Client B connects + wraps with factory + subscribes via effectScope
    const clientB = await createClient(browserB, authScope, activeScope);
    const factoryB = createNebulaClient(adaptNebulaClient(clientB), { unsubscribeGraceMs: 100 });

    const observedTitles: (string | undefined)[] = [];
    const scope = effectScope();
    scope.run(() => {
      effect(() => {
        observedTitles.push(factoryB.store.resources?.TestResource?.[rid]?.value?.title);
      });
    });

    // Wait for initial snapshot to arrive at client B (auto-subscribe → Star.subscribe → handleResourceUpdate)
    await vi.waitFor(() => {
      expect(factoryB.store.resources.TestResource[rid].value.title).toBe('shared-original');
      expect(factoryB.store.resources.TestResource[rid].meta.eTag).toBe(initialETag);
    });

    // Client A mutates the resource via direct Star.transaction (not through factory).
    // Client B should receive the fanout via real Star push → handleResourceUpdate
    // → factory's onResourceUpdate handler → store write.
    clientA.callStarTransaction(activeScope, ONTOLOGY_VERSION, {
      [rid]: {
        op: 'put',
        eTag: initialETag,
        value: { title: 'mutated-by-A', status: 'in-progress' },
      },
    });
    await vi.waitFor(() => expect(clientA.callCompleted).toBe(true));

    // Client B's factory store should pick up the change via fanout.
    await vi.waitFor(() => {
      expect(factoryB.store.resources.TestResource[rid].value.title).toBe('mutated-by-A');
      expect(factoryB.store.resources.TestResource[rid].value.status).toBe('in-progress');
      // eTag should have advanced
      expect(factoryB.store.resources.TestResource[rid].meta.eTag).not.toBe(initialETag);
    });

    // The effect should have re-fired with the new title.
    expect(observedTitles).toContain('mutated-by-A');

    scope.stop();
    clientA[Symbol.dispose]();
    clientB[Symbol.dispose]();
  });
});
