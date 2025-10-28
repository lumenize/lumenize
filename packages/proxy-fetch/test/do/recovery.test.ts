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
import { serializeWebApiObject } from '@lumenize/utils';
// @ts-expect-error - cloudflare:test types not available at compile time
import { env } from 'cloudflare:test';

const ulid = ulidFactory();

it('recovers orphaned requests from in-flight state', async () => {
  using proxyClient = createTestingClient<typeof _ProxyFetchDO>(
    'PROXY_FETCH_DO',
    'proxy-fetch-recovery'
  );

  // Manually inject a request into "in-flight" state to simulate an orphaned request
  const requestUlid = ulid();
  const testRequest = new Request(
    `${env.TEST_ENDPOINTS_URL}/uuid?token=${env.TEST_TOKEN}`,
    { method: 'GET' }
  );
  const serializedRequest = await serializeWebApiObject(testRequest);
  
  await proxyClient.ctx.storage.kv.put(`reqs-in-flight:${requestUlid}`, {
    reqId: 'orphaned-req-1',
    request: serializedRequest,
    doBindingName: 'TEST_DO',
    instanceId: 'test-instance',
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

  // Wait for recovery to complete - request should be moved from in-flight to queued
  await vi.waitFor(async () => {
    // @ts-expect-error
    const inFlight = await proxyClient.ctx.storage.kv.list({ prefix: 'reqs-in-flight:' }).toArray();
    // @ts-expect-error
    const queued = await proxyClient.ctx.storage.kv.list({ prefix: 'reqs-queued:' }).toArray();
    
    // Should have moved from in-flight to queued
    expect(inFlight).toHaveLength(0);
    expect(queued).toHaveLength(1);
  }, { timeout: 500 });
});

it('expires old orphaned requests', async () => {
  using proxyClient = createTestingClient<typeof _ProxyFetchDO>(
    'PROXY_FETCH_DO',
    'proxy-fetch-expire'
  );

  // Create a ULID representing a request from 31 minutes ago (older than MAX_REQUEST_AGE_MS = 30min)
  // Use non-monotonic factory so it doesn't refuse to go backward in time
  const oldUlidFactory = ulidFactory({ monotonic: false });
  const thirtyOneMinutesAgo = Date.now() - (31 * 60 * 1000);
  const oldUlid = oldUlidFactory(thirtyOneMinutesAgo);
  
  const expiredRequest = new Request(
    `${env.TEST_ENDPOINTS_URL}/uuid?token=${env.TEST_TOKEN}`,
    { method: 'GET' }
  );
  const serializedExpiredRequest = await serializeWebApiObject(expiredRequest);
  
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
