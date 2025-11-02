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
 * 
 * NOTE: These tests run SEQUENTIALLY because they all share the same 
 * 'proxy-fetch-global' DO instance (by design) and inspect its internal state.
 */
import { test, expect, vi, describe } from 'vitest';
// @ts-expect-error
import { env } from 'cloudflare:test';
import { createTestingClient } from '@lumenize/testing';
import { createTestEndpoints } from '@lumenize/test-endpoints';
import type { _ProxyFetchDO, _TestDO } from './test-worker';

describe.sequential('RPC-Based ProxyFetch Tests', () => {
  test('demonstrates RPC access to ProxyFetchDO internals', async () => {
  // 1. Setup: Create RPC clients for both DOs
  // CRITICAL: Use 'proxy-fetch-global' to match the named instance used by proxyFetch()
  using proxyClient = createTestingClient<typeof _ProxyFetchDO>(
    'PROXY_FETCH_DO',
    'proxy-fetch-global'  // Must match the instance name in proxyFetch.ts!
  );
  const userInstanceId = 'rpc-test-user';
  using userClient = createTestingClient<typeof _TestDO>(
    'TEST_DO', 
    userInstanceId
  );

  // Create test endpoints client isolated to this test
  const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, userInstanceId);

  // 2. Act: User calls proxyFetch with a fast endpoint with 50ms delay
  const reqId = await userClient.myBusinessProcess(
    TEST_ENDPOINTS.buildUrl('/delay/50'),
    'handleSuccess'
  );
  
  expect(reqId).toBeDefined();

  // 3. Verify: Item should be in-flight immediately (no alarm wait needed)
  // @ts-expect-error - toArray() exists at runtime but not in types
  const inFlight = await proxyClient.ctx.storage.kv.list({ prefix: 'reqs-in-flight:' }).toArray();
  expect(inFlight.length).toBe(1);
  const [key, value] = inFlight[0];
  expect(value.reqId).toBe(reqId);
  
  // 4. Wait for fetch to complete and callback to be delivered
  await vi.waitFor(async () => {
    const result = await userClient.getResult(reqId);
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
  });
  
  // 5. Verify: Storage should be cleaned up after processing
  // @ts-expect-error - toArray() exists at runtime but not in types
  const afterProcessing = await proxyClient.ctx.storage.kv.list().toArray();
  expect(afterProcessing.length).toBe(0);
});

  test('handles multiple concurrent requests (batching)', async () => {
  using proxyClient = createTestingClient<typeof _ProxyFetchDO>(
    'PROXY_FETCH_DO',
    'proxy-fetch-global'
  );
  const userInstanceId = 'rpc-test-batch';
  using userClient = createTestingClient<typeof _TestDO>(
    'TEST_DO', 
    userInstanceId
  );

  // Create test endpoints client isolated to this test
  const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, userInstanceId);

  // Enqueue 5 requests - thenable Proxies batch on client side until awaited
  const calls = [];
  for (let i = 0; i < 5; i++) {
    calls.push(
      userClient.myBusinessProcess(
        TEST_ENDPOINTS.buildUrl('/delay/50'),
        'handleSuccess'
      )
    );
  }
  
  // Awaiting triggers RPC client to send all queued calls in one batch
  // The "client" here is our test code, not the DO - calls queue up here until we await
  await calls[0];
  const reqIds = await Promise.all(calls);
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

  test('retries failed requests with exponential backoff', async () => {
  using proxyClient = createTestingClient<typeof _ProxyFetchDO>(
    'PROXY_FETCH_DO',
    'proxy-fetch-global'
  );
  const userInstanceId = 'rpc-test-retry';
  using userClient = createTestingClient<typeof _TestDO>(
    'TEST_DO',
    userInstanceId
  );

  // Create test endpoints client isolated to this test
  const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, userInstanceId);

  // Request to endpoint that returns 500 error - should retry
  const reqId = await userClient.myBusinessProcess(
    TEST_ENDPOINTS.buildUrl('/status/500'),
    'handleError',
    {
      maxRetries: 2,
      retryDelay: 100,
      retryOn5xx: true,
    }
  );

  // Wait for retries to complete and callback to be delivered
  await vi.waitFor(async () => {
    const result = await userClient.getResult(reqId);
    expect(result).toBeDefined();
    expect(result.success).toBe(false);
    expect(result.item.retryCount).toBeGreaterThan(0);
  }, { timeout: 2000 });

  // Verify storage cleaned up
  // @ts-expect-error - toArray() exists at runtime but not in types
  const storage = await proxyClient.ctx.storage.kv.list().toArray();
  expect(storage).toHaveLength(0);
});

  test('fire-and-forget requests skip callback', async () => {
  using proxyClient = createTestingClient<typeof _ProxyFetchDO>(
    'PROXY_FETCH_DO',
    'proxy-fetch-global'
  );
  const userInstanceId = 'rpc-test-fire-forget';
  using userClient = createTestingClient<typeof _TestDO>(
    'TEST_DO',
    userInstanceId
  );

  // Create test endpoints client isolated to this test
  const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, userInstanceId);

  // Request without handler - fire and forget
  const reqId = await userClient.myBusinessProcess(
    TEST_ENDPOINTS.buildUrl('/uuid'),
    undefined  // No handler
  );

  expect(reqId).toBeDefined();

  // Wait for fetch to complete
  await vi.waitFor(async () => {
    // @ts-expect-error - toArray() exists at runtime but not in types
    const storage = await proxyClient.ctx.storage.kv.list().toArray();
    expect(storage).toHaveLength(0);
  }, { timeout: 500 });

    // Verify no callback was delivered (no result stored)
    const result = await userClient.getResult(reqId);
    expect(result).toBeUndefined();
  });
});