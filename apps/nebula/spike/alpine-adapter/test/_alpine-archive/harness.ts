/**
 * Phase 1 shared harness: bootstrap auth → ontology version → factory.
 * Returns `{ client, store, scope, browser, activeScope, factory, createResource }`
 * for probe tests to use.
 *
 * Mirrors the Phase 0b transaction-roundtrip test setup, adapted for Node +
 * jsdom + wrangler-dev (instead of vitest-pool-workers).
 */
import { expect, vi, inject } from 'vitest';
import { Browser } from '@lumenize/testing';
import { effectScope, type EffectScope } from '@vue/reactivity';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { TransactionResult } from '@lumenize/nebula/client';
import { createNebulaClient } from '../../src/create-nebula-client';
import { adaptNebulaClient } from '../../src/nebula-client-adapter';
import { NebulaClientTest } from '../nebula-client-test';
import type { FactoryResult } from '../../src/types';

const AUTH_PREFIX = '/auth';
export const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; status: string; }
interface TestList { items: string[]; }`;

async function bootstrapAdmin(browser: Browser, baseUrl: string, authScope: string, email: string): Promise<void> {
  const mlResp = await browser.fetch(`${baseUrl}${AUTH_PREFIX}/${authScope}/email-magic-link?_test=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(mlResp.status).toBe(200);
  const { magic_link } = await mlResp.json() as { magic_link: string };
  await browser.fetch(magic_link);
}

export interface PhaseOneHarness {
  baseUrl: string;
  browser: Browser;
  authScope: string;
  activeScope: string;
  galaxyName: string;
  client: NebulaClientTest;
  factory: FactoryResult;
  store: any;
  scope: EffectScope;
  /** Create a resource via `client.callStarTransaction` (admin path). Returns initial eTag. */
  createResource(resourceId: string, typeName: string, value: any): Promise<string>;
  dispose(): void;
}

/**
 * Stand up the full Phase 1 stack:
 *  - new Browser
 *  - bootstrap admin auth
 *  - new NebulaClientTest, wait for connection
 *  - register ontology version
 *  - wrap with factory (adapter → createNebulaClient)
 *  - create an effectScope for Alpine bindings to live inside
 */
export async function setupHarness(): Promise<PhaseOneHarness> {
  const baseUrl = inject('wranglerBaseUrl');
  const authScope = `acme-${crypto.randomUUID().slice(0, 8)}`;
  const activeScope = `${authScope}.app.tenant-a`;
  const galaxyName = `${authScope}.app`;
  const browser = new Browser();
  await bootstrapAdmin(browser, baseUrl, authScope, 'admin@example.com');

  const ctx = browser.context(baseUrl);
  const client = new NebulaClientTest({
    baseUrl,
    authScope,
    activeScope,
    ontologyVersion: ONTOLOGY_VERSION,
    fetch: browser.fetch,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });

  client.callGalaxyAppendOntologyVersion(galaxyName, {
    version: ONTOLOGY_VERSION,
    types: TEST_TYPES,
  });
  await vi.waitFor(() => expect(client.callCompleted).toBe(true));

  const factory = createNebulaClient(adaptNebulaClient(client), { unsubscribeGraceMs: 100 });
  const scope = effectScope();

  async function createResource(rid: string, typeName: string, value: any): Promise<string> {
    client.callStarTransaction(activeScope, ONTOLOGY_VERSION, {
      [rid]: { op: 'create', typeName, nodeId: ROOT_NODE_ID, value },
    });
    await vi.waitFor(() => expect(client.callCompleted).toBe(true));
    const result = client.lastResult as TransactionResult;
    if (!result.ok) throw new Error('create failed: ' + JSON.stringify(result));
    return result.eTags[rid];
  }

  return {
    baseUrl, browser, authScope, activeScope, galaxyName,
    client, factory, store: factory.store, scope,
    createResource,
    dispose() {
      scope.stop();
      client[Symbol.dispose]();
    },
  };
}

/**
 * Lazy-load Alpine — needs jsdom to be set up first. Returns the Alpine
 * default export. Idempotent within a test file (loads once).
 */
let alpineLoaded: any = null;
export async function loadAlpine(): Promise<any> {
  if (alpineLoaded) return alpineLoaded;
  const mod = await import('alpinejs');
  alpineLoaded = mod.default;
  return alpineLoaded;
}
