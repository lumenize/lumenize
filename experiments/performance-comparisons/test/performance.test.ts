import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRpcClient } from '@lumenize/rpc';
import { newWebSocketRpcSession } from 'capnweb';
import type { Counter } from '../src/index.js';
// import '@transformation-dev/debug'; // TEMPORARILY DISABLED to see performance timings

// ============================================================================
// MANUAL TEST CONFIGURATION
// Enable ONE configuration at a time, run tests 3 times, record results
// ============================================================================

const TEST_CONFIG = {
  // 🔴 ENABLE ONE AT A TIME:
  LUMENIZE_WITH_ROUTE_DO_REQUEST: false,   // Config 1: Lumenize with routeDORequest helper
  LUMENIZE_WITH_MANUAL_ROUTING: false,     // Config 2: Lumenize with simple manual routing  
  CAPNWEB_WITH_MANUAL_ROUTING: true,       // Config 3: Cap'n Web with simple manual routing
};

describe("Performance Comparison: Routing Patterns", () => {
  const testId = `perf-test-${Date.now()}`;

  // ========================================================================
  // Configuration 1: Lumenize RPC with routeDORequest
  // Worker uses: routeDORequest(request, env, { prefix: '/__rpc' })
  // URL pattern: ws://localhost:8787/__rpc/COUNTER_LUMENIZE/{id}/call
  // ========================================================================
  if (TEST_CONFIG.LUMENIZE_WITH_ROUTE_DO_REQUEST) {
    describe('Config 1: Lumenize RPC with routeDORequest', () => {
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

        console.log(`\n[Config 1] Lumenize with routeDORequest - ${iterations} increments:`);
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

        console.log(`\n[Config 1] Lumenize with routeDORequest - ${iterations} getValue calls:`);
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

        console.log(`\n[Config 1] Lumenize with routeDORequest - ${iterations} mixed operations:`);
        console.log(`  Total: ${totalMs.toFixed(2)}ms (${totalOps} operations)`);
        console.log(`  Average: ${avgMs.toFixed(3)}ms per operation`);
        console.log(`  Throughput: ${(1000 / avgMs).toFixed(1)} ops/sec`);
      });
    });
  }

  // ========================================================================
  // Configuration 2: Lumenize RPC with Manual Routing
  // Worker uses: Manual regex match on /__rpc/COUNTER_LUMENIZE/{id}/call
  // URL pattern: ws://localhost:8787/__rpc/COUNTER_LUMENIZE/{id}/call
  // (Same URL as Config 1, but Worker uses simple regex instead of routeDORequest)
  // ========================================================================
  if (TEST_CONFIG.LUMENIZE_WITH_MANUAL_ROUTING) {
    describe('Config 2: Lumenize RPC with Manual Routing', () => {
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

        console.log(`\n[Config 2] Lumenize with manual routing - ${iterations} increments:`);
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

        console.log(`\n[Config 2] Lumenize with manual routing - ${iterations} getValue calls:`);
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

        console.log(`\n[Config 2] Lumenize with manual routing - ${iterations} mixed operations:`);
        console.log(`  Total: ${totalMs.toFixed(2)}ms (${totalOps} operations)`);
        console.log(`  Average: ${avgMs.toFixed(3)}ms per operation`);
        console.log(`  Throughput: ${(1000 / avgMs).toFixed(1)} ops/sec`);
      });
    });
  }

  // ========================================================================
  // Configuration 3: Cap'n Web with Manual Routing
  // Worker uses: Manual regex match on /COUNTER_CAPNWEB/{id}
  // URL pattern: ws://localhost:8787/COUNTER_CAPNWEB/{id}
  // ========================================================================
  if (TEST_CONFIG.CAPNWEB_WITH_MANUAL_ROUTING) {
    describe("Config 3: Cap'n Web with Manual Routing", () => {
      const capnTestId = `perf-capn-${Date.now()}`;

      it('should measure increment operations', async () => {
        // Create fresh WebSocket session for this test
        const wsUrl = `ws://localhost:8787/COUNTER_CAPNWEB/${capnTestId}`;
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

          console.log(`\n[Config 3] Cap'n Web with manual routing - ${iterations} increments:`);
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
        const wsUrl = `ws://localhost:8787/COUNTER_CAPNWEB/${capnTestId}`;
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

          console.log(`\n[Config 3] Cap'n Web with manual routing - ${iterations} getValue calls:`);
          console.log(`  Total: ${totalMs.toFixed(2)}ms`);
          console.log(`  Average: ${avgMs.toFixed(3)}ms per operation`);
          console.log(`  Throughput: ${(1000 / avgMs).toFixed(1)} ops/sec`);
        } finally {
          capnSession[Symbol.dispose]();
        }
      });

      it('should measure mixed operations', async () => {
        // Create fresh WebSocket session for this test
        const wsUrl = `ws://localhost:8787/COUNTER_CAPNWEB/${capnTestId}`;
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

          console.log(`\n[Config 3] Cap'n Web with manual routing - ${iterations} mixed operations:`);
          console.log(`  Total: ${totalMs.toFixed(2)}ms (${totalOps} operations)`);
          console.log(`  Average: ${avgMs.toFixed(3)}ms per operation`);
          console.log(`  Throughput: ${(1000 / avgMs).toFixed(1)} ops/sec`);
        } finally {
          capnSession[Symbol.dispose]();
        }
      });
    });
  }
});
