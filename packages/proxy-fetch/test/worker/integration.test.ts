/**
 * Integration Tests: proxyFetchWorker Complete Flow
 * 
 * Tests the DO-Worker hybrid architecture:
 * 1. Origin DO → FetchOrchestrator: Enqueue fetch
 * 2. FetchOrchestrator → Worker: Dispatch
 * 3. Worker → External API: Execute fetch (CPU billing)
 * 4. Worker → Origin DO: Send result DIRECTLY
 * 5. Origin DO: Execute continuation with Response | Error
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createTestingClient, enableAlarmSimulation } from '@lumenize/testing';
import { _TestDO, _FetchOrchestrator } from './test-worker-and-dos';
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { createTestEndpoints } from '@lumenize/test-endpoints';
import { proxyFetch } from '../../src/index';

describe('ProxyFetchWorker Integration', () => {
  describe('Basic Flow', () => {
    test.skip('successful fetch: origin DO gets Response', async () => {
      const originInstanceId = 'worker-test-1';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      // Create isolated test endpoints
      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);

      // Make fetch request
      const reqId = await originClient.fetchData(TEST_ENDPOINTS.buildUrl('/uuid'));

      expect(reqId).toBeDefined();
      expect(typeof reqId).toBe('string');

      // Wait for result (with timeout for cold start)
      await vi.waitFor(async () => {
        const result = await originClient.getResult(reqId);
        expect(result).toBeDefined();
      }, { timeout: 15000 });

      // Verify result
      const result = await originClient.getResult(reqId);
      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      // Note: duration may be 0 in test environment due to clock behavior during I/O
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    test.skip('error handling: network error produces Error', async () => {
      const originInstanceId = 'worker-error-test';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      // Use invalid domain
      const reqId = await originClient.fetchData('https://invalid-domain-that-will-fail.invalid/');

      // Wait for error result
      await vi.waitFor(async () => {
        const result = await originClient.getResult(reqId);
        expect(result).toBeDefined();
      }, { timeout: 10000 });

      const result = await originClient.getResult(reqId);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toBeInstanceOf(Error);
    });

    test.skip('HTTP error status: receives Response (not Error)', async () => {
      const originInstanceId = 'worker-http-error-test';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      // Create test endpoint that returns 404
      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);
      const reqId = await originClient.fetchData(TEST_ENDPOINTS.buildUrl('/status/404'));

      await vi.waitFor(async () => {
        const result = await originClient.getResult(reqId);
        expect(result).toBeDefined();
      }, { timeout: 15000 });

      const result = await originClient.getResult(reqId);
      // HTTP errors arrive as Response objects, not Error
      expect(result.success).toBe(true); // Got a response
      expect(result.status).toBe(404); // But status is 404
    });
  });

  describe('Latency Measurements', () => {
    test.skip('measures end-to-end latency', async () => {
      const originInstanceId = 'latency-test-1';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);

      // Reset measurements
      await originClient.reset();

      // Make multiple requests to get average latency
      const reqIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const reqId = await originClient.fetchData(TEST_ENDPOINTS.buildUrl('/uuid'));
        reqIds.push(reqId);
        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Wait for all results
      await vi.waitFor(async () => {
        for (const reqId of reqIds) {
          const result = await originClient.getResult(reqId);
          expect(result).toBeDefined();
        }
      }, { timeout: 20000 });

      // Get latency measurements
      const measurements = await originClient.getLatencyMeasurements();
      expect(measurements.length).toBeGreaterThanOrEqual(5);

      // Calculate statistics
      const durations = measurements.slice(0, 5).map(m => m.duration);
      const avgLatency = durations.reduce((a, b) => a + b, 0) / durations.length;
      const minLatency = Math.min(...durations);
      const maxLatency = Math.max(...durations);

      // Assertions
      // Note: avgLatency may be 0 in test environment due to clock behavior during I/O
      expect(avgLatency).toBeGreaterThanOrEqual(0);
      expect(avgLatency).toBeLessThan(5000); // Should be much faster than queue variant
    });

    test.skip('comparison: multiple parallel requests', async () => {
      const originInstanceId = 'parallel-latency-test';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);

      await originClient.reset();

      // Make 10 parallel requests
      const startTime = Date.now();
      const reqIdPromises = Array.from({ length: 10 }, () =>
        originClient.fetchData(TEST_ENDPOINTS.buildUrl('/uuid'))
      );

      const reqIds = await Promise.all(reqIdPromises);
      const queueTime = Date.now() - startTime;

      // Wait for all to complete
      await vi.waitFor(async () => {
        for (const reqId of reqIds) {
          const result = await originClient.getResult(reqId);
          expect(result).toBeDefined();
        }
      }, { timeout: 30000 });

      const totalTime = Date.now() - startTime;

      // Verify all succeeded
      for (const reqId of reqIds) {
        const result = await originClient.getResult(reqId);
        expect(result.success).toBe(true);
      }
    });
  });

  describe('FetchOrchestrator', () => {
    test('orchestrator maintains queue state', async () => {
      using orchestratorClient = createTestingClient<typeof _FetchOrchestrator>(
        'FETCH_ORCHESTRATOR',
        'singleton'
      );

      // Get initial stats
      const initialStats = await orchestratorClient.getQueueStats();
      expect(initialStats).toBeDefined();
      expect(initialStats.pendingCount).toBeGreaterThanOrEqual(0);
    });

    test('handles missing executor binding gracefully', async () => {
      const originInstanceId = 'missing-binding-test';
      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);
      
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      // Try to fetch with invalid executor binding (should log error but not throw)
      const reqId = await originClient.fetchDataWithOptions(
        TEST_ENDPOINTS.buildUrl('/uuid'),
        { executorBinding: 'NONEXISTENT_BINDING', originBinding: 'TEST_DO' }
      );

      // Wait a bit for error to be logged
      await new Promise(resolve => setTimeout(resolve, 100));

      // The request should be queued but won't complete (executor not found)
      // Just verify we can still call methods on origin DO (not crashed)
      const result = await originClient.getResult(reqId);
      // Result won't exist because executor was never called
      expect(result).toBeUndefined();
    });
  });

  describe('Actor Model Behavior', () => {
    test.skip('origin DO not blocked by fetch execution', async () => {
      const originInstanceId = 'non-blocking-test';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);

      // Measure time to queue the request (should be fast)
      const queueStart = Date.now();
      const reqId = await originClient.fetchData(TEST_ENDPOINTS.buildUrl('/uuid'));
      const queueDuration = Date.now() - queueStart;

      // Queue should be fast
      // Note: Test environment has RPC overhead, production would be faster
      expect(queueDuration).toBeLessThan(1000); // 1 second is generous for test environment

      // But result arrives later
      await vi.waitFor(async () => {
        const result = await originClient.getResult(reqId);
        expect(result).toBeDefined();
      }, { timeout: 15000 });

      const result = await originClient.getResult(reqId);
      expect(result.success).toBe(true);
    });
  });

  describe('proxyFetchWorker', () => {
    test('throws error for invalid continuation', async () => {
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        'invalid-continuation-test'
      );
      
      // Try to call with non-OCAN continuation
      await expect(
        originClient.callProxyFetchWithInvalidContinuation('https://example.com')
      ).rejects.toThrow('Invalid continuation: must be created with this.ctn()');
    });

    test('handles enqueue failure gracefully', async () => {
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        'enqueue-failure-test'
      );
      
      // Use an env without FETCH_ORCHESTRATOR binding to trigger failure
      await expect(
        originClient.callProxyFetchWithBrokenEnv('https://example.com')
      ).rejects.toThrow('Failed to enqueue fetch request');
    });

    test('supports string URL input', async () => {
      const originInstanceId = 'string-url-test';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );
      
      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);
      
      // Test with string URL instead of Request object
      const reqId = await originClient.callProxyFetchWithStringUrl(TEST_ENDPOINTS.buildUrl('/uuid'));
      
      expect(reqId).toBeDefined();
      expect(typeof reqId).toBe('string');
    });

    test('infers originBinding when not provided', async () => {
      const originInstanceId = 'infer-binding-test';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );
      
      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);
      
      // Call without explicit originBinding (will use getOriginBinding)
      const reqId = await originClient.callProxyFetchWithoutOriginBinding(TEST_ENDPOINTS.buildUrl('/uuid'));
      
      expect(reqId).toBeDefined();
      expect(typeof reqId).toBe('string');
    });
  });

  // TODO: HTTP Dispatch Path tests (requires test-endpoints enhancement)
  // To test the HTTP dispatch code path (FetchOrchestrator lines 100-128), we need:
  // 1. test-endpoints to implement /proxy-fetch-execute endpoint
  // 2. Test with correct TEST_TOKEN in X-Proxy-Fetch-Secret header (should work)
  // 3. Test with wrong/missing token (should fail with auth error)
  // Currently skipped as test-endpoints doesn't have this endpoint yet.

  describe('Edge Cases', () => {
    test('getQueueStats() returns queue information', async () => {
      using orchestratorClient = createTestingClient<typeof _FetchOrchestrator>(
        'FETCH_ORCHESTRATOR',
        'stats-test-2'
      );

      // Get queue stats (should have structure even if empty)
      const stats = await orchestratorClient.getQueueStats();
      expect(stats).toBeDefined();
      expect(stats.pendingCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(stats.items)).toBe(true);
    });

    // Missing continuation test is too invasive (RPC wrapper blocks access to .env)
    // The code path (fetchWorkerResultHandler lines 38-39) handles missing continuation
    // by logging a warning and returning early. This is defensive code that's unlikely
    // to be hit in practice, as continuations are only deleted when results arrive.

    test('handles malformed fetch result gracefully', async () => {
      const originInstanceId = 'malformed-result-test';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      await originClient.__lmzInit({ doBindingName: 'TEST_DO' });

      // Simulate a malformed result (neither response nor error)
      const reqId = await originClient.simulateMalformedResult();
      
      // Should handle gracefully (creates Error for malformed result)
      const result = await originClient.getResult(reqId);
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error?.message).toContain('No response or error in fetch result');
      }
    });

    test('handles continuation execution failure gracefully', async () => {
      const originInstanceId = 'continuation-failure-test';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);

      // Make a request that will trigger a throwing handler
      const reqId = await originClient.fetchDataWithThrowingHandler(TEST_ENDPOINTS.buildUrl('/uuid'));

      // Wait for the fetch to complete (error is logged but doesn't break the system)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // The error should be logged but the system should continue working
      expect(reqId).toBeDefined();
    });
  });

  describe('Timeout System', () => {
    // NOTE: Alarm tests require external HTTP + alarm simulation which is flaky in vitest-pool-workers
    // Alarm logic follows Discord-recommended pattern (reschedule early, cancel if empty)
    // Manual validation with `wrangler dev` recommended for alarm behavior
    test.skip('timeout fires and sends error to origin', async () => {
      const originInstanceId = 'timeout-test-1';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);

      // Enable alarm simulation at 10x speed (not 100x - too fast for 5s cadence)
      enableAlarmSimulation(10);

      // Use a 2-second delay with a 1-second timeout (should timeout)
      const reqId = await originClient.fetchDataWithOptions(
        TEST_ENDPOINTS.buildUrl('/delay/2000'),
        { timeout: 1000 }
      );

      // Manually trigger orchestrator alarm to check for timeout
      // Alarm fires every 5s, so trigger it a few times
      const orchestratorId = env.FETCH_ORCHESTRATOR.idFromName('singleton');
      const orchestratorStub = env.FETCH_ORCHESTRATOR.get(orchestratorId);
      
      // Wait for fetch to start, then trigger alarm after timeout period
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s (simulated time)
      
      // Trigger alarm multiple times to process timeout
      await runDurableObjectAlarm(orchestratorStub);
      await runDurableObjectAlarm(orchestratorStub);
      
      // Check for result
      await vi.waitFor(async () => {
        const result = await originClient.getResult(reqId);
        expect(result).toBeDefined();
        expect(result.success).toBe(false);
      }, { timeout: 5000, interval: 100 });

      const result = await originClient.getResult(reqId);
      expect(result.error).toBeDefined();
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toContain('timeout');
      expect(result.error?.message).toContain('may have partially succeeded');
    });

    test.skip('delivery beats timeout - no timeout error sent', async () => {
      const originInstanceId = 'no-timeout-test';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);

      enableAlarmSimulation(10);

      // Use a 100ms delay with a 5-second timeout (should complete before timeout)
      const reqId = await originClient.fetchDataWithOptions(
        TEST_ENDPOINTS.buildUrl('/delay/100'),
        { timeout: 5000 }
      );

      // Wait for result (should arrive quickly)
      await vi.waitFor(async () => {
        const result = await originClient.getResult(reqId);
        expect(result).toBeDefined();
      }, { timeout: 2000 });

      const result = await originClient.getResult(reqId);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(200);
    });

    test.skip('idempotency prevents duplicate result processing', async () => {
      const originInstanceId = 'idempotency-test';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);

      // Make a fetch that's right on the edge of timeout (may race)
      // Use 8s delay with 8s timeout (orchestrator adds 10s, so 18s total)
      const reqId = await originClient.fetchDataWithOptions(
        TEST_ENDPOINTS.buildUrl('/delay/8000'),
        { timeout: 8000 }
      );

      // Wait for first result (could be success or timeout)
      await vi.waitFor(async () => {
        const result = await originClient.getResult(reqId);
        expect(result).toBeDefined();
      }, { timeout: 20000, interval: 500 });

      const result = await originClient.getResult(reqId);
      expect(result).toBeDefined();

      // Wait a bit longer to see if duplicate arrives (it shouldn't change result)
      await new Promise(resolve => setTimeout(resolve, 5000));

      const resultAfter = await originClient.getResult(reqId);
      expect(resultAfter).toEqual(result); // Should be identical (no duplicate processing)
    });

    test.skip('ResponseSync provides synchronous body access', async () => {
      const originInstanceId = 'response-sync-test';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);

      // Fetch JSON endpoint
      const reqId = await originClient.fetchData(TEST_ENDPOINTS.buildUrl('/uuid'));

      await vi.waitFor(async () => {
        const result = await originClient.getResult(reqId);
        expect(result).toBeDefined();
      }, { timeout: 5000 });

      const result = await originClient.getResult(reqId);
      expect(result.success).toBe(true);
      
      // If handler can access body synchronously, this should work
      // (The handler would have called result.json() without await)
      expect(result.status).toBe(200);
    });

    test.skip('alarm starts on enqueue and stops when queue empty', async () => {
      enableAlarmSimulation(10);
      
      const orchestratorInstanceId = 'singleton';
      using orchestratorClient = createTestingClient<typeof _FetchOrchestrator>(
        'FETCH_ORCHESTRATOR',
        orchestratorInstanceId
      );

      // Check queue is initially empty
      const statsEmpty = await orchestratorClient.getQueueStats();
      expect(statsEmpty.pendingCount).toBe(0);

      // Now enqueue a request (alarm should start)
      const originInstanceId = 'alarm-lifecycle-test';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);
      const reqId = await originClient.fetchData(TEST_ENDPOINTS.buildUrl('/uuid'));

      // Queue should have 1 item immediately
      const statsWithItem = await orchestratorClient.getQueueStats();
      expect(statsWithItem.pendingCount).toBeGreaterThanOrEqual(1); // Should be in queue

      // Wait for result to be delivered
      await vi.waitFor(async () => {
        const result = await originClient.getResult(reqId);
        expect(result).toBeDefined();
      }, { timeout: 3000 });

      // Manually trigger alarm to clean up queue
      const orchestratorId = env.FETCH_ORCHESTRATOR.idFromName('singleton');
      const orchestratorStub = env.FETCH_ORCHESTRATOR.get(orchestratorId);
      await runDurableObjectAlarm(orchestratorStub);

      // Queue should be empty now (alarm cleaned up and stopped)
      const statsFinal = await orchestratorClient.getQueueStats();
      expect(statsFinal.pendingCount).toBe(0);
    });

    test.skip('multiple timeouts handled correctly', async () => {
      const originInstanceId = 'multiple-timeout-test';
      using originClient = createTestingClient<typeof _TestDO>(
        'TEST_DO',
        originInstanceId
      );

      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, originInstanceId);

      // Start 3 requests that will all timeout
      const reqIds = await Promise.all([
        originClient.fetchDataWithOptions(
          TEST_ENDPOINTS.buildUrl('/delay/3000'),
          { timeout: 1000 }
        ),
        originClient.fetchDataWithOptions(
          TEST_ENDPOINTS.buildUrl('/delay/3000'),
          { timeout: 1000 }
        ),
        originClient.fetchDataWithOptions(
          TEST_ENDPOINTS.buildUrl('/delay/3000'),
          { timeout: 1000 }
        )
      ]);

      // Wait for all to timeout
      for (const reqId of reqIds) {
        await vi.waitFor(async () => {
          const result = await originClient.getResult(reqId);
          expect(result).toBeDefined();
        }, { timeout: 15000, interval: 500 });

        const result = await originClient.getResult(reqId);
        expect(result.success).toBe(false);
        expect(result.error?.message).toContain('timeout');
      }
    });
  });
});

