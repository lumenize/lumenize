import { describe, it, expect } from 'vitest';
import { createTestingClient, Browser } from '@lumenize/testing';
import { TestEndpointsDO } from './test-harness';
// @ts-expect-error - cloudflare:test types not available at compile time
import { env } from 'cloudflare:test';

describe('TestEndpointsDO Basic Functionality', () => {
  it('handles /uuid endpoint and tracks request', async () => {
    // Create testing client
    using client = createTestingClient<typeof TestEndpointsDO>(
      'TEST_ENDPOINTS_DO',
      'basic-test'
    );

    // Make a request to /uuid endpoint
    const browser = new Browser();
    const response = await browser.fetch(
      `https://test.com/test-endpoints-do/basic-test/uuid?token=${env.TEST_TOKEN}`
    );

    // Verify response
    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data).toHaveProperty('uuid');
    expect(typeof data.uuid).toBe('string');

    // Verify tracking worked - check stats via RPC
    const count = await client.ctx.storage.kv.get('stats:count');
    expect(count).toBe(1);

    // Verify last request was stored and auto-deserialized by RPC
    const lastRequest = await client.ctx.storage.kv.get('request:last');
    expect(lastRequest).toBeDefined();
    expect(lastRequest).toBeInstanceOf(Request);
    expect(lastRequest!.url).toContain('/uuid');
  });

  it('respects stopTracking() and resetTracking()', async () => {
    using client = createTestingClient<typeof TestEndpointsDO>(
      'TEST_ENDPOINTS_DO',
      'tracking-test'
    );

    const browser = new Browser();
    const url = `https://test.com/test-endpoints-do/tracking-test/uuid?token=${env.TEST_TOKEN}`;

    // Make first request - should be tracked
    await browser.fetch(url);
    expect(await client.ctx.storage.kv.get('stats:count')).toBe(1);

    // Stop tracking
    await client.stopTracking();

    // Make second request - should NOT be tracked
    await browser.fetch(url);
    expect(await client.ctx.storage.kv.get('stats:count')).toBe(1); // Still 1

    // Reset tracking
    await client.resetTracking();
    expect(await client.ctx.storage.kv.get('stats:count')).toBeUndefined();

    // Make third request - tracking is reset (back to default: on)
    await browser.fetch(url);
    expect(await client.ctx.storage.kv.get('stats:count')).toBe(1);
  });
});

