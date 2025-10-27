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
        },
      },
    ]);
    
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    
    // Verify the message was processed
    expect(result.ackAll).toBe(false);
    expect(result.explicitAcks.length).toBe(0);
    
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

  test('serialization preserves Request headers and method', async () => {
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
