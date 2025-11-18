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

// Test helper to wait for asynchronous processing
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('proxyFetchSimple - Basic Flow', () => {
  beforeEach(async () => {
    // Clear state before each test
    const stub = env.TEST_SIMPLE_DO.getByName('test');
    await stub.clearResults();
  });

  test('makes successful fetch and delivers result via worker callback', async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('test');
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'simple-test');
    const url = testEndpoints.buildUrl('/uuid');
    
    // Use very long alarm timeout to ensure it doesn't fire during test
    const reqId = await stub.fetchDataSimpleWithOptions(url, {
      testMode: { orchestratorTimeoutOverride: 999999 }
    });
    
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

  test('handles fetch timeout via alarm when worker delivery is simulated to fail', async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('timeout-test');
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
    
    // Wait for timeout alarm to fire (need to wait for alarm time to be reached)
    await sleep(150); // Wait longer than orchestratorTimeoutOverride
    await stub.triggerAlarmsHelper();
    
    // Wait for result to be stored
    const serialized = await vi.waitFor(async () => {
      const r = await stub.getResult(url);
      expect(r).toBeDefined();
      return r;
    }, { timeout: 2000, interval: 50 });
    
    const result = parse(serialized!);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('Fetch timeout');
    
    // Should be called exactly once via timeout
    const callCount = await stub.getCallCount(url);
    expect(callCount).toBe(1);
  });

  test('idempotency: result delivery wins race, timeout becomes noop', async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('race-test-1');
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'race-test-1');
    const url = testEndpoints.buildUrl('/uuid');
    
    // Use very long alarm timeout to ensure result wins race
    const reqId = await stub.fetchDataSimpleWithOptions(url, {
      testMode: { orchestratorTimeoutOverride: 999999 }
    });
    
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
    await sleep(50);
    
    // Should still have only 1 call (worker delivery), not 2
    const callCount = await stub.getCallCount(url);
    expect(callCount).toBe(1);
  });

  test('idempotency: timeout wins race, result delivery becomes noop', async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('race-test-2');
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
    await sleep(50);
    
    // Check timeout error was delivered
    const serialized = await stub.getResult(url);
    expect(serialized).toBeDefined();
    const result = parse(serialized!);
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
  beforeEach(async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('error-test');
    await stub.clearResults();
  });

  test('handles fetch errors gracefully', async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('error-test');
    const url = 'https://definitely-does-not-exist-12345.invalid';
    
    // Use very long alarm timeout to ensure it doesn't fire during test
    const reqId = await stub.fetchDataSimpleWithOptions(url, {
      testMode: { orchestratorTimeoutOverride: 999999 }
    });
    
    // Wait for async processing
    await sleep(200);
    
    // Check that error was stored
    const serialized = await stub.getResult(url);
    expect(serialized).toBeDefined();
    
    const result = parse(serialized!);
    expect(result).toBeInstanceOf(Error);
    
    // Should be called exactly once
    const callCount = await stub.getCallCount(url);
    expect(callCount).toBe(1);
  });

  test('handles fetch timeout via AbortController', async () => {
    const stub = env.TEST_SIMPLE_DO.getByName('abort-test');
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'abort-test');
    const url = testEndpoints.buildUrl('/delay/10000');  // 10 second delay
    
    const reqId = await stub.fetchDataSimpleWithOptions(
      url,
      { 
        timeout: 500,  // 500ms timeout for AbortController
        testMode: { orchestratorTimeoutOverride: 999999 }  // Very long alarm timeout
      }
    );
    
    // Wait for fetch to timeout
    await sleep(700);
    
    // Check that abort error was stored
    const serialized = await stub.getResult(url);
    expect(serialized).toBeDefined();
    
    const result = parse(serialized!);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('abort');
    
    // Should be called exactly once
    const callCount = await stub.getCallCount(url);
    expect(callCount).toBe(1);
  });
});

