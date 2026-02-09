import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createRpcClient, createHttpTransport } from '../src/index';
import { PipeliningDO } from './test-worker-and-dos';

type PipeliningDO = InstanceType<typeof PipeliningDO>;

describe('Promise Pipelining', () => {

  describe('Basic Functionality', () => {
    it('should execute increment() and return 1', async () => {
      using client = createRpcClient<PipeliningDO>({
        transport: createHttpTransport('PIPELINING_DO', 'basic-test', {
          baseUrl: 'https://fake-host.com',
          prefix: '__rpc',
          fetch: SELF.fetch.bind(SELF),
        })
      });
      
      const result = await client.increment();
      expect(result).toBe(1);
    });

    it('should execute increment(5) and return 6', async () => {
      using client = createRpcClient<PipeliningDO>({
        transport: createHttpTransport('PIPELINING_DO', 'basic-test-2', {
          baseUrl: 'https://fake-host.com',
          prefix: '__rpc',
          fetch: SELF.fetch.bind(SELF),
        })
      });
      
      const result = await client.increment(5);
      expect(result).toBe(5); // 0 + 5 = 5
    });
  });

  describe('Integration: Geometric Progression', () => {
    it('should execute pipelined operations in single round trip', async () => {
      using client = createRpcClient<PipeliningDO>({
        transport: createHttpTransport('PIPELINING_DO', 'geometric', {
          baseUrl: 'https://fake-host.com',
          prefix: '__rpc',
          fetch: SELF.fetch.bind(SELF),
        })
      });
      
      // Geometric progression using promise pipelining:
      // Each increment adds the count parameter to current storage value
      const first = client.increment();           // increment() → 1 (default count=1)
      const second = client.increment(first);     // increment(1) → 2 (current 1 + arg 1)
      const final = await client.increment(second);  // increment(2) → 4 (current 2 + arg 2)
      
      expect(final).toBe(4);
    });
  });
});
