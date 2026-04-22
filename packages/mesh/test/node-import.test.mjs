/**
 * Node.js runtime smoke test for `@lumenize/mesh/client`.
 *
 * Runs under Node's built-in `node:test` runner (NOT vitest-pool-workers).
 * This is specifically the test that would have caught the original
 * `cloudflare:workers` import failure — the whole mesh test suite runs
 * inside the Workers runtime, so it can never surface Node-side import
 * problems. This file does.
 *
 * If this file starts failing with `Cannot find module 'cloudflare:workers'`
 * or similar, someone added a Workers-only import into the module graph
 * reachable from `@lumenize/mesh/client`. See `src/client-index.ts` for
 * the allowlist and `src/gateway-messages.ts` for the Workers-free shared
 * primitives.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

test('LumenizeClient imports cleanly from @lumenize/mesh/client', async () => {
  const mod = await import('@lumenize/mesh/client');
  assert.ok(mod.LumenizeClient, 'LumenizeClient exported');
  assert.equal(typeof mod.LumenizeClient, 'function', 'LumenizeClient is a class');
  assert.equal(typeof mod.mesh, 'function', 'mesh() decorator exported');
  assert.equal(typeof mod.meshFn, 'function', 'meshFn() helper exported');
  assert.ok(mod.GatewayMessageType, 'GatewayMessageType exported');
  assert.equal(mod.GatewayMessageType.CALL, 'call', 'GatewayMessageType.CALL value correct');
  assert.ok(mod.ClientDisconnectedError, 'ClientDisconnectedError exported');
  assert.ok(
    new mod.ClientDisconnectedError('test') instanceof Error,
    'ClientDisconnectedError is an Error subclass',
  );
  assert.equal(
    new mod.ClientDisconnectedError('test').name,
    'ClientDisconnectedError',
    'ClientDisconnectedError.name is set',
  );
});

test('main @lumenize/mesh barrel correctly fails to load in Node (by design)', async () => {
  // The main barrel re-exports LumenizeDO / LumenizeWorker / LumenizeClientGateway,
  // which transitively `import { DurableObject } from "cloudflare:workers"`.
  // Node can't resolve that, so the barrel must throw at module load.
  //
  // This test documents the boundary. If it starts passing (main barrel loads
  // clean in Node), someone rearranged the module graph and the `./client`
  // subpath may no longer be necessary — re-evaluate.
  await assert.rejects(
    () => import('@lumenize/mesh'),
    // Node rejects with ERR_UNSUPPORTED_ESM_URL_SCHEME for `cloudflare:*`
    // (the scheme isn't a supported ESM URL scheme). Match on either the
    // specific code or the scheme name to catch both phrasings.
    (err) =>
      err?.code === 'ERR_UNSUPPORTED_ESM_URL_SCHEME' ||
      /cloudflare:/.test(err?.message ?? ''),
    'main barrel should fail with a cloudflare: scheme resolution error',
  );
});
