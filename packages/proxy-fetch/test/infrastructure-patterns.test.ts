/**
 * Infrastructure Pattern Tests
 * 
 * These tests demonstrate and validate the key patterns learned during
 * proxyFetchSimple development that will be used in the clean v2 rebuild:
 * 
 * 1. Explicit ID scheduling: alarms.schedule(when, continuation, { id })
 * 2. Atomic cancellation: cancelSchedule(id) returns Schedule | undefined
 * 3. Continuation embedding: preprocessed continuation as handler argument
 * 4. In-process testing with @lumenize/test-endpoints
 * 5. Worker callRaw with replaceNestedOperationMarkers for $result filling
 * 
 * These patterns emerged from Phase -1, 0.5, and 1 infrastructure work.
 */

import { describe, test, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { createTestEndpoints } from '@lumenize/test-endpoints';

describe('Infrastructure Patterns for proxyFetchSimple', () => {
  describe('Pattern 1: Explicit ID Scheduling', () => {
    test('can schedule alarm with explicit ID matching request ID', async () => {
      const stub = env.TEST_SIMPLE_DO.getByName('explicit-id-test');
      await stub.clearResults();
      const reqId = 'test-req-explicit-123';
      
      // Schedule alarm with explicit ID
      const scheduledId = await stub.scheduleWithExplicitId(reqId);
      
      // Should return the same ID we provided
      expect(scheduledId).toBe(reqId);
      
      // Should be retrievable by that ID
      const schedule = await stub.getScheduleById(reqId);
      expect(schedule).toBeDefined();
      expect(schedule.id).toBe(reqId);
    });
  });

  describe('Pattern 2: Atomic Cancellation', () => {
    test('cancelSchedule returns Schedule data including continuation', async () => {
      const stub = env.TEST_SIMPLE_DO.getByName('atomic-cancel-test');
      await stub.clearResults();
      const reqId = 'test-req-cancel-456';
      
      // Schedule alarm with continuation
      await stub.scheduleWithExplicitId(reqId);
      
      // Cancel and get data atomically
      const canceledData = await stub.cancelAndGetData(reqId);
      
      // Should return the Schedule data
      expect(canceledData).toBeDefined();
      expect(canceledData.id).toBe(reqId);
      expect(canceledData.operationChain).toBeDefined();
      
      // Second cancel should return undefined (already gone)
      const secondCancel = await stub.cancelAndGetData(reqId);
      expect(secondCancel).toBeUndefined();
    });

    test('idempotency: only first cancel wins the race', async () => {
      const stub = env.TEST_SIMPLE_DO.getByName('race-cancel-test');
      await stub.clearResults();
      const reqId = 'test-req-race-789';
      
      await stub.scheduleWithExplicitId(reqId);
      
      // Simulate race: two entities try to cancel simultaneously
      const [first, second] = await Promise.all([
        stub.cancelAndGetData(reqId),
        stub.cancelAndGetData(reqId)
      ]);
      
      // Only one should succeed (get the data)
      const results = [first, second].filter(r => r !== undefined);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(reqId);
    });
  });

  describe('Pattern 3: Continuation Embedding', () => {
    test('can embed preprocessed continuation as handler argument', async () => {
      const stub = env.TEST_SIMPLE_DO.getByName('continuation-embed-test');
      await stub.clearResults();
      
      // This test validates that:
      // 1. User continuation is preprocessed
      // 2. Preprocessed continuation is embedded in alarm handler
      // 3. Alarm handler deserializes and fills it with result
      // 4. User continuation executes with the result
      
      const value = 'test-value-abc';
      const reqId = await stub.testContinuationEmbedding(value);
      
      // Trigger the alarm to execute the embedded continuation
      await stub.triggerAlarmsHelper();
      
      // Wait for the user's handler to receive the value
      await vi.waitFor(async () => {
        const storedValue = await stub.getStoredValue('embed-test');
        expect(storedValue).toBe(value);
      }, { timeout: 1000, interval: 10 });
    });
  });

  describe('Pattern 4: In-Process Testing with test-endpoints', () => {
    test('can make HTTP requests to in-process test-endpoints DO', async () => {
      const stub = env.TEST_SIMPLE_DO.getByName('fetch-test');
      await stub.clearResults();
      const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'infra-test');
      
      // Build URL for in-process endpoint
      // Note: Base URL is ignored, only path matters for in-process routing
      const url = testEndpoints.buildUrl('/uuid');
      
      // Make request (routed in-process to TEST_ENDPOINTS_DO)
      const result = await stub.testDirectFetch(url);
      
      // Should get successful response from test-endpoints
      expect(result.status).toBe(200);
      expect(result.json).toHaveProperty('uuid');
    });
  });

  describe('Pattern 5: Worker callRaw with $result Filling', () => {
    test('worker can use replaceNestedOperationMarkers to fill $result placeholder', async () => {
      const stub = env.TEST_SIMPLE_DO.getByName('result-fill-test');
      await stub.clearResults();
      
      // This test simulates the worker pattern:
      // 1. Create continuation with $result placeholder
      // 2. Fill $result with actual value using replaceNestedOperationMarkers
      // 3. Call origin DO via callRaw with filled continuation
      
      const testValue = { data: 'test-123' };
      await stub.testResultFilling(testValue);
      
      // Check that the DO received the filled value
      const received = await stub.getReceivedValue('result-fill-test');
      expect(received).toEqual(testValue);
    });
  });
});

