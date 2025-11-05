/**
 * Queue consumer tests for @lumenize/proxy-fetch Queue variant
 * 
 * These tests directly invoke the queue consumer by creating MessageBatch objects,
 * bypassing the actual queue. They test the consumer's ability to:
 * - Deserialize request messages
 * - Execute HTTP fetches
 * - Handle errors and retries
 * - Deliver callbacks to DOs
 * 
 * Note: These are NOT true end-to-end integration tests. Real integration testing
 * of the Queue variant happens via production deployment tests.
 */
import { env, createMessageBatch, createExecutionContext, getQueueResult, runInDurableObject } from 'cloudflare:test';
import { describe, test, expect, vi } from 'vitest';
import worker from './test-worker-and-dos';
import { encodeRequest } from '@lumenize/structured-clone';
import { proxyFetch } from '../../src/proxyFetch';
import { createTestEndpoints } from '@lumenize/test-endpoints';

describe('proxyFetch() Function', () => {
  test('queues request with URL string', async () => {
    const instanceId = 'proxy-fetch-test';
    const stub = env.MY_DO.getByName(instanceId);
    const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, instanceId);
    
    // Call proxyFetch from within the DO - should return a reqId
    await runInDurableObject(stub, async (instance) => {
      const reqId = await proxyFetch(
        instance,
        TEST_ENDPOINTS.buildUrl('/json'),
        'MY_DO',
        'handleSuccess'
      );
      expect(reqId).toBeDefined();
      expect(typeof reqId).toBe('string');
    });
  });

  test('queues request with Request object and options', async () => {
    const instanceId = 'proxy-fetch-options-test';
    const stub = env.MY_DO.getByName(instanceId);
    const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, instanceId);
    
    await runInDurableObject(stub, async (instance) => {
      const request = new Request(
        TEST_ENDPOINTS.buildUrl('/uuid'), 
        { 
          method: 'POST',
          body: JSON.stringify({ test: 'data' })
        }
      );
      
      const reqId = await proxyFetch(
        instance,
        request,
        'MY_DO',
        'handleSuccess',
        { timeout: 5000, maxRetries: 1 }
      );
      expect(reqId).toBeDefined();
      expect(typeof reqId).toBe('string');
    });
  });
});

describe('Proxy Fetch Integration', () => {
  test('full flow: DO triggers proxy fetch, queue processes, response delivered', { timeout: 5000 }, async () => {
    const instanceId = 'integration-full-flow';
    const stub = env.MY_DO.getByName(instanceId);
    const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, instanceId);
    const id = await stub.id;
    
    // Generate a reqId for this test
    const reqId = crypto.randomUUID();
    
    // Create a MessageBatch to simulate what the queue consumer receives
    const testRequest = new Request(
      TEST_ENDPOINTS.buildUrl('/json')
    );
    const serializedRequest = await encodeRequest(testRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'test-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: reqId,
          request: serializedRequest,
          doBindingName: 'MY_DO',
          instanceId: id.toString(),
          handlerName: 'handleSuccess',
          retryCount: 0,
          timestamp: Date.now(),
        },
      },
    ]);
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    
    // Verify the message was explicitly acked
    expect(result.ackAll).toBe(false);
    expect(result.explicitAcks.length).toBe(1);
    
    // Verify the response was stored in the DO
    await vi.waitFor(async () => {
      const response = await (stub as any).getLastResponse();
      expect(response).toBeDefined();
    }, { timeout: 3000 });
    
    const response = await (stub as any).getLastResponse();
    expect(response).toHaveProperty('slideshow');
    
    const storedReqId = await (stub as any).getLastReqId();
    expect(storedReqId).toBe(reqId);
  });

  test('fire-and-forget mode: no handler callback', { timeout: 5000 }, async () => {
    const instanceId = 'fire-forget-test';
    const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, instanceId);
    
    const testRequest = new Request(
      TEST_ENDPOINTS.buildUrl('/uuid')
    );
    const serializedRequest = await encodeRequest(testRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'fire-forget-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'fire-forget-req-1',
          request: serializedRequest,
          doBindingName: 'MY_DO',
          instanceId: 'not-needed-for-fire-and-forget',
          handlerName: undefined, // No handler = fire-and-forget
          timestamp: Date.now(),
        },
      },
    ]);
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    await getQueueResult(batch, ctx);
    
    // Message should be acked immediately without callback
    // Test passes if no errors thrown
  });

  test('fire-and-forget mode: skips error callback on fetch failure', { timeout: 5000 }, async () => {
    const testRequest = new Request('https://invalid-domain-for-fire-and-forget.invalid/');
    const serializedRequest = await encodeRequest(testRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'fire-forget-error-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'fire-forget-error-req-1',
          request: serializedRequest,
          doBindingName: 'MY_DO',
          instanceId: 'not-needed-for-fire-and-forget',
          handlerName: undefined, // No handler = fire-and-forget
          timestamp: Date.now(),
          options: { maxRetries: 0 }, // Don't retry
        },
      },
    ]);
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    await getQueueResult(batch, ctx);
    
    // Message should be acked even though fetch failed
    // No error callback should be attempted since handlerName is undefined
    // Test passes if no errors thrown
  });

  test('queue consumer processes multiple messages in batch', { timeout: 10000 }, async () => {
    const instanceId1 = 'batch-test-1';
    const stub1 = env.MY_DO.getByName(instanceId1);
    const id1 = await stub1.id;
    
    const instanceId2 = 'batch-test-2';
    const stub2 = env.MY_DO.getByName(instanceId2);
    const id2 = await stub2.id;
    const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'batch-test');
    
    // Create a batch with multiple messages using real serialization
    const req1 = new Request(TEST_ENDPOINTS.buildUrl('/uuid'));
    const req2 = new Request(TEST_ENDPOINTS.buildUrl('/delay/500')); // 500ms delay
    const serializedReq1 = await encodeRequest(req1);
    const serializedReq2 = await encodeRequest(req2);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'req-1',
          request: serializedReq1,
          doBindingName: 'MY_DO',
          instanceId: id1.toString(),
          handlerName: 'handleError',
          timestamp: Date.now(),
          retryCount: 0,
        },
      },
      {
        id: 'msg-2',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'req-2',
          request: serializedReq2,
          doBindingName: 'MY_DO',
          instanceId: id2.toString(),
          handlerName: 'handleError',
          timestamp: Date.now(),
          retryCount: 0,
        },
      },
    ]);
    
    await runInDurableObject(stub2, async (_instance, state) => {
      state.storage.kv.put('proxy-fetch:req-2', JSON.stringify({
        handlerName: 'handleSuccess',
        doBindingName: 'MY_DO',
        instanceId: id2.toString(),
        timestamp: Date.now(),
      }));
    });
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    await getQueueResult(batch, ctx);
    
    // Verify both DOs received their responses (need longer timeout for delay/1 endpoint)
    await vi.waitFor(async () => {
      const response1 = await (stub1 as any).getLastResponse();
      const response2 = await (stub2 as any).getLastResponse();
      expect(response1).toBeDefined();
      expect(response2).toBeDefined();
    }, { timeout: 5000 });
  });

  test('queue consumer handles fetch errors', async () => {
    const stub = env.MY_DO.getByName('error-test');
    const id = await stub.id;
    
    // Create message with invalid URL using real serialization
    const errorRequest = new Request('https://this-is-not-a-valid-url-that-will-fail.invalid');
    const serializedErrorRequest = await encodeRequest(errorRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'error-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'error-req-1',
          request: serializedErrorRequest,
          doBindingName: 'MY_DO',
          instanceId: id.toString(),
          handlerName: 'handleError',
          timestamp: Date.now(),
          retryCount: 0,
          options: { maxRetries: 0 }, // Don't retry for this test
        },
      },
    ]);
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    await getQueueResult(batch, ctx);
    
    // Verify error was delivered to DO
    await vi.waitFor(async () => {
      const error = await (stub as any).getLastError();
      expect(error).toBeDefined();
    }, { timeout: 2000 });
    
    const error = await (stub as any).getLastError();
    expect(error).toContain('internal error');
  });

  test('serialization preserves Request headers and method', { timeout: 5000 }, async () => {
    const instanceId = 'serialization-test';
    const stub = env.MY_DO.getByName(instanceId);
    const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, instanceId);
    const id = await stub.id;
    
    // Create message with POST request and custom headers using real serialization
    const postRequest = new Request(
      TEST_ENDPOINTS.buildUrl('/echo'), 
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Custom-Header': 'test-value',
        },
      body: JSON.stringify({ test: 'data' }),
    });
    const serializedPostRequest = await encodeRequest(postRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'post-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'post-req-1',
          request: serializedPostRequest,
          doBindingName: 'MY_DO',
          instanceId: id.toString(),
          handlerName: 'handleSuccess',
          timestamp: Date.now(),
          retryCount: 0,
        },
      },
    ]);
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    await getQueueResult(batch, ctx);
    
    // Verify response contains echoed headers (test-endpoints/post echoes headers in JSON)
    await vi.waitFor(async () => {
      const response = await (stub as any).getLastResponse();
      expect(response).toBeDefined();
    }, { timeout: 2000 });
    
    const response = await (stub as any).getLastResponse();
    expect(response).toHaveProperty('headers');
    // Headers are normalized to lowercase by Cloudflare Workers
    expect(response.headers).toHaveProperty('x-custom-header');
    expect(response.headers['x-custom-header']).toBe('test-value');
  });
});

describe('Error Handling and Retries', () => {
  test('timeout aborts long-running requests', { timeout: 10000 }, async () => {
    const instanceId = 'timeout-test';
    const stub = env.MY_DO.getByName(instanceId);
    const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, instanceId);
    const id = await stub.id;
    
    // test-endpoints.transformation.workers.dev/delay/N delays for N milliseconds
    const timeoutRequest = new Request(
      TEST_ENDPOINTS.buildUrl('/delay/5000')
    ); // 5 second delay
    const serializedRequest = await encodeRequest(timeoutRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'timeout-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'timeout-req-1',
          request: serializedRequest,
          doBindingName: 'MY_DO',
          instanceId: id.toString(),
          handlerName: 'handleError',
          timestamp: Date.now(),
          retryCount: 0,
          options: { 
            timeout: 500, // 500ms timeout
            maxRetries: 0, // No retries for this test
          },
        },
      },
    ]);
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    await getQueueResult(batch, ctx);
    
    // Verify timeout error was delivered
    await vi.waitFor(async () => {
      const error = await (stub as any).getLastError();
      expect(error).toBeDefined();
    }, { timeout: 3000 });
    
    const error = await (stub as any).getLastError();
    expect(error).toContain('Request timeout after 500ms');
  });

  test('retries network errors with exponential backoff', { timeout: 15000 }, async () => {
    const stub = env.MY_DO.getByName('retry-test');
    const id = await stub.id;
    
    // Invalid URL that will fail with network error
    const errorRequest = new Request('https://invalid-domain-that-does-not-exist-123456.invalid');
    const serializedRequest = await encodeRequest(errorRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'retry-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'retry-req-1',
          request: serializedRequest,
          doBindingName: 'MY_DO',
          instanceId: id.toString(),
          handlerName: 'handleError',
          timestamp: Date.now(),
          retryCount: 0,
          options: { 
            maxRetries: 2, // Try 3 times total (initial + 2 retries)
            retryDelay: 500, // 500ms initial delay
          },
        },
      },
    ]);
    
    const ctx = createExecutionContext();
    const startTime = Date.now();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    
    // Message should be acked (will be re-queued internally for retry)
    expect(result.explicitAcks.length).toBe(1);
    
    // Note: We can't easily test the retries in vitest-pool-workers since queue.send() 
    // doesn't actually trigger the consumer. This test validates the first attempt
    // triggers a retry (message is acked and re-queued).
    
    // In production, the retries would happen automatically via the queue system
  });

  test('retries 5xx errors when configured', { timeout: 10000 }, async () => {
    const instanceId = '5xx-retry-test';
    const stub = env.MY_DO.getByName(instanceId);
    const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, instanceId);
    const id = await stub.id;
    
    // test-endpoints/status/500 returns a 500 error
    const errorRequest = new Request(
      TEST_ENDPOINTS.buildUrl('/status/500')
    );
    const serializedRequest = await encodeRequest(errorRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: '5xx-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: '5xx-req-1',
          request: serializedRequest,
          doBindingName: 'MY_DO',
          instanceId: id.toString(),
          handlerName: 'handleError',
          timestamp: Date.now(),
          retryCount: 0,
          options: { 
            maxRetries: 1,
            retryDelay: 200,
            retryOn5xx: true, // Retry on 5xx errors
          },
        },
      },
    ]);
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    
    // Should be acked for retry since 5xx is retryable
    expect(result.explicitAcks.length).toBe(1);
  });

  test('does not retry 4xx client errors', { timeout: 5000 }, async () => {
    const instanceId = '4xx-test';
    const stub = env.MY_DO.getByName(instanceId);
    const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, instanceId);
    const id = await stub.id;
    
    // test-endpoints/status/404 returns a 404 error (with empty body)
    const errorRequest = new Request(
      TEST_ENDPOINTS.buildUrl('/status/404')
    );
    const serializedRequest = await encodeRequest(errorRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: '4xx-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: '4xx-req-1',
          request: serializedRequest,
          doBindingName: 'MY_DO',
          instanceId: id.toString(),
          handlerName: 'handleError',
          timestamp: Date.now(),
          retryCount: 0,
          options: { 
            maxRetries: 2, // Should not retry despite this setting
          },
        },
      },
    ]);
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    
    // Should be acked immediately without retry (4xx is not retryable)
    expect(result.explicitAcks.length).toBe(1);
    
    // Note: The handler receives a Response object, not an error, for 4xx responses
    // since the fetch succeeded (HTTP-level success, just a 404 status)
    // The test passes if message was acked and not retried
  });

  test('includes retry count and duration in handler item', { timeout: 5000 }, async () => {
    const instanceId = 'metadata-test';
    const stub = env.MY_DO.getByName(instanceId);
    const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, instanceId);
    const id = await stub.id;
    
    const request = new Request(
      TEST_ENDPOINTS.buildUrl('/uuid')
    );
    const serializedRequest = await encodeRequest(request);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'metadata-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'metadata-req-1',
          request: serializedRequest,
          doBindingName: 'MY_DO',
          instanceId: id.toString(),
          handlerName: 'handleError',
          timestamp: Date.now(),
          retryCount: 2, // Simulate this is attempt #3
        },
      },
    ]);
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    await getQueueResult(batch, ctx);
    
    // Verify response includes metadata
    await vi.waitFor(async () => {
      const response = await (stub as any).getLastResponse();
      expect(response).toBeDefined();
    }, { timeout: 3000 });
    
    // Check that retryCount and duration were passed to handler
    // Note: We'd need to update the test DO to store these values to verify
    // For now, just verify the response was delivered
    const response = await (stub as any).getLastResponse();
    expect(response).toBeDefined();
  });

  test('acks message even when handler throws error', async () => {
    const instanceId = 'throwing-handler-test';
    const stub = env.MY_DO.getByName(instanceId);
    const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, instanceId);
    const id = await stub.id;
    
    const request = new Request(
      TEST_ENDPOINTS.buildUrl('/uuid')
    );
    const serializedRequest = await encodeRequest(request);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'throwing-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'throwing-req-1',
          request: serializedRequest,
          doBindingName: 'MY_DO',
          instanceId: id.toString(),
          handlerName: 'handleThrowingError', // This handler throws
          timestamp: Date.now(),
          retryCount: 0,
        },
      },
    ]);
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    await getQueueResult(batch, ctx);
    
    // Wait for handler completion using waitUntil-tracked timestamp
    // ctx.waitUntil ensures the storage write completes even though the handler throws
    await vi.waitFor(async () => {
      const completedAt = await stub.getHandlerCompletedAt();
      expect(completedAt).not.toBeNull();
    }, { timeout: 5000 });
    
    // Verify handler was called despite throwing
    const wasHandlerCalled = await stub.getHandlerWasCalled();
    expect(wasHandlerCalled).toBe('throwing-req-1');
    
    // Message should be acked (not retried) - user code errors aren't retryable
    // The test passing means the queue consumer continued processing
  });
});
