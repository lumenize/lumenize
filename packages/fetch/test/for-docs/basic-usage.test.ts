/**
 * Pedagogical tests for @lumenize/fetch documentation examples
 * These tests are referenced in website/docs/fetch/index.mdx
 */
import { describe, test, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { createTestEndpoints } from '@lumenize/test-endpoints';

describe('Fetch - Quick Start Example', () => {
  test('handles successful response', async () => {
    const stub = env.FETCH_EXAMPLE_DO.getByName('quick-start-success');
    await stub.clearResults();
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'quick-start-success');
    const url = testEndpoints.buildUrl('/uuid');

    await stub.fetchUrl(url);

    // Wait for result to arrive (external network call needs longer timeout)
    const result = await vi.waitFor(async () => {
      const r = await stub.getLastResult();
      expect(r).toBeDefined();
      return r;
    }, { timeout: 5000 });

    expect(result.type).toBe('success');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toHaveProperty('uuid');
  });

  test('handles network error', async () => {
    const stub = env.FETCH_EXAMPLE_DO.getByName('quick-start-error');
    await stub.clearResults();
    const url = 'https://definitely-does-not-exist-12345.invalid';

    await stub.fetchUrl(url);

    // Wait for error result (DNS failure is fast, default timeout is fine)
    const result = await vi.waitFor(async () => {
      const r = await stub.getLastResult();
      expect(r).toBeDefined();
      return r;
    });

    expect(result.type).toBe('error');
    expect(result.message).toBeDefined();
  });

  test('handles HTTP 404 as ResponseSync (not Error)', async () => {
    const stub = env.FETCH_EXAMPLE_DO.getByName('quick-start-404');
    await stub.clearResults();
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'quick-start-404');
    const url = testEndpoints.buildUrl('/status/404');

    await stub.fetchUrl(url);

    // Wait for result (external network call needs longer timeout)
    const result = await vi.waitFor(async () => {
      const r = await stub.getLastResult();
      expect(r).toBeDefined();
      return r;
    }, { timeout: 5000 });

    expect(result.type).toBe('success');  // HTTP errors are still ResponseSync
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
  });
});

describe('Fetch - Retry Pattern Example', () => {
  test('succeeds on first attempt when server responds', async () => {
    const stub = env.RETRY_EXAMPLE_DO.getByName('retry-success');
    await stub.clearResults();
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'retry-success');
    const url = testEndpoints.buildUrl('/uuid');

    await stub.fetchWithRetry(url);

    // Wait for result (external network call needs longer timeout)
    const result = await vi.waitFor(async () => {
      const r = await stub.getLastResult();
      expect(r).toBeDefined();
      return r;
    }, { timeout: 5000 });

    expect(result.type).toBe('success');
    expect(result.attempts).toBe(1);
    expect(result.data).toHaveProperty('uuid');
  });

  test('retries on network error up to 3 times', async () => {
    const stub = env.RETRY_EXAMPLE_DO.getByName('retry-network-error');
    await stub.clearResults();
    const url = 'https://definitely-does-not-exist-12345.invalid';

    await stub.fetchWithRetry(url);

    // Wait for final result after all 3 retries (DNS failures are fast)
    const result = await vi.waitFor(async () => {
      const r = await stub.getLastResult();
      if (r && r.attempts === 3) return r;
      throw new Error('Still retrying...');
    });

    expect(result.type).toBe('error');
    expect(result.attempts).toBe(3);
  });

  test('retries on 5xx server error', async () => {
    const stub = env.RETRY_EXAMPLE_DO.getByName('retry-500');
    await stub.clearResults();
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'retry-500');
    const url = testEndpoints.buildUrl('/status/500');

    await stub.fetchWithRetry(url);

    // Wait for final result after all 3 retries (external network, needs longer timeout)
    const result = await vi.waitFor(async () => {
      const r = await stub.getLastResult();
      if (r && r.attempts === 3) return r;
      throw new Error('Still retrying...');
    }, { timeout: 10000 });

    expect(result.type).toBe('http_error');
    expect(result.status).toBe(500);
    expect(result.attempts).toBe(3);
  });

  test('does not retry on 4xx client error', async () => {
    const stub = env.RETRY_EXAMPLE_DO.getByName('retry-400');
    await stub.clearResults();
    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'retry-400');
    const url = testEndpoints.buildUrl('/status/400');

    await stub.fetchWithRetry(url);

    // Wait for result (external network call needs longer timeout)
    const result = await vi.waitFor(async () => {
      const r = await stub.getLastResult();
      expect(r).toBeDefined();
      return r;
    }, { timeout: 5000 });

    expect(result.type).toBe('http_error');
    expect(result.status).toBe(400);
    expect(result.attempts).toBe(1);  // No retry for 4xx
  });
});
