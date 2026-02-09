import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createRpcClient, createHttpTransport } from '../src/index';
import { ExampleDO } from './test-worker-and-dos';
type ExampleDO = InstanceType<typeof ExampleDO>;

/**
 * Test that two independent identical calls are NOT treated as prefix relationships.
 * This verifies that we use proxy lineage tracking instead of operation content comparison.
 */
describe('Independent Identical Calls', () => {
  it('should execute two independent identical calls separately (not filter as prefix)', async () => {
    using client = createRpcClient<ExampleDO>({
      transport: createHttpTransport('EXAMPLE_DO', 'independent-identical-test', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        fetch: SELF.fetch.bind(SELF),
      })
    });

    // These are TWO INDEPENDENT calls with identical operations
    // They should BOTH execute, not be filtered as a prefix relationship
    const p1 = client.increment();
    const p2 = client.increment();

    // Both should execute and increment the counter
    const [r1, r2] = await Promise.all([p1, p2]);

    // Both calls completed - counter should be 2
    expect(r1).toBe(1);
    expect(r2).toBe(2);
  });

  it('should execute two independent identical chains separately', async () => {
    using client = createRpcClient<ExampleDO>({
      transport: createHttpTransport('EXAMPLE_DO', 'independent-chains-test', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        fetch: SELF.fetch.bind(SELF),
      })
    });

    // Two INDEPENDENT chains with identical operations
    // Each should add 5+3 independently
    const p1 = client.add(5, 3);
    const p2 = client.add(5, 3);

    const [r1, r2] = await Promise.all([p1, p2]);

    // Both chains should execute independently and return 8
    expect(r1).toBe(8);
    expect(r2).toBe(8);
  });
});
