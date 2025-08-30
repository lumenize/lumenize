import { describe, expect, it } from 'vitest';
import { runClientServerIntegrationTest } from './test-utils';
import { LATEST_PROTOCOL_VERSION } from '../src/schema/draft/schema';

describe('Integration Client-Server Lifecycle', () => {
  it('should subtract', async () => {
    await runClientServerIntegrationTest(async (client) => {
      // Verify client is ready
      expect(client.isConnectionReady).toBe(true);

      // Call the subtract tool through the proxy
      const result = await client.callTool("subtract", { a: 42, b: 23 });
      
      // Verify the result matches expected output
      expect(result).toEqual({ result: 19 });
    });
  });

  it("should return error quickly for non-existing method", async () => {
    await runClientServerIntegrationTest(async (client) => {
      const start = Date.now();
      try {
        await client.callTool("doesNotExist", { foo: "bar" });
        throw new Error("Expected error was not thrown");
      } catch (err: any) {
        const elapsed = Date.now() - start;
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe(-32601);
        expect(err.message).toBe('Tool "doesNotExist" not found');
        // Should return well before the timeout (e.g. < 100ms)
        expect(elapsed).toBeLessThan(100);
      }
    });
  });

  it("should return error for subtract with wrong parameters", async () => {
    await runClientServerIntegrationTest(async (client) => {
      try {
        // Pass a string instead of numbers
        await client.callTool("subtract", { foo: "bar" });
        throw new Error("Expected error was not thrown");
      } catch (err: any) {
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe(-32602); // Invalid params
        expect(err.message).toContain("Invalid params");
      }
    });
  });

  it("should validate output schema and throw error for bad-subtract", async () => {
    await runClientServerIntegrationTest(async (client) => {
      try {
        // The bad-subtract tool returns { result: number } but declares outputSchema with { result: string }
        await client.callTool("bad-subtract", {a: 10, b: 3});
        throw new Error("Expected output schema validation error was not thrown");
      } catch (err: any) {
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain("bad-subtract");
        expect(err.message).toContain("response does not match the tool's output schema");
        // The error should mention the specific validation failure
        expect(err.message.toLowerCase()).toContain("does not match schema");
      }
    });
  });

  describe('Protocol Version Negotiation', () => {
    it("should succeed when client and server versions match exactly", async () => {
      // Create a custom client with specific version for this test
      await runClientServerIntegrationTest(async (client) => {
        // The client should already be connected with the correct version
        expect(client.isConnectionReady).toBe(true);
        expect(client.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);

        // Should be able to make calls
        const result = await client.callTool("subtract", { a: 10, b: 3 });
        expect(result).toEqual({ result: 7 });
      }, { mcpVersion: LATEST_PROTOCOL_VERSION });
    });

    it("should fail when client version is not supported by server", async () => {
      try {
        await runClientServerIntegrationTest(async (client) => {
          // This should not be reached since connection should fail
          throw new Error("Expected connection to fail");
        }, { mcpVersion: "2024-11-05" }); // Different from server
        
        throw new Error("Expected connection to fail for unsupported version");
      } catch (error) {
        // Should fail to connect due to server rejecting the version
        expect(error instanceof Error ? error.message : String(error)).toMatch(/MCP initialization failed.*Unsupported protocol version/);
      }
    });

    it("should receive proper error response from server for unsupported version", async () => {
      try {
        await runClientServerIntegrationTest(async (client) => {
          // This should not be reached since connection should fail
          throw new Error("Expected connection to fail");
        }, { mcpVersion: "1.0.0" }); // Unsupported version
        
        throw new Error("Expected connection to fail for unsupported version");
      } catch (error) {
        // Should get an MCP initialization failed error (server rejected the version)
        expect(error instanceof Error ? error.message : String(error)).toMatch(/MCP initialization failed.*Unsupported protocol version/);
        
        // The error should be due to the server rejecting the unsupported version
        // The client should have received a proper JSON-RPC error response
        // with code -32602 and the supported/requested version info
      }
    });
  });
});
