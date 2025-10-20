import { describe, it, expect } from 'vitest';
import { createRpcClient } from '@lumenize/rpc';
import type { Counter } from '../src/index.js';
import '@transformation-dev/debug'; // Auto-disables console.debug on import

describe('Performance Comparison: Lumenize vs Cap\'n Web', () => {
  const testId = `perf-test-${Date.now()}`;

  describe('Lumenize RPC Performance', () => {
    it('should measure increment operations', async () => {
      await using counter = createRpcClient<Counter>(
        'COUNTER_LUMENIZE',
        testId
      );
      
      // Ensure clean state
      await counter.reset();

      const iterations = 100;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        await counter.increment(1);
      }

      const end = performance.now();
      const totalMs = end - start;
      const avgMs = totalMs / iterations;

      console.log(`\nLumenize RPC - ${iterations} increments:`);
      console.log(`  Total: ${totalMs.toFixed(2)}ms`);
      console.log(`  Average: ${avgMs.toFixed(3)}ms per operation`);
      console.log(`  Throughput: ${(1000 / avgMs).toFixed(1)} ops/sec`);

      const finalValue = await counter.getValue();
      expect(finalValue).toBe(iterations);
    });

    it('should measure getValue operations', async () => {
      await using counter = createRpcClient<Counter>(
        'COUNTER_LUMENIZE',
        testId
      );

      // Set initial value
      await counter.increment(42);

      const iterations = 100;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        await counter.getValue();
      }

      const end = performance.now();
      const totalMs = end - start;
      const avgMs = totalMs / iterations;

      console.log(`\nLumenize RPC - ${iterations} getValue calls:`);
      console.log(`  Total: ${totalMs.toFixed(2)}ms`);
      console.log(`  Average: ${avgMs.toFixed(3)}ms per operation`);
      console.log(`  Throughput: ${(1000 / avgMs).toFixed(1)} ops/sec`);
    });

    it('should measure mixed operations', async () => {
      await using counter = createRpcClient<Counter>(
        'COUNTER_LUMENIZE',
        testId
      );

      const iterations = 50;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        await counter.increment(1);
        await counter.getValue();
      }

      const end = performance.now();
      const totalMs = end - start;
      const totalOps = iterations * 2;
      const avgMs = totalMs / totalOps;

      console.log(`\nLumenize RPC - ${iterations} mixed operations (increment + getValue):`);
      console.log(`  Total: ${totalMs.toFixed(2)}ms (${totalOps} operations)`);
      console.log(`  Average: ${avgMs.toFixed(3)}ms per operation`);
      console.log(`  Throughput: ${(1000 / avgMs).toFixed(1)} ops/sec`);
    });
  });

  describe.skip('Cap\'n Web Performance', () => {
    it.skip('TODO: Implement after installing @cloudflare/jsrpc', async () => {
      // Will implement after adding Cap'n Web dependency
    });
  });
});
