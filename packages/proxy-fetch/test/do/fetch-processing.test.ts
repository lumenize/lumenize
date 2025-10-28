/**
 * Integration Tests: ProxyFetchDO Fetch Processing (Low-Level)
 * 
 * These are INTEGRATION tests that verify the complete fetch processing flow:
 * - Manually construct ProxyFetchQueueMessage objects
 * - Enqueue them via proxyStub.enqueue()
 * - Wait for async processing (alarm triggers, fetches execute, callbacks deliver)
 * - Verify results via testStub.getResult()
 * 
 * This tests the low-level message processing without using @lumenize/testing helpers.
 * Uses raw DO stubs obtained from env.PROXY_FETCH_DO.get() and env.TEST_DO.get().
 * 
 * For higher-level integration tests using @lumenize/testing, see integration.test.ts.
 * For unit tests of just the enqueue method, see unit-queue.test.ts.
 */
import { describe, test, expect, beforeEach } from 'vitest';
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
    TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN);

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
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify callback was delivered
    const result = await testStub.getResult('success-req-1');
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.item.reqId).toBe('success-req-1');
    expect(result.item.response).toBeDefined();
  }, 10000);

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
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify error callback was delivered
    const result = await testStub.getResult('error-req-1');
    expect(result).toBeDefined();
    expect(result.success).toBe(false);
    expect(result.item.reqId).toBe('error-req-1');
    expect(result.item.error).toBeDefined();
  }, 10000);

  test('retries failed requests with exponential backoff', async () => {
    const request = TEST_ENDPOINTS.createRequest('/status/500', { method: 'GET' });
    const serializedRequest = await serializeWebApiObject(request);
    
    const message: ProxyFetchQueueMessage = {
      reqId: 'retry-req-1',
      request: serializedRequest,
      doBindingName: 'TEST_DO',
      instanceId: testId,
      handlerName: 'handleError',
      retryCount: 0,
      options: {
        maxRetries: 2,
        retryDelay: 100,
        retryOn5xx: true,
      },
      timestamp: Date.now(),
    };

    await proxyStub.enqueue(message);

    // Wait for retries and callback
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verify callback was eventually delivered after retries
    const result = await testStub.getResult('retry-req-1');
    expect(result).toBeDefined();
    expect(result.item.reqId).toBe('retry-req-1');
    // Should have retried 2 times (initial + 2 retries = 3 attempts)
    expect(result.item.retryCount).toBeGreaterThan(0);
  }, 10000);

  test('fire-and-forget requests skip callback', async () => {
    const request = TEST_ENDPOINTS.createRequest('/uuid', { method: 'GET' });
    const serializedRequest = await serializeWebApiObject(request);
    
    const message: ProxyFetchQueueMessage = {
      reqId: 'fire-and-forget-1',
      request: serializedRequest,
      doBindingName: 'TEST_DO',
      instanceId: testId,
      // No handlerName - fire and forget
      retryCount: 0,
      timestamp: Date.now(),
    };

    await proxyStub.enqueue(message);

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify no callback was delivered
    const result = await testStub.getResult('fire-and-forget-1');
    expect(result).toBeUndefined();
  }, 10000);

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
      await new Promise(resolve => setTimeout(resolve, 2));
    }

    // Wait for all to process
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verify all callbacks were delivered
    const result1 = await testStub.getResult('concurrent-1');
    const result2 = await testStub.getResult('concurrent-2');
    const result3 = await testStub.getResult('concurrent-3');

    expect(result1).toBeDefined();
    expect(result2).toBeDefined();
    expect(result3).toBeDefined();
    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(result3.success).toBe(true);
  }, 15000);
});
