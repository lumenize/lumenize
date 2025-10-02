import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient } from '@lumenize/rpc';

import { CounterDO } from '../src/index';
type Counter = InstanceType<typeof CounterDO>;

describe('Counter RPC', () => {
  it('should increment the counter', async () => {
    // Create RPC client pointing to our test environment
    const client = createRpcClient<Counter>({
      transport: 'http',
      baseUrl: 'http://test',
      doBindingName: 'COUNTER',
      doInstanceNameOrId: 'test-counter',
      prefix: '__rpc',
      fetch: SELF.fetch.bind(SELF),
    });
    
    // Test increment
    const result1 = await client.increment();
    expect(result1).toBe(1);
    
    // Test again
    const result2 = await client.increment();
    expect(result2).toBe(2);
    
    // Verify getValue
    const value = await client.getValue();
    expect(value).toBe(2);
  });
});