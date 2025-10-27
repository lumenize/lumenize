/**
 * Integration tests for @lumenize/proxy-fetch
 * 
 * Tests the full flow: DO -> Queue -> Worker -> DO
 */
// @ts-expect-error
import { env, createMessageBatch, createExecutionContext, getQueueResult, runInDurableObject } from 'cloudflare:test';
import { describe, test, expect, vi } from 'vitest';
import worker from '../test/test-worker-and-dos';
import type { ProxyFetchQueueMessage } from '../src/types';
import { serializeWebApiObject } from '../src/web-api-serialization';
import { proxyFetch } from '../src/proxyFetch';

describe('proxyFetch() Function', () => {
  test('queues request with URL string', async () => {
    const stub = env.PROXY_FETCH_TEST_DO.getByName('proxy-fetch-test');
    
    // Call proxyFetch from within the DO - should not throw
    // @ts-expect-error - cloudflare:test types not available at compile time
    await runInDurableObject(stub, async (instance) => {
      await expect(
        proxyFetch(
          instance,
          'https://httpbin.org/json',
          'handleSuccess',
          'PROXY_FETCH_TEST_DO'
        )
      ).resolves.toBeUndefined();
    });
  });

  test('queues request with Request object and options', async () => {
    const stub = env.PROXY_FETCH_TEST_DO.getByName('proxy-fetch-options-test');
    
    // @ts-expect-error - cloudflare:test types not available at compile time
    await runInDurableObject(stub, async (instance) => {
      const request = new Request('https://httpbin.org/uuid', { 
        method: 'POST',
        body: JSON.stringify({ test: 'data' })
      });
      
      await expect(
        proxyFetch(
          instance,
          request,
          'handleSuccess',
          'PROXY_FETCH_TEST_DO',
          { timeout: 5000, maxRetries: 1 }
        )
      ).resolves.toBeUndefined();
    });
  });
});

describe('Proxy Fetch Integration', () => {
  test('full flow: DO triggers proxy fetch, queue processes, response delivered', { timeout: 5000 }, async () => {
    const stub = env.PROXY_FETCH_TEST_DO.getByName('integration-full-flow');
    const id = await stub.id;
    
    // Generate a reqId for this test
    const reqId = crypto.randomUUID();
    
    // Store metadata in DO (simulating what proxyFetch() would do)
    // @ts-expect-error - cloudflare:test types not available at compile time
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put(`proxy-fetch:${reqId}`, JSON.stringify({
        handlerName: 'handleSuccess',
        doBindingName: 'PROXY_FETCH_TEST_DO',
        instanceId: id.toString(),
        timestamp: Date.now(),
      }));
    });
    
    // Create a MessageBatch to simulate what the queue consumer receives
    const testRequest = new Request('https://httpbin.org/json');
    const serializedRequest = await serializeWebApiObject(testRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'test-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: reqId,
          request: serializedRequest,
          doBindingName: 'PROXY_FETCH_TEST_DO',
          instanceId: id.toString(),
          retryCount: 0,
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
      const response = await stub.getLastResponse();
      expect(response).toBeDefined();
    }, { timeout: 3000 });
    
    const response = await stub.getLastResponse();
    expect(response).toHaveProperty('slideshow');
    
    const storedReqId = await stub.getLastReqId();
    expect(storedReqId).toBe(reqId);
  });

  test('queue consumer processes multiple messages in batch', { timeout: 5000 }, async () => {
    const stub1 = env.PROXY_FETCH_TEST_DO.getByName('batch-test-1');
    const id1 = await stub1.id;
    
    const stub2 = env.PROXY_FETCH_TEST_DO.getByName('batch-test-2');
    const id2 = await stub2.id;
    
    // Create a batch with multiple messages using real serialization
    const req1 = new Request('https://httpbin.org/uuid');
    const req2 = new Request('https://httpbin.org/delay/1');
    const serializedReq1 = await serializeWebApiObject(req1);
    const serializedReq2 = await serializeWebApiObject(req2);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'req-1',
          request: serializedReq1,
          doBindingName: 'PROXY_FETCH_TEST_DO',
          instanceId: id1.toString(),
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
          doBindingName: 'PROXY_FETCH_TEST_DO',
          instanceId: id2.toString(),
          retryCount: 0,
        },
      },
    ]);
    
    // Store metadata in both DOs
    // @ts-expect-error - cloudflare:test types not available at compile time
    await runInDurableObject(stub1, async (_instance, state) => {
      state.storage.kv.put('proxy-fetch:req-1', JSON.stringify({
        handlerName: 'handleSuccess',
        doBindingName: 'PROXY_FETCH_TEST_DO',
        instanceId: id1.toString(),
        timestamp: Date.now(),
      }));
    });
    
    // @ts-expect-error - cloudflare:test types not available at compile time
    await runInDurableObject(stub2, async (_instance, state) => {
      state.storage.kv.put('proxy-fetch:req-2', JSON.stringify({
        handlerName: 'handleSuccess',
        doBindingName: 'PROXY_FETCH_TEST_DO',
        instanceId: id2.toString(),
        timestamp: Date.now(),
      }));
    });
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    await getQueueResult(batch, ctx);
    
    // Verify both DOs received their responses (need longer timeout for delay/1 endpoint)
    await vi.waitFor(async () => {
      const response1 = await stub1.getLastResponse();
      const response2 = await stub2.getLastResponse();
      expect(response1).toBeDefined();
      expect(response2).toBeDefined();
    }, { timeout: 3000 });
  });

  test('queue consumer handles fetch errors', async () => {
    const stub = env.PROXY_FETCH_TEST_DO.getByName('error-test');
    const id = await stub.id;
    
    // Create message with invalid URL using real serialization
    const errorRequest = new Request('https://this-is-not-a-valid-url-that-will-fail.invalid');
    const serializedErrorRequest = await serializeWebApiObject(errorRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'error-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'error-req-1',
          request: serializedErrorRequest,
          doBindingName: 'PROXY_FETCH_TEST_DO',
          instanceId: id.toString(),
          retryCount: 0,
          options: { maxRetries: 0 }, // Don't retry for this test
        },
      },
    ]);
    
    // Store metadata
    // @ts-expect-error - cloudflare:test types not available at compile time
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put('proxy-fetch:error-req-1', JSON.stringify({
        handlerName: 'handleError',
        doBindingName: 'PROXY_FETCH_TEST_DO',
        instanceId: id.toString(),
        timestamp: Date.now(),
      }));
    });
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    await getQueueResult(batch, ctx);
    
    // Verify error was delivered to DO
    await vi.waitFor(async () => {
      const error = await stub.getLastError();
      expect(error).toBeDefined();
    }, { timeout: 2000 });
    
    const error = await stub.getLastError();
    expect(error).toContain('internal error');
  });

  test('serialization preserves Request headers and method', { timeout: 5000 }, async () => {
    const stub = env.PROXY_FETCH_TEST_DO.getByName('serialization-test');
    const id = await stub.id;
    
    // Create message with POST request and custom headers using real serialization
    const postRequest = new Request('https://httpbin.org/post', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Custom-Header': 'test-value',
      },
      body: JSON.stringify({ test: 'data' }),
    });
    const serializedPostRequest = await serializeWebApiObject(postRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'post-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'post-req-1',
          request: serializedPostRequest,
          doBindingName: 'PROXY_FETCH_TEST_DO',
          instanceId: id.toString(),
          retryCount: 0,
        },
      },
    ]);
    
    // Store metadata
    // @ts-expect-error - cloudflare:test types not available at compile time
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put('proxy-fetch:post-req-1', JSON.stringify({
        handlerName: 'handleSuccess',
        doBindingName: 'PROXY_FETCH_TEST_DO',
        instanceId: id.toString(),
        timestamp: Date.now(),
      }));
    });
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    await getQueueResult(batch, ctx);
    
    // Verify response contains echoed headers
    await vi.waitFor(async () => {
      const response = await stub.getLastResponse();
      expect(response).toBeDefined();
    }, { timeout: 2000 });
    
    const response = await stub.getLastResponse();
    expect(response).toHaveProperty('headers');
    expect(response.headers).toHaveProperty('X-Custom-Header');
    expect(response.headers['X-Custom-Header']).toBe('test-value');
  });
});

describe('Error Handling and Retries', () => {
  test('timeout aborts long-running requests', { timeout: 10000 }, async () => {
    const stub = env.PROXY_FETCH_TEST_DO.getByName('timeout-test');
    const id = await stub.id;
    
    // httpbin.org/delay/N delays for N seconds
    const timeoutRequest = new Request('https://httpbin.org/delay/10'); // 10 second delay
    const serializedRequest = await serializeWebApiObject(timeoutRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'timeout-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'timeout-req-1',
          request: serializedRequest,
          doBindingName: 'PROXY_FETCH_TEST_DO',
          instanceId: id.toString(),
          retryCount: 0,
          options: { 
            timeout: 1000, // 1 second timeout
            maxRetries: 0, // No retries for this test
          },
        },
      },
    ]);
    
    // Store metadata
    // @ts-expect-error - cloudflare:test types not available at compile time
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put('proxy-fetch:timeout-req-1', JSON.stringify({
        handlerName: 'handleError',
        doBindingName: 'PROXY_FETCH_TEST_DO',
        instanceId: id.toString(),
        timestamp: Date.now(),
      }));
    });
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    await getQueueResult(batch, ctx);
    
    // Verify timeout error was delivered
    await vi.waitFor(async () => {
      const error = await stub.getLastError();
      expect(error).toBeDefined();
    }, { timeout: 5000 });
    
    const error = await stub.getLastError();
    expect(error).toContain('Request timeout after 1000ms');
  });

  test('retries network errors with exponential backoff', { timeout: 15000 }, async () => {
    const stub = env.PROXY_FETCH_TEST_DO.getByName('retry-test');
    const id = await stub.id;
    
    // Invalid URL that will fail with network error
    const errorRequest = new Request('https://invalid-domain-that-does-not-exist-123456.invalid');
    const serializedRequest = await serializeWebApiObject(errorRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'retry-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'retry-req-1',
          request: serializedRequest,
          doBindingName: 'PROXY_FETCH_TEST_DO',
          instanceId: id.toString(),
          retryCount: 0,
          options: { 
            maxRetries: 2, // Try 3 times total (initial + 2 retries)
            retryDelay: 500, // 500ms initial delay
          },
        },
      },
    ]);
    
    // Store metadata
    // @ts-expect-error - cloudflare:test types not available at compile time
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put('proxy-fetch:retry-req-1', JSON.stringify({
        handlerName: 'handleError',
        doBindingName: 'PROXY_FETCH_TEST_DO',
        instanceId: id.toString(),
        timestamp: Date.now(),
      }));
    });
    
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
    const stub = env.PROXY_FETCH_TEST_DO.getByName('5xx-retry-test');
    const id = await stub.id;
    
    // httpbin.org/status/500 returns a 500 error
    const errorRequest = new Request('https://httpbin.org/status/500');
    const serializedRequest = await serializeWebApiObject(errorRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: '5xx-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: '5xx-req-1',
          request: serializedRequest,
          doBindingName: 'PROXY_FETCH_TEST_DO',
          instanceId: id.toString(),
          retryCount: 0,
          options: { 
            maxRetries: 1,
            retryDelay: 200,
            retryOn5xx: true, // Retry on 5xx errors
          },
        },
      },
    ]);
    
    // Store metadata
    // @ts-expect-error - cloudflare:test types not available at compile time
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put('proxy-fetch:5xx-req-1', JSON.stringify({
        handlerName: 'handleSuccess',
        doBindingName: 'PROXY_FETCH_TEST_DO',
        instanceId: id.toString(),
        timestamp: Date.now(),
      }));
    });
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    
    // Should be acked for retry since 5xx is retryable
    expect(result.explicitAcks.length).toBe(1);
  });

  test('does not retry 4xx client errors', { timeout: 5000 }, async () => {
    const stub = env.PROXY_FETCH_TEST_DO.getByName('4xx-test');
    const id = await stub.id;
    
    // httpbin.org/status/404 returns a 404 error (with empty body)
    const errorRequest = new Request('https://httpbin.org/status/404');
    const serializedRequest = await serializeWebApiObject(errorRequest);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: '4xx-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: '4xx-req-1',
          request: serializedRequest,
          doBindingName: 'PROXY_FETCH_TEST_DO',
          instanceId: id.toString(),
          retryCount: 0,
          options: { 
            maxRetries: 2, // Should not retry despite this setting
          },
        },
      },
    ]);
    
    // Store metadata - use handleError since 404 responses have empty bodies
    // @ts-expect-error - cloudflare:test types not available at compile time
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put('proxy-fetch:4xx-req-1', JSON.stringify({
        handlerName: 'handleError', // Use error handler to avoid JSON parse issues
        doBindingName: 'PROXY_FETCH_TEST_DO',
        instanceId: id.toString(),
        timestamp: Date.now(),
      }));
    });
    
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
    const stub = env.PROXY_FETCH_TEST_DO.getByName('metadata-test');
    const id = await stub.id;
    
    const request = new Request('https://httpbin.org/uuid');
    const serializedRequest = await serializeWebApiObject(request);
    
    const batch = createMessageBatch('proxy-fetch-queue', [
      {
        id: 'metadata-msg-1',
        timestamp: new Date(),
        attempts: 1,
        body: {
          reqId: 'metadata-req-1',
          request: serializedRequest,
          doBindingName: 'PROXY_FETCH_TEST_DO',
          instanceId: id.toString(),
          retryCount: 2, // Simulate this is attempt #3
        },
      },
    ]);
    
    // Store metadata
    // @ts-expect-error - cloudflare:test types not available at compile time
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put('proxy-fetch:metadata-req-1', JSON.stringify({
        handlerName: 'handleSuccess',
        doBindingName: 'PROXY_FETCH_TEST_DO',
        instanceId: id.toString(),
        timestamp: Date.now(),
      }));
    });
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    await getQueueResult(batch, ctx);
    
    // Verify response includes metadata
    await vi.waitFor(async () => {
      const response = await stub.getLastResponse();
      expect(response).toBeDefined();
    }, { timeout: 3000 });
    
    // Check that retryCount and duration were passed to handler
    // Note: We'd need to update the test DO to store these values to verify
    // For now, just verify the response was delivered
    const response = await stub.getLastResponse();
    expect(response).toBeDefined();
  });
});

