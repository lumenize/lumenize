/**
 * Tests for ProxyFetchDO Recovery Mechanisms
 * 
 * Tests the recovery and cleanup of orphaned requests that can occur when:
 * - A DO is evicted from memory mid-processing
 * - Requests get stuck in 'reqs-in-flight' state
 * - Old requests need to be expired
 */
import { it, expect, vi } from 'vitest';
import { ulidFactory } from 'ulid-workers';
import { createTestingClient } from '@lumenize/testing';
import { _ProxyFetchDO } from './test-worker';
import { encodeRequest } from '@lumenize/structured-clone';
// @ts-expect-error - cloudflare:test types not available at compile time
import { env } from 'cloudflare:test';
import { createTestEndpoints } from '@lumenize/test-endpoints';

const ulid = ulidFactory();

it('recovers orphaned requests from in-flight state', async () => {
  const proxyInstanceId = 'proxy-fetch-recovery';
  using proxyClient = createTestingClient<typeof _ProxyFetchDO>(
    'PROXY_FETCH_DO',
    proxyInstanceId
  );

  // Create test endpoints client isolated to this test
  const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, proxyInstanceId);

  // Collect callbacks via downstream messaging
  const callbacks: any[] = [];
  const userInstanceId = 'recovery-test-user';
  await using userClient = createTestingClient<typeof import('./test-worker')._TestDO>(
    'TEST_DO',
    userInstanceId,
    {
      onDownstream: (message) => {
        callbacks.push(message);
      }
    }
  );

  // Make a call to establish the WebSocket connection
  await userClient.reset();

  // Get the actual DO ID (hex string) from the env binding
  const doBinding = env.TEST_DO;
  const doId = doBinding.idFromName(userInstanceId);
  const doIdString = doId.toString();

  // Manually inject a request into "in-flight" state to simulate an orphaned request
  const requestUlid = ulid();
  const testRequest = new Request(
    TEST_ENDPOINTS.buildUrl('/uuid'),
    { method: 'GET' }
  );
  const serializedRequest = await encodeRequest(testRequest);
  
  await proxyClient.ctx.storage.kv.put(`reqs-in-flight:${requestUlid}`, {
    reqId: 'orphaned-req-1',
    request: serializedRequest,
    doBindingName: 'TEST_DO',
    instanceId: doIdString,  // Use the actual hex DO ID
    handlerName: 'handleSuccess',
    retryCount: 0,
    timestamp: Date.now(),
  });

  // Verify request is in in-flight storage
  // @ts-expect-error - toArray() exists at runtime but not in types
  let inFlight = await proxyClient.ctx.storage.kv.list({ prefix: 'reqs-in-flight:' }).toArray();
  expect(inFlight).toHaveLength(1);

  // Manually trigger recovery (simulates what happens in constructor after DO eviction)
  await proxyClient.triggerRecovery();

  // Wait for recovery to complete - request should be moved from in-flight to queued,
  // then processed, then callback delivered via downstream
  await vi.waitFor(async () => {
    // @ts-expect-error
    const inFlight = await proxyClient.ctx.storage.kv.list({ prefix: 'reqs-in-flight:' }).toArray();
    // @ts-expect-error
    const queued = await proxyClient.ctx.storage.kv.list({ prefix: 'reqs-queued:' }).toArray();
    
    // After recovery and processing completes, both should be cleaned up
    expect(inFlight).toHaveLength(0);
    expect(queued).toHaveLength(0);
    
    // And callback should have been delivered
    expect(callbacks.length).toBe(1);
    expect(callbacks[0].reqId).toBe('orphaned-req-1');
  }, { timeout: 2000 });
});

it('expires old orphaned requests', async () => {
  const proxyInstanceId = 'proxy-fetch-expire';
  using proxyClient = createTestingClient<typeof _ProxyFetchDO>(
    'PROXY_FETCH_DO',
    proxyInstanceId
  );

  // Create test endpoints client isolated to this test
  const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, proxyInstanceId);

  // Create a ULID representing a request from 31 minutes ago (older than MAX_REQUEST_AGE_MS = 30min)
  // Use non-monotonic factory so it doesn't refuse to go backward in time
  const oldUlidFactory = ulidFactory({ monotonic: false });
  const thirtyOneMinutesAgo = Date.now() - (31 * 60 * 1000);
  const oldUlid = oldUlidFactory(thirtyOneMinutesAgo);
  
  const expiredRequest = new Request(
    TEST_ENDPOINTS.buildUrl('/uuid'),
    { method: 'GET' }
  );
  const serializedExpiredRequest = await encodeRequest(expiredRequest);
  
  // Store directly in in-flight with old ULID
  await proxyClient.ctx.storage.kv.put(`reqs-in-flight:${oldUlid}`, {
    reqId: 'expired-req-1',
    request: serializedExpiredRequest,
    doBindingName: 'TEST_DO',
    instanceId: 'some-id',
    handlerName: 'handleSuccess',
    retryCount: 0,
    timestamp: thirtyOneMinutesAgo,
  });

  // Verify it's in storage
  // @ts-expect-error
  let inFlight = await proxyClient.ctx.storage.kv.list({ prefix: 'reqs-in-flight:' }).toArray();
  expect(inFlight).toHaveLength(1);

  // Manually trigger recovery (simulates what happens in constructor after DO eviction)
  await proxyClient.triggerRecovery();

  // Wait for expiration to complete
  await vi.waitFor(async () => {
    // @ts-expect-error
    const storage = await proxyClient.ctx.storage.kv.list({ prefix: 'reqs-in-flight:' }).toArray();
    expect(storage).toHaveLength(0); // Should be deleted
  }, { timeout: 1000 });

  // Verify it was NOT queued (should have been expired, not recovered)
  // @ts-expect-error
  const queued = await proxyClient.ctx.storage.kv.list({ prefix: 'reqs-queued:' }).toArray();
  expect(queued).toHaveLength(0);
});
