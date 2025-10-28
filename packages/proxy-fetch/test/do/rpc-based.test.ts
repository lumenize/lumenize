/**
 * RPC-Based Integration Tests: ProxyFetch with @lumenize/testing
 * 
 * These tests use createTestingClient to get direct RPC access to DO internals:
 * - Inspect storage state at any point
 * - Manipulate alarm state to control processing timing
 * - Call instance methods directly
 * - Verify internal queue state via SQL queries
 * 
 * This provides faster, more precise tests than setTimeout-based waiting.
 */
import { test, expect, vi } from 'vitest';
// @ts-expect-error
import { env } from 'cloudflare:test';
import { createTestingClient } from '@lumenize/testing';
import type { _ProxyFetchDO, _TestDO } from './test-worker';

it('demonstrates RPC access to ProxyFetchDO internals', async () => {
  // 1. Setup: Create RPC clients for both DOs
  // CRITICAL: Use 'proxy-fetch-global' to match the named instance used by proxyFetch()
  using proxyClient = createTestingClient<typeof _ProxyFetchDO>(
    'PROXY_FETCH_DO',
    'proxy-fetch-global'  // Must match the instance name in proxyFetch.ts!
  );
  using userClient = createTestingClient<typeof _TestDO>(
    'TEST_DO', 
    'rpc-test-user'
  );

  // 2. Act: User calls proxyFetch with a fast endpoint with 50ms delay
  const reqId = await userClient.myBusinessProcess(
    `${env.TEST_ENDPOINTS_URL}/delay/50?token=${env.TEST_TOKEN}`,
    'handleSuccess'
  );
  
  expect(reqId).toBeDefined();

  // 3. Verify: Item should be in-flight immediately (no alarm wait needed)
  // @ts-expect-error - toArray() exists at runtime but not in types
  const inFlight = await proxyClient.ctx.storage.kv.list({ prefix: 'reqs-in-flight:' }).toArray();
  expect(inFlight.length).toBe(1);
  const [key, value] = inFlight[0];
  expect(value.reqId).toBe(reqId);
  console.log('Found in-flight item:', key);
  
  // 4. Wait for fetch to complete and callback to be delivered
  await vi.waitFor(async () => {
    const result = await userClient.getResult(reqId);
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
  }, { timeout: 500 }); // Generous timeout for 50ms delay + network overhead
  
  // 5. Verify: Storage should be cleaned up after processing
  // @ts-expect-error - toArray() exists at runtime but not in types
  const afterProcessing = await proxyClient.ctx.storage.kv.list().toArray();
  expect(afterProcessing.length).toBe(0);
});

it('handles multiple concurrent requests (batching)', async () => {
  using proxyClient = createTestingClient<typeof _ProxyFetchDO>(
    'PROXY_FETCH_DO',
    'proxy-fetch-global'
  );
  using userClient = createTestingClient<typeof _TestDO>(
    'TEST_DO', 
    'rpc-test-batch'
  );

  // Enqueue 5 requests - don't await individually, let RPC batch them
  // These are thenable Proxy objects, not actual Promises
  const call1 = userClient.myBusinessProcess(
    `${env.TEST_ENDPOINTS_URL}/delay/50?token=${env.TEST_TOKEN}`,
    'handleSuccess'
  );
  const call2 = userClient.myBusinessProcess(
    `${env.TEST_ENDPOINTS_URL}/delay/50?token=${env.TEST_TOKEN}`,
    'handleSuccess'
  );
  const call3 = userClient.myBusinessProcess(
    `${env.TEST_ENDPOINTS_URL}/delay/50?token=${env.TEST_TOKEN}`,
    'handleSuccess'
  );
  const call4 = userClient.myBusinessProcess(
    `${env.TEST_ENDPOINTS_URL}/delay/50?token=${env.TEST_TOKEN}`,
    'handleSuccess'
  );
  const call5 = userClient.myBusinessProcess(
    `${env.TEST_ENDPOINTS_URL}/delay/50?token=${env.TEST_TOKEN}`,
    'handleSuccess'
  );
  
  // Awaiting triggers RPC client to send all queued calls in one batch
  // The "client" here is our test code, not the DO - calls queue up here until we await
  await call5;
  const reqIds = [await call1, await call2, await call3, await call4, await call5];
  expect(reqIds).toHaveLength(5);

  // Assert: All 5 should be in-flight (DO input gate serializes them)
  // @ts-expect-error - toArray() exists at runtime but not in types
  const storage = await proxyClient.ctx.storage.kv.list().toArray();
  expect(storage).toHaveLength(5);
  
  // All should have in-flight prefix (none queued)
  // @ts-expect-error - tuple types
  const keys = storage.map(([key]) => key);
  keys.forEach((key: string) => {
    expect(key).toMatch(/^reqs-in-flight:/);
  });

  // Wait for all fetches to complete
  await vi.waitFor(async () => {
    // @ts-expect-error - toArray() exists at runtime but not in types
    const afterStorage = await proxyClient.ctx.storage.kv.list().toArray();
    expect(afterStorage).toHaveLength(0);
  }, { timeout: 1000 });

  // Verify all callbacks were delivered successfully
  for (const reqId of reqIds) {
    const result = await userClient.getResult(reqId);
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.item.response.status).toBe(200);
  }
});

it('handles large batches of requests', async () => {
  using proxyClient = createTestingClient<typeof _ProxyFetchDO>(
    'PROXY_FETCH_DO',
    'proxy-fetch-global'
  );
  using userClient = createTestingClient<typeof _TestDO>(
    'TEST_DO', 
    'rpc-test-large-batch'
  );

  // Test with 1000 requests
  const batchSize = 1000;
  console.log(`Testing batch of ${batchSize} requests...`);
  
  const calls = [];
  for (let i = 0; i < batchSize; i++) {
    calls.push(
      userClient.myBusinessProcess(
        `${env.TEST_ENDPOINTS_URL}/delay/50?token=${env.TEST_TOKEN}`,
        'handleSuccess'
      )
    );
  }
  
  // Await first call to trigger batch
  await calls[0];
  const reqIds = await Promise.all(calls);
  expect(reqIds).toHaveLength(batchSize);

  console.log(`All ${batchSize} requests enqueued, checking storage...`);
  
  // All should be in-flight
  // @ts-expect-error - toArray() exists at runtime but not in types
  const storage = await proxyClient.ctx.storage.kv.list().toArray();
  console.log(`Storage contains ${storage.length} items`);
  expect(storage).toHaveLength(batchSize);

  // Wait for all to complete
  await vi.waitFor(async () => {
    // @ts-expect-error - toArray() exists at runtime but not in types
    const afterStorage = await proxyClient.ctx.storage.kv.list().toArray();
    expect(afterStorage).toHaveLength(0);
  }, { timeout: 5000 });

  console.log(`All ${batchSize} requests completed and cleaned up`);
});