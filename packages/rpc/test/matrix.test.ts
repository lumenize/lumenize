/**
 * Matrix Testing for RPC
 * 
 * Runs all behavior tests through all combinations of:
 * - Transport: WebSocket vs HTTP
 * - Instrumentation: lumenizeRpcDO vs handleRpcRequest
 * 
 * This ensures consistent behavior across all configurations.
 */

import { describe, it, beforeEach, afterEach } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, type RpcAccessible } from '../src/index';
import { getWebSocketShim } from '@lumenize/utils';
import { ExampleDO } from './test-worker-and-dos';
import { behaviorTests, testCategories, type TestableClient } from './shared/behavior-tests';
import { batchingTests, type TestableClientWithMetrics } from './shared/batching-tests';
import type { Metrics } from '@lumenize/utils';

type ExampleDOType = RpcAccessible<InstanceType<typeof ExampleDO>>;

/**
 * Matrix configuration
 * Each combination represents a unique way to access the DO via RPC
 */
const MATRIX = [
  {
    name: 'WebSocket + lumenizeRpcDO',
    transport: 'websocket' as const,
    doBindingName: 'example-do',
    description: 'WebSocket transport with lumenizeRpcDO factory wrapper',
  },
  {
    name: 'WebSocket + handleRpcRequest',
    transport: 'websocket' as const,
    doBindingName: 'manual-routing-do',
    description: 'WebSocket transport with manual handleRpcRequest routing',
  },
  {
    name: 'HTTP + lumenizeRpcDO',
    transport: 'http' as const,
    doBindingName: 'example-do',
    description: 'HTTP transport with lumenizeRpcDO factory wrapper',
  },
  {
    name: 'HTTP + handleRpcRequest',
    transport: 'http' as const,
    doBindingName: 'manual-routing-do',
    description: 'HTTP transport with manual handleRpcRequest routing',
  },
] as const;

/**
 * Create an RPC client for a given matrix configuration
 */
function createMatrixClient(config: typeof MATRIX[number], instanceId: string, metrics?: Metrics): TestableClient<ExampleDOType> {
  const baseConfig = {
    transport: config.transport,
    baseUrl: 'https://fake-host.com',
    prefix: '__rpc',
  } as const;

  // Add transport-specific config
  if (config.transport === 'websocket') {
    (baseConfig as any).WebSocketClass = getWebSocketShim(SELF.fetch.bind(SELF), { metrics });
  } else {
    // For HTTP, we need to create a Browser-like wrapper with metrics
    if (metrics) {
      const fetchWithMetrics = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        metrics.httpRequests = (metrics.httpRequests ?? 0) + 1;
        metrics.roundTrips = (metrics.roundTrips ?? 0) + 1;
        
        const request = new Request(input, init);
        
        // Track request payload size
        if (request.body) {
          try {
            const clone = request.clone();
            const arrayBuffer = await clone.arrayBuffer();
            metrics.payloadBytesSent = (metrics.payloadBytesSent ?? 0) + arrayBuffer.byteLength;
          } catch {
            // If body can't be read, skip tracking
          }
        }
        
        const response = await SELF.fetch(request);
        
        // Track response payload size
        try {
          const clone = response.clone();
          const arrayBuffer = await clone.arrayBuffer();
          metrics.payloadBytesReceived = (metrics.payloadBytesReceived ?? 0) + arrayBuffer.byteLength;
        } catch {
          // If body can't be read, skip tracking
        }
        
        return response;
      };
      (baseConfig as any).fetch = fetchWithMetrics;
    } else {
      (baseConfig as any).fetch = SELF.fetch.bind(SELF);
    }
  }

  const client = createRpcClient<ExampleDOType>(config.doBindingName, instanceId, baseConfig);

  return {
    client,
    cleanup: () => {
      client[Symbol.dispose]();
    },
  };
}

/**
 * Run all behavior tests for each matrix configuration
 */
MATRIX.forEach((matrixConfig) => {
  describe(`Matrix: ${matrixConfig.name}`, () => {
    describe('Basic Operations', () => {
      testCategories.basic.forEach((testName) => {
        it(testName, async () => {
          const instanceId = `matrix-${matrixConfig.doBindingName}-${testName}-${Date.now()}`;
          const testable = createMatrixClient(matrixConfig, instanceId);
          try {
            await behaviorTests[testName as keyof typeof behaviorTests](testable);
          } finally {
            if (testable.cleanup) await testable.cleanup();
          }
        });
      });
    });

    describe('Error Handling', () => {
      testCategories.errors.forEach((testName) => {
        it(testName, async () => {
          const instanceId = `matrix-${matrixConfig.doBindingName}-${testName}-${Date.now()}`;
          const testable = createMatrixClient(matrixConfig, instanceId);
          try {
            await behaviorTests[testName as keyof typeof behaviorTests](testable);
          } finally {
            if (testable.cleanup) await testable.cleanup();
          }
        });
      });
    });

    describe('Object Handling', () => {
      testCategories.objects.forEach((testName) => {
        it(testName, async () => {
          const instanceId = `matrix-${matrixConfig.doBindingName}-${testName}-${Date.now()}`;
          const testable = createMatrixClient(matrixConfig, instanceId);
          try {
            await behaviorTests[testName as keyof typeof behaviorTests](testable);
          } finally {
            if (testable.cleanup) await testable.cleanup();
          }
        });
      });
    });

    describe('Array Handling', () => {
      testCategories.arrays.forEach((testName) => {
        it(testName, async () => {
          const instanceId = `matrix-${matrixConfig.doBindingName}-${testName}-${Date.now()}`;
          const testable = createMatrixClient(matrixConfig, instanceId);
          try {
            await behaviorTests[testName as keyof typeof behaviorTests](testable);
          } finally {
            if (testable.cleanup) await testable.cleanup();
          }
        });
      });
    });

    describe('Class Instances', () => {
      testCategories.classes.forEach((testName) => {
        it(testName, async () => {
          const instanceId = `matrix-${matrixConfig.doBindingName}-${testName}-${Date.now()}`;
          const testable = createMatrixClient(matrixConfig, instanceId);
          try {
            await behaviorTests[testName as keyof typeof behaviorTests](testable);
          } finally {
            if (testable.cleanup) await testable.cleanup();
          }
        });
      });
    });

    describe('Circular References', () => {
      testCategories.circularRefs.forEach((testName) => {
        it(testName, async () => {
          const instanceId = `matrix-${matrixConfig.doBindingName}-${testName}-${Date.now()}`;
          const testable = createMatrixClient(matrixConfig, instanceId);
          try {
            await behaviorTests[testName as keyof typeof behaviorTests](testable);
          } finally {
            if (testable.cleanup) await testable.cleanup();
          }
        });
      });
    });

    describe('Object Inspection', () => {
      testCategories.inspection.forEach((testName) => {
        it(testName, async () => {
          const instanceId = `matrix-${matrixConfig.doBindingName}-${testName}-${Date.now()}`;
          const testable = createMatrixClient(matrixConfig, instanceId);
          try {
            await behaviorTests[testName as keyof typeof behaviorTests](testable);
          } finally {
            if (testable.cleanup) await testable.cleanup();
          }
        });
      });
    });

    describe('Async Operations', () => {
      testCategories.async.forEach((testName) => {
        it(testName, async () => {
          const instanceId = `matrix-${matrixConfig.doBindingName}-${testName}-${Date.now()}`;
          const testable = createMatrixClient(matrixConfig, instanceId);
          try {
            await behaviorTests[testName as keyof typeof behaviorTests](testable);
          } finally {
            if (testable.cleanup) await testable.cleanup();
          }
        });
      });
    });

    describe('Web API Objects', () => {
      testCategories.webApi.forEach((testName) => {
        it(testName, async () => {
          const instanceId = `matrix-${matrixConfig.doBindingName}-${testName}-${Date.now()}`;
          const testable = createMatrixClient(matrixConfig, instanceId);
          try {
            await behaviorTests[testName as keyof typeof behaviorTests](testable);
          } finally {
            if (testable.cleanup) await testable.cleanup();
          }
        });
      });
    });

    describe('DO Storage', () => {
      testCategories.storage.forEach((testName) => {
        it(testName, async () => {
          const instanceId = `matrix-${matrixConfig.doBindingName}-${testName}-${Date.now()}`;
          const testable = createMatrixClient(matrixConfig, instanceId);
          try {
            await behaviorTests[testName as keyof typeof behaviorTests](testable);
          } finally {
            if (testable.cleanup) await testable.cleanup();
          }
        });
      });
    });

    describe('Concurrency', () => {
      it('should handle concurrent increment requests correctly', async () => {
        const instanceId = `matrix-${matrixConfig.doBindingName}-concurrent-increment-${Date.now()}`;
        const testable = createMatrixClient(matrixConfig, instanceId);
        
        try {
          const { client } = testable;
          
          // Fire 9 increments simultaneously
          const promises = Array.from({ length: 9 }, () => (client as any).increment());
          const results = await Promise.all(promises);
          
          // All should succeed
          expect(results).toHaveLength(9);
          results.forEach(result => {
            expect(typeof result).toBe('number');
            expect(result).toBeGreaterThan(0);
          });
          
          // All should have unique values (no race conditions)
          const uniqueValues = new Set(results);
          expect(uniqueValues.size).toBe(9);
          
          // Results should be in sequential order (1-9) - promises resolve in creation order
          expect(results).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        } finally {
          if (testable.cleanup) await testable.cleanup();
        }
      });

      it('should handle mixed concurrent operations correctly', async () => {
        const instanceId = `matrix-${matrixConfig.doBindingName}-concurrent-mixed-${Date.now()}`;
        const testable = createMatrixClient(matrixConfig, instanceId);
        
        try {
          const { client } = testable;
          
          // Fire mixed operations simultaneously
          const promises = [
            (client as any).increment(),
            (client as any).add(5, 3),
            (client as any).increment(),
            (client as any).getArray(),
            (client as any).increment(),
            (client as any).add(10, 20),
          ];
          const results = await Promise.all(promises);
          
          // All should succeed
          expect(results).toHaveLength(6);
          
          // Check specific results for operations that don't depend on state
          expect(results[1]).toBe(8);  // add(5, 3)
          expect(results[3]).toEqual([1, 2, 3, 4, 5]);  // getArray()
          expect(results[5]).toBe(30);  // add(10, 20)
          
          // Increment results should be in order (1, 2, 3) - promises resolve in creation order
          expect(results[0]).toBe(1);  // First increment
          expect(results[2]).toBe(2);  // Second increment
          expect(results[4]).toBe(3);  // Third increment
        } finally {
          if (testable.cleanup) await testable.cleanup();
        }
      });

      it('should handle high concurrency (50 requests)', async () => {
        const instanceId = `matrix-${matrixConfig.doBindingName}-concurrent-high-${Date.now()}`;
        const testable = createMatrixClient(matrixConfig, instanceId);
        
        try {
          const { client } = testable;
          
          // Fire 50 increments simultaneously
          const promises = Array.from({ length: 50 }, () => (client as any).increment());
          const results = await Promise.all(promises);
          
          // All should succeed
          expect(results).toHaveLength(50);
          
          // Results should be in sequential order (1-50) - promises resolve in creation order
          const expected = Array.from({ length: 50 }, (_, i) => i + 1);
          expect(results).toEqual(expected);
        } finally {
          if (testable.cleanup) await testable.cleanup();
        }
      });
    });

    describe('Automatic Batching', () => {
      // These tests verify that operations in the same tick get batched into a single round trip
      Object.keys(batchingTests).forEach((testName) => {
        it(testName, async () => {
          const instanceId = `matrix-${matrixConfig.doBindingName}-${testName}-${Date.now()}`;
          const metrics: Metrics = {};
          const testable = createMatrixClient(matrixConfig, instanceId, metrics);
          try {
            await batchingTests[testName as keyof typeof batchingTests]({
              ...testable,
              metrics
            });
          } finally {
            if (testable.cleanup) await testable.cleanup();
          }
        });
      });
    });
  });
});

/**
 * Additional test: Custom handler coexistence for ManualRoutingDO
 */
describe('Custom Handler Coexistence (ManualRoutingDO only)', () => {
  it('should allow mixing RPC and custom REST endpoints with HTTP', async () => {
    const instanceId = `custom-coexist-http-${Date.now()}`;
    
    // Test custom /health endpoint
    const healthResponse = await SELF.fetch(
      new Request(`https://fake-host.com/manual-routing-do/${instanceId}/health`)
    );
    const healthText = await healthResponse.text();
    expect(healthText).toBe('OK');

    // Test RPC still works
    const client = createRpcClient<ExampleDOType>('manual-routing-do', instanceId, {
      transport: 'http',
      baseUrl: 'https://fake-host.com',
      prefix: '__rpc',
      fetch: SELF.fetch.bind(SELF),
    });

    try {
      const count = await (client as any).increment();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThan(0);

      // Test custom /counter endpoint
      const counterResponse = await SELF.fetch(
        new Request(`https://fake-host.com/manual-routing-do/${instanceId}/counter`)
      );
      const counterData = await counterResponse.json();
      expect(counterData.counter).toBe(count);

      // Test RPC again
      const count2 = await (client as any).increment();
      expect(count2).toBe(count + 1);

      // Reset counter via custom endpoint
      const resetResponse = await SELF.fetch(
        new Request(`https://fake-host.com/manual-routing-do/${instanceId}/reset`, {
          method: 'POST',
        })
      );
      const resetData = await resetResponse.json();
      expect(resetData.message).toBe('Counter reset');

      // Verify reset worked
      const count3 = await (client as any).increment();
      expect(count3).toBe(1); // Should start from 1 after reset
    } finally {
      client[Symbol.dispose]();
    }
  });

  it('should allow mixing RPC and custom WebSocket messages with WebSocket transport', async () => {
    const instanceId = `custom-coexist-ws-${Date.now()}`;
    const WebSocketClass = getWebSocketShim(SELF.fetch.bind(SELF));
    
    // Create a direct WebSocket connection to test custom message handling
    const wsUrl = `wss://fake-host.com/__rpc/manual-routing-do/${instanceId}`;
    const ws = new WebSocketClass(wsUrl);
    
    // Wait for connection
    await vi.waitFor(() => {
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    try {
      // Test custom WebSocket message (PING/PONG)
      let receivedPong = '';
      ws.addEventListener('message', (event: MessageEvent) => {
        if (event.data === 'PONG') {
          receivedPong = event.data;
        }
      });
      
      ws.send('PING');
      await vi.waitFor(() => {
        expect(receivedPong).toBe('PONG');
      });

      // Now create RPC client and verify RPC still works after custom message
      const client = createRpcClient<ExampleDOType>('manual-routing-do', instanceId, {
        transport: 'websocket',
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass,
      });

      const count = await (client as any).increment();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThan(0);

      const count2 = await (client as any).increment();
      expect(count2).toBe(count + 1);

      client[Symbol.dispose]();
    } finally {
      ws.close();
    }
  });
});
