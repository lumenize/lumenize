import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRpcClient } from '@lumenize/rpc';
import { newWebSocketRpcSession } from 'capnweb';
import type { Counter } from '../src/index.js';
// import '@transformation-dev/debug'; // TEMPORARILY DISABLED to see performance timings

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

  describe('Cap\'n Web Performance', () => {
    const capnTestId = `capn-test-${Date.now()}`;

    it('should measure increment operations', async () => {
      // Create fresh WebSocket session for this test
      const wsUrl = `ws://localhost:8787/__rpc/COUNTER_CAPNWEB/${capnTestId}/call`;
      const capnSession = newWebSocketRpcSession<Counter>(wsUrl);
      
      try {
        // Ensure clean state
        await capnSession.reset();

        const iterations = 100;
        const start = performance.now();

        for (let i = 0; i < iterations; i++) {
          await capnSession.increment(1);
        }

        const end = performance.now();
        const totalMs = end - start;
        const avgMs = totalMs / iterations;

        console.log(`\nCap'n Web - ${iterations} increments:`);
        console.log(`  Total: ${totalMs.toFixed(2)}ms`);
        console.log(`  Average: ${avgMs.toFixed(3)}ms per operation`);
        console.log(`  Throughput: ${(1000 / avgMs).toFixed(1)} ops/sec`);

        const finalValue = await capnSession.getValue();
        expect(finalValue).toBe(iterations);
      } finally {
        capnSession[Symbol.dispose]();
      }
    });

    it('should measure getValue operations', async () => {
      // Create fresh WebSocket session for this test
      const wsUrl = `ws://localhost:8787/__rpc/COUNTER_CAPNWEB/${capnTestId}/call`;
      const capnSession = newWebSocketRpcSession<Counter>(wsUrl);
      
      try {
        // Set initial value
        await capnSession.increment(42);

        const iterations = 100;
        const start = performance.now();

        for (let i = 0; i < iterations; i++) {
          await capnSession.getValue();
        }

        const end = performance.now();
        const totalMs = end - start;
        const avgMs = totalMs / iterations;

        console.log(`\nCap'n Web - ${iterations} getValue calls:`);
        console.log(`  Total: ${totalMs.toFixed(2)}ms`);
        console.log(`  Average: ${avgMs.toFixed(3)}ms per operation`);
        console.log(`  Throughput: ${(1000 / avgMs).toFixed(1)} ops/sec`);
      } finally {
        capnSession[Symbol.dispose]();
      }
    });

    it('should measure mixed operations', async () => {
      // Create fresh WebSocket session for this test
      const wsUrl = `ws://localhost:8787/__rpc/COUNTER_CAPNWEB/${capnTestId}/call`;
      const capnSession = newWebSocketRpcSession<Counter>(wsUrl);
      
      try {
        const iterations = 50;
        const start = performance.now();

        for (let i = 0; i < iterations; i++) {
          await capnSession.increment(1);
          await capnSession.getValue();
        }

        const end = performance.now();
        const totalMs = end - start;
        const totalOps = iterations * 2;
        const avgMs = totalMs / totalOps;

        console.log(`\nCap'n Web - ${iterations} mixed operations (increment + getValue):`);
        console.log(`  Total: ${totalMs.toFixed(2)}ms (${totalOps} operations)`);
        console.log(`  Average: ${avgMs.toFixed(3)}ms per operation`);
        console.log(`  Throughput: ${(1000 / avgMs).toFixed(1)} ops/sec`);
      } finally {
        capnSession[Symbol.dispose]();
      }
    });
  });
});
