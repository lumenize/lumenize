import { describe, expect, beforeEach, afterEach } from 'vitest';
import { LumenizeClient } from '../src/lumenize-client';
import { checkServerAvailability, createMaybeIt, monkeyPatchWebSocketForTesting } from './test-utils';

// Check server availability synchronously at module load time
const serverAvailable = await checkServerAvailability();

/**
 * Live client tests that require a real WebSocket connection to validate timing behavior.
 * Most functional tests have been moved to integration-client-server-lifecycle.test.ts
 * for faster execution and better server-side code coverage.
 */
describe('Live client', () => {
  let lumenizeClient: LumenizeClient | null;
  let restoreWebSocket: (() => void) | null = null;
  const maybeIt = createMaybeIt(serverAvailable);

  beforeEach(async () => {
    // Set up WebSocket monkey patching for testing environment
    if (serverAvailable) {
      restoreWebSocket = monkeyPatchWebSocketForTesting();
    }
    
    // Close previous client if it exists
    if (lumenizeClient) {
      lumenizeClient.close();
    }
    
    // Initialize client if server is available
    if (serverAvailable) {
      lumenizeClient = new LumenizeClient({
        galaxy: "lumenize",
        star: "test-star",
        host: "http://localhost:8787",
        timeout: 1000,
        // route: "mcp",  // default is "mcp"
        capabilities: {
          // Client capabilities - what this client supports
        },
        clientInfo: {
          name: "lumenize-test-client",
          version: "1.0.0"
        }
      });
    }
  });

  afterEach(() => {
    // Restore original WebSocket if it was monkey patched
    if (restoreWebSocket) {
      restoreWebSocket();
      restoreWebSocket = null;
    }
  });

  // Keep timing-sensitive tests that validate real WebSocket behavior
  maybeIt('should complete MCP initialization immediately after WebSocket connection', async () => {
    if (!lumenizeClient) throw new Error("Client not initialized");
    const startTime = Date.now();
    
    // Connection should be ready almost immediately since initialization
    // is sent right after WebSocket opens (no extra round-trip)
    await lumenizeClient.waitForConnection();
    
    const initTime = Date.now() - startTime;

    // Should complete very quickly (< 200ms) since there's no extra round-trip
    expect(initTime).toBeLessThan(200);
    expect(lumenizeClient.isConnectionReady).toBe(true);
  });

  maybeIt("should wait for connection handshake before sending calls", async () => {
    // Close the beforeEach client to avoid interference
    if (lumenizeClient) {
      lumenizeClient.close();
      lumenizeClient = null;
    }
    
    // Use a fresh client for this test to avoid interference from beforeEach
    const client = new LumenizeClient({
      galaxy: "lumenize",
      star: "test-star",
      host: "http://localhost:8787",
      timeout: 5000, // Increased timeout to see if it's just timing
    });

    try {
      // Connection should not be ready immediately
      expect(client.isConnectionReady).toBe(false);

      // Test that calls are properly queued by checking they wait for connection
      // We'll start the calls but not await them immediately
      const call1Promise = client.callTool("subtract", {a: 10, b: 3});
      const call2Promise = client.callTool("subtract", {a: 20, b: 8});
      
      // Verify that connection is still not ready right after initiating calls
      expect(client.isConnectionReady).toBe(false);
      
      // Both calls should be waiting for the same connection promise
      // We can verify this by checking that waitForConnection resolves first
      const connectionPromise = client.waitForConnection();
      
      // Use Promise.race to see which resolves first
      // The connection promise should resolve before the calls if queueing is working
      const firstToResolve = await Promise.race([
        connectionPromise.then(() => 'connection'),
        call1Promise.then(() => 'call1'),
        call2Promise.then(() => 'call2')
      ]);
      
      // Connection should resolve first (or at least not be beaten by calls)
      expect(firstToResolve).toBe('connection');
      expect(client.isConnectionReady).toBe(true);

      // Now both calls should complete successfully
      const [result1, result2] = await Promise.all([call1Promise, call2Promise]);
      
      expect(result1).toEqual({ result: 7 });
      expect(result2).toEqual({ result: 12 });
    } finally {
      client.close();
    }
  });

});
