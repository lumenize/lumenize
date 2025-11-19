/**
 * Integration tests for proxyFetchSimple
 * 
 * Tests the simplified architecture without FetchOrchestrator:
 * - Origin DO schedules alarm with continuation
 * - Worker executes fetch and calls back to origin DO
 * - Race condition between result delivery and timeout
 * - Atomic alarm cancellation ensures only one path wins
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { parse, ResponseSync } from '@lumenize/structured-clone';
import { createTestEndpoints } from '@lumenize/test-endpoints';

describe('proxyFetchSimple - Basic Flow', () => {
  test('makes successful fetch and delivers result via worker callback', async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('test');
    await stub.clearResults();
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'simple-test');
    const url = testEndpoints.buildUrl('/uuid');
    
    // Default 30s alarm timeout is plenty for this fast request
    const reqId = await stub.fetchDataSimple(url);
    
    // Wait for result to arrive
    const serialized = await vi.waitFor(async () => {
      const r = await stub.getResult(url);
      expect(r).toBeDefined();
      return r;
    }, { timeout: 2000, interval: 50 });
    
    const result = parse(serialized);
    expect(result).toBeInstanceOf(ResponseSync);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.json()).toHaveProperty('uuid');
    
    // Should be called exactly once (not double-executed)
    const callCount = await stub.getCallCount(url);
    expect(callCount).toBe(1);
  });

  test('fetches with Request object including headers and body', async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('request-object-test');
    await stub.clearResults();
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'request-object-test');
    const url = testEndpoints.buildUrl('/echo');
    
    const request = new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Custom-Header': 'test-value'
      },
      body: JSON.stringify({ message: 'Hello from Request object' })
    });

    const reqId = await stub.fetchDataSimpleWithRequest(request);

    const serialized = await vi.waitFor(async () => {
      const r = await stub.getResult(url);
      expect(r).toBeDefined();
      return r;
    }, { timeout: 2000, interval: 50 });

    const result = parse(serialized);
    expect(result).toBeInstanceOf(ResponseSync);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    
    const body = result.json();
    expect(body.json).toEqual({ message: 'Hello from Request object' });
    expect(body.headers['x-custom-header']).toBe('test-value');
    expect(body.headers['content-type']).toBe('application/json');
    
    const callCount = await stub.getCallCount(url);
    expect(callCount).toBe(1);
  });

  test('handles fetch timeout via alarm when worker delivery is simulated to fail', async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('timeout-test');
    await stub.clearResults();
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'timeout-test');
    const url = testEndpoints.buildUrl('/uuid');  // Any endpoint is fine, we're simulating delivery failure
    
    // Use very short timeout and simulate delivery failure
    const reqId = await stub.fetchDataSimpleWithOptions(
      url, 
      { 
        timeout: 100,
        testMode: { 
          simulateDeliveryFailure: true,
          orchestratorTimeoutOverride: 100  // Short timeout for test
        }
      }
    );
    
    // Trigger timeout alarm and wait for result
    await stub.triggerAlarmsHelper();
    
    // Wait for result to be stored
    const serialized = await vi.waitFor(async () => {
      const r = await stub.getResult(url);
      expect(r).toBeDefined();
      return r;
    }, { timeout: 2000, interval: 10 });
    
    const result = parse(serialized!);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('Fetch timeout');
    
    // Should be called exactly once via timeout
    const callCount = await stub.getCallCount(url);
    expect(callCount).toBe(1);
  });

  test('idempotency: result delivery wins race, timeout becomes noop', async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('race-test-1');
    await stub.clearResults();
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'race-test-1');
    const url = testEndpoints.buildUrl('/uuid');
    
    // Default 30s alarm timeout is plenty for this fast request
    const reqId = await stub.fetchDataSimple(url);
    
    // Wait for result to arrive (use vi.waitFor for reliability)
    const serialized = await vi.waitFor(async () => {
      const r = await stub.getResult(url);
      expect(r).toBeDefined();
      return r;
    }, { timeout: 2000, interval: 50 });
    
    // Check result was delivered by worker
    const result = parse(serialized);
    expect(result).toBeInstanceOf(ResponseSync);
    expect(result.status).toBe(200);
    
    // Now try to trigger alarm (should be noop as alarm was cancelled)
    await stub.triggerAlarmsHelper();
    
    // Should still have only 1 call (worker delivery), not 2
    const callCount = await stub.getCallCount(url);
    expect(callCount).toBe(1);
  });

  test('idempotency: timeout wins race, result delivery becomes noop', async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('race-test-2');
    await stub.clearResults();
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'race-test-2');
    const url = testEndpoints.buildUrl('/delay/1000');
    
    const reqId = await stub.fetchDataSimpleWithOptions(
      url,
      { 
        timeout: 100,
        testMode: { 
          simulateDeliveryFailure: true,  // Worker won't deliver
          orchestratorTimeoutOverride: 100
        }
      }
    );
    
    // Trigger alarm immediately (timeout wins)
    await stub.triggerAlarmsHelper();
    
    // Wait for timeout error to be delivered
    const serialized = await vi.waitFor(async () => {
      const r = await stub.getResult(url);
      expect(r).toBeDefined();
      return r;
    }, { timeout: 1000, interval: 10 });
    
    const result = parse(serialized);
    expect(result).toBeInstanceOf(Error);
    
    // Worker callback would have been attempted (if not for simulateDeliveryFailure)
    // but alarm is already gone, so it would have been a noop
    // Since we simulated delivery failure, we can check the noop flag
    
    // Should have only 1 call (timeout), not 2
    const callCount = await stub.getCallCount(url);
    expect(callCount).toBe(1);
  });
});

describe('proxyFetchSimple - Error Handling', () => {
  test('receives ResponseSync (not Error) for HTTP 404', async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('http-404-test');
    await stub.clearResults();
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'http-404-test');
    const url = testEndpoints.buildUrl('/status/404');
    
    const reqId = await stub.fetchDataSimple(url);
    
    const serialized = await vi.waitFor(async () => {
      const r = await stub.getResult(url);
      expect(r).toBeDefined();
      return r;
    }, { timeout: 2000, interval: 50 });

    const result = parse(serialized);
    expect(result).toBeInstanceOf(ResponseSync);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.statusText).toBe('Not Found');
    
    const callCount = await stub.getCallCount(url);
    expect(callCount).toBe(1);
  });

  test('handles fetch errors gracefully', async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('error-test');
    await stub.clearResults();
    const url = 'https://definitely-does-not-exist-12345.invalid';
    
    // Default 30s alarm timeout is plenty (error happens immediately)
    const reqId = await stub.fetchDataSimple(url);
    
    // Wait for error to be stored
    const serialized = await vi.waitFor(async () => {
      const r = await stub.getResult(url);
      expect(r).toBeDefined();
      return r;
    }, { timeout: 2000, interval: 10 });
    
    const result = parse(serialized);
    expect(result).toBeInstanceOf(Error);
    
    // Should be called exactly once
    const callCount = await stub.getCallCount(url);
    expect(callCount).toBe(1);
  });

  test('handles fetch timeout via AbortController', async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('abort-test');
    await stub.clearResults();
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'abort-test');
    const url = testEndpoints.buildUrl('/delay/10000');  // 10 second delay
    
    // 500ms timeout triggers AbortController (before alarm would fire)
    const reqId = await stub.fetchDataSimpleWithOptions(url, { timeout: 500 });
    
    // Wait for abort error to be stored
    const serialized = await vi.waitFor(async () => {
      const r = await stub.getResult(url);
      expect(r).toBeDefined();
      return r;
    }, { timeout: 2000, interval: 10 });
    
    const result = parse(serialized);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('abort');
    
    // Should be called exactly once
    const callCount = await stub.getCallCount(url);
    expect(callCount).toBe(1);
  });
});

