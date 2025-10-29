/**
 * Integration Tests: ProxyFetchDO Fetch Processing (Low-Level)
 * 
 * These are INTEGRATION tests that verify the complete fetch processing flow:
 * - Manually construct ProxyFetchQueueMessage objects
 * - Enqueue them via proxyStub.enqueue()
 * - Wait for async processing (fetches execute, callbacks deliver)
 * - Verify results via testStub.getResult()
 * 
 * This tests the low-level message processing without using @lumenize/testing helpers.
 * Uses raw DO stubs obtained from env.PROXY_FETCH_DO.get() and env.TEST_DO.get().
 * 
 * For RPC-based tests using @lumenize/testing, see rpc-based.test.ts.
 * For higher-level integration tests using @lumenize/testing, see integration.test.ts.
 * For unit tests of just the enqueue method, see unit-queue.test.ts.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error
import { env } from 'cloudflare:test';
import { serializeWebApiObject } from '@lumenize/utils';
import { createTestEndpoints } from '@lumenize/test-endpoints/src/client';
import type { ProxyFetchQueueMessage } from '../../src/types';

describe('ProxyFetchDO Fetch Processing', () => {
  let proxyStub: any; // Instrumented DO stub has RPC methods added dynamically
  let testStub: any; // Instrumented DO stub has RPC methods added dynamically
  let testId: string;
  let TEST_ENDPOINTS: ReturnType<typeof createTestEndpoints>;

  beforeEach(async () => {
    const proxyId = env.PROXY_FETCH_DO.idFromName('fetch-processing-test');
    proxyStub = env.PROXY_FETCH_DO.get(proxyId);

    const testDoId = env.TEST_DO.idFromName('test-receiver');
    testStub = env.TEST_DO.get(testDoId);
    testId = testDoId.toString();

    // Create test endpoints client with token from env
    TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL);

    // Reset test DO state
    await testStub.reset();
  });

  test('successful fetch delivers callback to origin DO', async () => {
    const request = TEST_ENDPOINTS.createRequest('/uuid', { method: 'GET' });
    const serializedRequest = await serializeWebApiObject(request);
    
    const message: ProxyFetchQueueMessage = {
      reqId: 'success-req-1',
      request: serializedRequest,
      doBindingName: 'TEST_DO',
      instanceId: testId,
      handlerName: 'handleSuccess',
      retryCount: 0,
      timestamp: Date.now(),
    };

    await proxyStub.enqueue(message);

    // Wait for processing and callback
    await vi.waitFor(async () => {
      const result = await testStub.getResult('success-req-1');
      expect(result).toBeDefined();
    }, { timeout: 3000 });

    // Verify callback was delivered
    const result = await testStub.getResult('success-req-1');
    expect(result.success).toBe(true);
    expect(result.item.reqId).toBe('success-req-1');
    expect(result.item.response).toBeDefined();
  });

  test('fetch error delivers error callback to origin DO', async () => {
    const request = new Request('https://invalid-domain-that-will-fail.invalid', { method: 'GET' });
    const serializedRequest = await serializeWebApiObject(request);
    
    const message: ProxyFetchQueueMessage = {
      reqId: 'error-req-1',
      request: serializedRequest,
      doBindingName: 'TEST_DO',
      instanceId: testId,
      handlerName: 'handleError',
      retryCount: 0,
      options: {
        maxRetries: 0, // No retries for this test
        timeout: 5000,
      },
      timestamp: Date.now(),
    };

    await proxyStub.enqueue(message);

    // Wait for processing and callback
    await vi.waitFor(async () => {
      const result = await testStub.getResult('error-req-1');
      expect(result).toBeDefined();
    }, { timeout: 3000 });

    // Verify error callback was delivered
    const result = await testStub.getResult('error-req-1');
    expect(result.success).toBe(false);
    expect(result.item.reqId).toBe('error-req-1');
    expect(result.item.error).toBeDefined();
  });

  test('multiple concurrent requests process in parallel', async () => {
    const messages: ProxyFetchQueueMessage[] = await Promise.all([
      (async () => {
        const req = TEST_ENDPOINTS.createRequest('/uuid', { method: 'GET' });
        return {
          reqId: 'concurrent-1',
          request: await serializeWebApiObject(req),
          doBindingName: 'TEST_DO',
          instanceId: testId,
          handlerName: 'handleSuccess',
          retryCount: 0,
          timestamp: Date.now(),
        };
      })(),
      (async () => {
        const req = TEST_ENDPOINTS.createRequest('/json', { method: 'GET' });
        return {
          reqId: 'concurrent-2',
          request: await serializeWebApiObject(req),
          doBindingName: 'TEST_DO',
          instanceId: testId,
          handlerName: 'handleSuccess',
          retryCount: 0,
          timestamp: Date.now(),
        };
      })(),
      (async () => {
        const req = TEST_ENDPOINTS.createRequest('/uuid', { method: 'GET' });
        return {
          reqId: 'concurrent-3',
          request: await serializeWebApiObject(req),
          doBindingName: 'TEST_DO',
          instanceId: testId,
          handlerName: 'handleSuccess',
          retryCount: 0,
          timestamp: Date.now(),
        };
      })(),
    ]);

    // Enqueue all requests
    for (const msg of messages) {
      await proxyStub.enqueue(msg);
    }

    // Wait for all to process
    await vi.waitFor(async () => {
      const result1 = await testStub.getResult('concurrent-1');
      const result2 = await testStub.getResult('concurrent-2');
      const result3 = await testStub.getResult('concurrent-3');
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      expect(result3).toBeDefined();
    }, { timeout: 3000 });

    // Verify all callbacks were delivered
    const result1 = await testStub.getResult('concurrent-1');
    const result2 = await testStub.getResult('concurrent-2');
    const result3 = await testStub.getResult('concurrent-3');

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(result3.success).toBe(true);
  });
});
