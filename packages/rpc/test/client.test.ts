import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, type RpcClientConfig } from '../src/index';

import { ExampleDO } from './test-worker-and-dos';
type ExampleDO = InstanceType<typeof ExampleDO>;

// Base configuration shared across all tests
const baseConfig: Omit<RpcClientConfig, 'doInstanceNameOrId'> = {
  transport: 'http', // Use HTTP transport for now (WebSocket not yet implemented)
  doBindingName: 'example-do',
  baseUrl: 'https://fake-host.com',
  prefix: '__rpc',
  fetch: SELF.fetch.bind(SELF),
};

describe('RPC client-side functionality', () => {

  // KEPT: HTTP-specific baseline test (matrix tests focus on behavior patterns, not HTTP baseline)
  it('should execute simple RPC calls via client proxy', async () => {
    // Create RPC client for the DO instance
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'simple-rpc-call',
    });

    // Execute simple method call through proxy
    const result = await client.increment();

    expect(result).toBe(1);
  });

  // KEPT: Custom configuration testing (timeout, headers) - unique to this test
  it('should handle custom configuration options', async () => {
    // Create client with custom configuration
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'config-test',
      timeout: 5000,
      headers: {
        'Authorization': 'Bearer test-token',
        'X-Custom-Header': 'test-value'
      },
    });

    // Execute simple call to verify config is applied
    const result = await client.increment();

    expect(result).toBe(1);
  });

  // KEPT: DO internal routing preservation - edge case not covered by matrix
  it('should not interfere with DO internal routing', async () => {
    // Test that lumenizeRpcDo doesn't break the DO's original fetch routing
    // Make a direct (non-RPC) request to the DO's /increment endpoint using routeDORequest path format
    const doId = 'direct-routing-test';
    const url = `https://fake-host.com/example-do/${doId}/increment`;
    
    const response = await SELF.fetch(url);
    
    expect(response.status).toBe(200);
    const text = await response.text();
    const count = parseInt(text);
    expect(count).toBeGreaterThan(0); // Should return incremented count from DO's fetch method
  });
});