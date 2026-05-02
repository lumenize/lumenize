/**
 * ⚠ Hits the deployed `nebula-browser-test` worker. Run
 *   `wrangler deploy --name nebula-browser-test` (or equivalent for your test
 *   stack) BEFORE this bench, or you're measuring stale code. No automatic
 *   version-pinning today — see `tasks/nebula-release-process.md`.
 *
 * Transactions bench — measures the integrated parse-validate stack:
 *   client → Gateway → Star (Handler 1) → [Galaxy on cache miss] → Star (Handler 2)
 *   → load parser-validator facet → parseBatch → write transaction
 *   → mesh callback → client.handleTransactionResult.
 *
 * Three blocks:
 *   - warm: same Star across iterations, hot Handler 1 cache, no Galaxy hop
 *   - cold: fresh Star per iteration (varies tenant segment only), so the Star
 *     pays a Handler 1 cache miss + Galaxy hop. Galaxy + bundle stay warm.
 *   - ping: WS-leg baseline. No-op `ping()` on StarTest bounces a value back
 *     to the client via the same mesh-callback mechanism. Subtract from
 *     transaction latency to isolate in-Worker cost.
 *
 * Setup is lazy via `ensureClient()` (vitest's `beforeAll` does NOT run for
 * bench suites — see runBenchmarkSuite in vitest's source). The first warmup
 * iteration of the first bench pays the bootstrap cost as an outlier;
 * subsequent iterations and the recorded warm/cold/ping numbers are clean.
 *
 * Setup pays:
 *   - magic-link bootstrap (test@lumenize.io → founder/admin at galaxy scope)
 *   - NebulaClient construction + WS connect
 *   - Galaxy ontology registration
 *   - one bundle pre-warm transaction against a throwaway tenant scope, so
 *     the cold bench's iteration 1 doesn't pay the one-time ~262 ms bundle
 *     load.
 */

import { describe, bench, inject } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { OperationDescriptor } from '@lumenize/nebula/client';
import { HarnessNebulaClient } from './harness-client';
import { bootstrapAdmin } from './auth-bootstrap';

const ADMIN_EMAIL = 'test@lumenize.io';
const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

/** Unique galaxy per bench run so .wrangler/state doesn't carry state across runs. */
function uniqueGalaxy(): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `acme-${suffix}.app`;
}

function createOp(): Record<string, OperationDescriptor> {
  return {
    [crypto.randomUUID()]: {
      op: 'create',
      typeName: 'TestResource',
      nodeId: ROOT_NODE_ID,
      value: { title: 'bench' },
    },
  };
}

const galaxyScope = uniqueGalaxy();
const warmStar = `${galaxyScope}.tenant-warm`;

let clientPromise: Promise<HarnessNebulaClient> | undefined;

function ensureClient(): Promise<HarnessNebulaClient> {
  if (!clientPromise) clientPromise = setupClient();
  return clientPromise;
}

async function setupClient(): Promise<HarnessNebulaClient> {
  const baseUrl = inject('wranglerBaseUrl');
  const testToken = inject('emailTestToken');
  const browser = new Browser();

  await bootstrapAdmin({ browser, baseUrl, scope: galaxyScope, email: ADMIN_EMAIL, testToken });

  const ctx = browser.context(baseUrl);
  const client = new HarnessNebulaClient({
    baseUrl,
    authScope: galaxyScope,
    activeScope: galaxyScope,
    fetch: browser.fetch,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
  });

  const start = Date.now();
  while (client.connectionState !== 'connected') {
    if (Date.now() - start > 10_000) {
      throw new Error(`WS did not connect within 10s (state=${client.connectionState})`);
    }
    await new Promise((r) => globalThis.setTimeout(r, 25));
  }

  await client.callGalaxyAppendOntologyVersion(galaxyScope, {
    version: ONTOLOGY_VERSION,
    types: TEST_TYPES,
  });

  // Pre-warm bundle: bundleId is `<galaxy>/<version>`, constant across the
  // whole bench. Hitting any Star under this galaxy populates the Worker
  // Loader cache so cold-bench iteration 1 doesn't pay the ~262 ms load.
  await client.callStarTransaction(`${galaxyScope}.tenant-warmup`, ONTOLOGY_VERSION, createOp());

  return client;
}

describe('parse-validate transactions', () => {
  bench('warm — hot Star (Handler 1 cache hit)', async () => {
    const client = await ensureClient();
    await client.callStarTransaction(warmStar, ONTOLOGY_VERSION, createOp());
  }, { iterations: 100, warmupIterations: 5 });

  bench('cold — fresh Star (cache miss → Galaxy hop)', async () => {
    const client = await ensureClient();
    const star = `${galaxyScope}.tenant-cold-${crypto.randomUUID().slice(0, 8)}`;
    await client.callStarTransaction(star, ONTOLOGY_VERSION, createOp());
  }, { iterations: 30, warmupIterations: 0, time: 0 });

  bench('ping — WS-leg baseline (no-op handler)', async () => {
    const client = await ensureClient();
    await client.callStarPing(warmStar);
  }, { iterations: 100, warmupIterations: 5 });
});
