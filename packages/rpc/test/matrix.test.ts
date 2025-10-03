/**
 * Matrix Testing for RPC
 * 
 * Runs all behavior tests through all combinations of:
 * - Transport: WebSocket vs HTTP
 * - Instrumentation: lumenizeRpcDo vs handleRPCRequest
 * 
 * This ensures consistent behavior across all configurations.
 */

import { describe, it, beforeEach, afterEach } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, getWebSocketShim, type RpcClientConfig, type RpcAccessible } from '../src/index';
import { ExampleDO } from './test-worker-and-dos';
import { behaviorTests, testCategories, type TestableClient } from './shared/behavior-tests';

type ExampleDOType = RpcAccessible<InstanceType<typeof ExampleDO>>;

/**
 * Matrix configuration
 * Each combination represents a unique way to access the DO via RPC
 */
const MATRIX = [
  {
    name: 'WebSocket + lumenizeRpcDo',
    transport: 'websocket' as const,
    doBindingName: 'example-do',
    description: 'WebSocket transport with lumenizeRpcDo factory wrapper',
  },
  // NOTE: WebSocket + handleRPCRequest disabled until Phase 4 (handleRPCMessage implementation)
  // {
  //   name: 'WebSocket + handleRPCRequest',
  //   transport: 'websocket' as const,
  //   doBindingName: 'manual-routing-do',
  //   description: 'WebSocket transport with manual handleRPCRequest routing',
  // },
  {
    name: 'HTTP + lumenizeRpcDo',
    transport: 'http' as const,
    doBindingName: 'example-do',
    description: 'HTTP transport with lumenizeRpcDo factory wrapper',
  },
  {
    name: 'HTTP + handleRPCRequest',
    transport: 'http' as const,
    doBindingName: 'manual-routing-do',
    description: 'HTTP transport with manual handleRPCRequest routing',
  },
] as const;

/**
 * Create an RPC client for a given matrix configuration
 */
function createMatrixClient(config: typeof MATRIX[number], instanceId: string): TestableClient<ExampleDOType> {
  const baseConfig: Omit<RpcClientConfig, 'doInstanceNameOrId'> = {
    transport: config.transport,
    doBindingName: config.doBindingName,
    baseUrl: 'https://fake-host.com',
    prefix: '__rpc',
  };

  // Add transport-specific config
  if (config.transport === 'websocket') {
    (baseConfig as any).WebSocketClass = getWebSocketShim(SELF);
  } else {
    (baseConfig as any).fetch = SELF.fetch.bind(SELF);
  }

  const client = createRpcClient<ExampleDOType>({
    ...baseConfig,
    doInstanceNameOrId: instanceId,
  });

  return {
    client,
    cleanup: async () => {
      await client[Symbol.asyncDispose]();
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

    describe('Built-in Types', () => {
      testCategories.builtins.forEach((testName) => {
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
    const client = createRpcClient<ExampleDOType>({
      transport: 'http',
      doBindingName: 'manual-routing-do',
      doInstanceNameOrId: instanceId,
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
      await client[Symbol.asyncDispose]();
    }
  });

  // NOTE: WebSocket coexistence test disabled until Phase 4 (handleRPCMessage implementation)
  // it.skip('should allow mixing RPC and custom REST endpoints with WebSocket', async () => {
  //   // Will be enabled when ManualRoutingDO gets webSocket() method with handleRPCMessage
  // });
});
