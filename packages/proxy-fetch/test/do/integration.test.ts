/**
 * Integration Tests: ProxyFetch() Complete Flow (User-Facing API)
 * 
 * These are TRUE INTEGRATION tests using the user-facing API (proxyFetch()).
 * They verify:
 * - Auto-detection logic picks DO variant (not Queue) in this environment
 * - Origin DO calls proxyFetch() helper function
 * - ProxyFetchDO processes the fetch
 * - Response is delivered back to origin DO via RPC callback
 * 
 * Uses createTestingClient from @lumenize/testing for clean test setup.
 * Tests call the same API that users will call in production.
 * 
 * For low-level internal tests, see fetch-processing.test.ts and unit-queue.test.ts.
 */
import { describe, test, expect, vi } from 'vitest';
import { createTestingClient } from '@lumenize/testing';
import { _TestDO } from './test-worker';
// @ts-expect-error - cloudflare:test types not available at compile time
import { env } from 'cloudflare:test';
import { createTestEndpoints } from '@lumenize/test-endpoints';

// Instance name for this test suite
const INSTANCE_NAME = 'integration-test';

// Create test endpoints client for this suite
const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, INSTANCE_NAME);

describe('ProxyFetch Integration (DO Variant)', () => {
  test('full flow: origin DO calls proxyFetch(), gets callback', async () => {
    // Create testing client for origin DO
    const originInstanceId = 'integration-test-1';
    using originClient = createTestingClient<typeof _TestDO>(
      'TEST_DO',
      originInstanceId
    );

    // Call the user-facing API - proxyFetch() auto-detects DO variant
    const reqId = await originClient.myBusinessProcess(
      TEST_ENDPOINTS.buildUrl('/uuid'),
      'handleSuccess'
    );

    expect(reqId).toBeDefined();
    expect(typeof reqId).toBe('string');

    // Wait for the request to be processed and callback delivered
    await vi.waitFor(async () => {
      const result = await originClient.getResult(reqId);
      expect(result).toBeDefined();
    }, { timeout: 5000 });

    // Verify the callback was delivered with success
    const result = await originClient.getResult(reqId);
    expect(result.success).toBe(true);
    expect(result.item.reqId).toBe(reqId);
    expect(result.item.response).toBeDefined();
  });

  test('error handling: invalid URL triggers error callback', async () => {
    const originInstanceId = 'integration-test-error';
    using originClient = createTestingClient<typeof _TestDO>(
      'TEST_DO',
      originInstanceId
    );

    const reqId = await originClient.myBusinessProcess(
      'https://invalid-domain-that-will-fail.invalid/',
      'handleError'
    );

    // Wait for error callback
    await vi.waitFor(async () => {
      const result = await originClient.getResult(reqId);
      expect(result).toBeDefined();
    }, { timeout: 5000 });

    const result = await originClient.getResult(reqId);
    expect(result.success).toBe(false);
    expect(result.item.error).toBeDefined();
  });

  test('fire-and-forget: no handler, no callback', async () => {
    const originInstanceId = 'fire-and-forget-do';
    using originClient = createTestingClient<typeof _TestDO>(
      'TEST_DO',
      originInstanceId
    );

    // Call without handler - fire and forget
    const reqId = await originClient.myBusinessProcess(
      `${env.TEST_ENDPOINTS_URL}/uuid?token=${env.TEST_TOKEN}`
      // No handler - fire and forget
    );

    expect(reqId).toBeDefined();

    // Wait a bit for processing to complete (should not throw)
    await vi.waitFor(async () => {
      // Just wait for some time to ensure fetch completes
      await new Promise(resolve => setTimeout(resolve, 100));
    }, { timeout: 500 });

    // Verify no callback was delivered (fire-and-forget)
    const result = await originClient.getResult(reqId);
    expect(result).toBeUndefined();
  });

  test('retries: 5xx error triggers retry logic', async () => {
    const originInstanceId = 'integration-test-retry';
    using originClient = createTestingClient<typeof _TestDO>(
      'TEST_DO',
      originInstanceId
    );

    const reqId = await originClient.myBusinessProcess(
      TEST_ENDPOINTS.buildUrl('/status/500'),
      'handleError',
      { maxRetries: 2, retryDelay: 100, retryOn5xx: true }
    );

    // Wait for retries to complete
    await vi.waitFor(async () => {
      const result = await originClient.getResult(reqId);
      expect(result).toBeDefined();
    }, { timeout: 8000 });

    const result = await originClient.getResult(reqId);
    // Should get the 500 response after retries
    expect(result.item.response).toBeDefined();
    expect(result.item.response.status).toBe(500);
    expect(result.item.retryCount).toBeGreaterThan(0);
  });

  test('parallel requests: multiple requests process concurrently', async () => {
    const originInstanceId = 'integration-test-parallel';
    using originClient = createTestingClient<typeof _TestDO>(
      'TEST_DO',
      originInstanceId
    );
    
    // Fire off 3 requests in parallel using the user-facing API
    const reqIds = await Promise.all([
      originClient.myBusinessProcess(TEST_ENDPOINTS.buildUrl('/uuid'), 'handleSuccess'),
      originClient.myBusinessProcess(TEST_ENDPOINTS.buildUrl('/json'), 'handleSuccess'),
      originClient.myBusinessProcess(TEST_ENDPOINTS.buildUrl('/uuid'), 'handleSuccess'),
    ]);

    expect(reqIds).toHaveLength(3);
    expect(reqIds.every((id: string) => typeof id === 'string')).toBe(true);

    // Wait for all to complete
    await vi.waitFor(async () => {
      const results = await Promise.all(
        reqIds.map((id: string) => originClient.getResult(id))
      );
      expect(results.every((r: any) => r !== null && r !== undefined)).toBe(true);
    }, { timeout: 8000 });

    // Verify all succeeded
    const results = await Promise.all(
      reqIds.map((id: string) => originClient.getResult(id))
    );
    expect(results.every((r: any) => r.success === true)).toBe(true);
  });
});
