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
import { createTestingClient } from '@lumenize/testing';
import { _TestDO, _FetchOrchestrator } from './test-worker-and-dos';
import { env } from 'cloudflare:test';
import { createTestEndpoints } from '@lumenize/test-endpoints';
import { handleProxyFetchExecution, ProxyFetchAuthError } from '../../src/index';

describe('ProxyFetchWorker Integration', () => {
  describe('Basic Flow', () => {
    test('successful fetch: origin DO gets Response', async () => {
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

    test('error handling: network error produces Error', async () => {
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

    test('HTTP error status: receives Response (not Error)', async () => {
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
    test('measures end-to-end latency', async () => {
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

      console.log('ProxyFetchWorker Latency Statistics:');
      console.log(`  Average: ${avgLatency.toFixed(2)}ms`);
      console.log(`  Min: ${minLatency}ms`);
      console.log(`  Max: ${maxLatency}ms`);
      console.log(`  All: ${durations.join(', ')}ms`);

      // Assertions
      // Note: avgLatency may be 0 in test environment due to clock behavior during I/O
      expect(avgLatency).toBeGreaterThanOrEqual(0);
      expect(avgLatency).toBeLessThan(5000); // Should be much faster than queue variant
      
      // Log for comparison
      console.log('✅ Target latency: 50-200ms (excluding external API time)');
    });

    test('comparison: multiple parallel requests', async () => {
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

      console.log(`Queued 10 requests in ${queueTime}ms`);

      // Wait for all to complete
      await vi.waitFor(async () => {
        for (const reqId of reqIds) {
          const result = await originClient.getResult(reqId);
          expect(result).toBeDefined();
        }
      }, { timeout: 30000 });

      const totalTime = Date.now() - startTime;
      console.log(`All 10 requests completed in ${totalTime}ms`);
      console.log(`Average time per request: ${(totalTime / 10).toFixed(2)}ms`);

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

      console.log('FetchOrchestrator queue stats:', initialStats);
    });
  });

  describe('Actor Model Behavior', () => {
    test('origin DO not blocked by fetch execution', async () => {
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

      console.log(`Request queued in ${queueDuration}ms`);

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

  describe('handleProxyFetchExecution', () => {
    test('returns undefined for non-matching path', async () => {
      const request = new Request('https://example.com/other-path', {
        method: 'POST',
      });
      
      const response = await handleProxyFetchExecution(request, env);
      expect(response).toBeUndefined();
    });

    test('throws ProxyFetchAuthError when secret not configured', async () => {
      const request = new Request('https://example.com/proxy-fetch-execute', {
        method: 'POST',
        headers: {
          'X-Proxy-Fetch-Secret': 'some-secret'
        },
      });
      
      // Create env without PROXY_FETCH_SECRET
      const envWithoutSecret = { ...env };
      delete envWithoutSecret.PROXY_FETCH_SECRET;
      
      await expect(
        handleProxyFetchExecution(request, envWithoutSecret)
      ).rejects.toThrow(ProxyFetchAuthError);
      
      await expect(
        handleProxyFetchExecution(request, envWithoutSecret)
      ).rejects.toThrow('PROXY_FETCH_SECRET not configured');
    });

    test('throws ProxyFetchAuthError when secret is missing', async () => {
      const request = new Request('https://example.com/proxy-fetch-execute', {
        method: 'POST',
        // No X-Proxy-Fetch-Secret header
      });
      
      await expect(
        handleProxyFetchExecution(request, env)
      ).rejects.toThrow(ProxyFetchAuthError);
      
      await expect(
        handleProxyFetchExecution(request, env)
      ).rejects.toThrow('Invalid or missing X-Proxy-Fetch-Secret header');
    });

    test('throws ProxyFetchAuthError when secret is invalid', async () => {
      const request = new Request('https://example.com/proxy-fetch-execute', {
        method: 'POST',
        headers: {
          'X-Proxy-Fetch-Secret': 'wrong-secret'
        },
      });
      
      await expect(
        handleProxyFetchExecution(request, env)
      ).rejects.toThrow(ProxyFetchAuthError);
    });

    test('returns 400 for invalid JSON body', async () => {
      const request = new Request('https://example.com/proxy-fetch-execute', {
        method: 'POST',
        headers: {
          'X-Proxy-Fetch-Secret': env.PROXY_FETCH_SECRET,
          'Content-Type': 'application/json'
        },
        body: 'not valid json{',
      });
      
      const response = await handleProxyFetchExecution(request, env);
      expect(response).toBeDefined();
      expect(response?.status).toBe(400);
      const text = await response?.text();
      expect(text).toBe('Invalid JSON body');
    });

    test('uses custom path option', async () => {
      const request = new Request('https://example.com/custom-fetch', {
        method: 'POST',
      });
      
      // Should match custom path and attempt auth (will fail without secret)
      await expect(
        handleProxyFetchExecution(request, env, { path: '/custom-fetch' })
      ).rejects.toThrow(ProxyFetchAuthError);
    });

    test('uses custom secretEnvVar option', async () => {
      const request = new Request('https://example.com/proxy-fetch-execute', {
        method: 'POST',
        headers: {
          'X-Proxy-Fetch-Secret': 'test-custom-secret'
        },
      });
      
      const customEnv = {
        ...env,
        CUSTOM_SECRET: 'test-custom-secret'
      };
      delete customEnv.PROXY_FETCH_SECRET;
      
      // Should look for CUSTOM_SECRET instead of PROXY_FETCH_SECRET
      // Will fail at JSON parsing since we have valid auth but no body
      const response = await handleProxyFetchExecution(request, customEnv, {
        secretEnvVar: 'CUSTOM_SECRET'
      });
      
      expect(response).toBeDefined();
      expect(response?.status).toBe(400); // Invalid JSON body
    });

    test('ProxyFetchAuthError has correct properties', () => {
      const error = new ProxyFetchAuthError('Test message');
      
      expect(error.message).toBe('Test message');
      expect(error.name).toBe('ProxyFetchAuthError');
      expect(error.code).toBe('PROXY_FETCH_AUTH_ERROR');
      expect(error.httpErrorCode).toBe(401);
      expect(error instanceof Error).toBe(true);
    });

    test('successfully handles valid request', async () => {
      const request = new Request('https://example.com/proxy-fetch-execute', {
        method: 'POST',
        headers: {
          'X-Proxy-Fetch-Secret': env.PROXY_FETCH_SECRET,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          reqId: 'test-valid-req',
          url: 'https://httpbin.org/delay/0',
          originDoBinding: 'TEST_DO',
          originInstanceId: 'valid-test-origin',
          continuationChain: []
        }),
      });
      
      const response = await handleProxyFetchExecution(request, env);
      
      // Should return 200 for successful execution
      expect(response).toBeDefined();
      expect(response?.status).toBe(200);
      const text = await response?.text();
      expect(text).toBe('OK');
    });
  });
});

