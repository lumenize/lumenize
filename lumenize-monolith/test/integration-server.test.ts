import { describe, it, expect } from 'vitest';
import { 
  MessageBuilders, 
  ExpectedResponses, 
  runTestWithLumenize,
} from './test-utils';

describe('Lumenize Server runInDurableObject unit tests', () => {

  it("should be able to call onMessage", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const message = MessageBuilders.initialize();
      await instance.onMessage(mock.connection, message);

      // Verify the response was sent
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const responseData = JSON.parse(sentMessage);
      ExpectedResponses.initialize(responseData);

      // Below is an example of how we would check storage during a unit test
      state.storage.list().then((keys) => {
        // Clear storage after test
        keys.forEach(key => console.log({ key }));
      });
    });
  });

  it("should handle MCP initialize request", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const initializeMessage = MessageBuilders.initialize();
      await instance.onMessage(mock.connection, initializeMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      ExpectedResponses.initialize(data);
    });
  });

  it("should handle MCP initialize request with unsupported protocol version", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const initializeMessage = MessageBuilders.initialize(10, '1.0.0');
      await instance.onMessage(mock.connection, initializeMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      ExpectedResponses.error(data, -32602, 10);
      expect(data.error.message).toContain('Unsupported protocol version');
      expect(data.error.data.supported).toEqual(['DRAFT-2025-v2']);
      expect(data.error.data.requested).toBe('1.0.0');
    });
  });

  it("should handle MCP initialize request without protocol version", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const initializeMessage = MessageBuilders.initialize(11, null);
      await instance.onMessage(mock.connection, initializeMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      ExpectedResponses.error(data, -32602, 11);
      expect(data.error.message).toBe('protocolVersion parameter is required for initialize method');
      expect(data.error.data).toBeDefined();
      expect(data.error.data.supported).toEqual(['DRAFT-2025-v2']);
    });
  });

  it("should handle MCP tools/list request", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      // Give a small delay to ensure onStart has completed
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const toolsListMessage = MessageBuilders.toolsList();
      await instance.onMessage(mock.connection, toolsListMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      ExpectedResponses.toolsList(data);
      
      // Check for subtract tool
      const subtractTool = data.result.tools.find((tool: any) => tool.name === 'subtract');
      expect(subtractTool).toBeDefined();
      expect(subtractTool.description.toLowerCase()).toContain('subtract');
    });
  });

  it("should handle tools/call request for subtract", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      // Give a small delay to ensure onStart has completed
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const toolCallMessage = MessageBuilders.toolCall(3, 'subtract');
      await instance.onMessage(mock.connection, toolCallMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      ExpectedResponses.toolCall(data);
      expect(data.result.structuredContent.result).toBe(6);
    });
  });

  it("should handle tools/call request with missing tool name", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const toolCallMessage = MessageBuilders.toolCall(13, undefined, { a: 10, b: 4 });
      await instance.onMessage(mock.connection, toolCallMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      ExpectedResponses.error(data, -32602, 13);
      expect(data.error.message).toContain('Tool name is required');
    });
  });

  it("should handle tools/call request with non-string tool name", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const toolCallMessage = MessageBuilders.invalid({
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: {
          name: 123,
          arguments: { a: 10, b: 4 }
        }
      });

      await instance.onMessage(mock.connection, toolCallMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      ExpectedResponses.error(data, -32602, 14);
      expect(data.error.message).toContain('Tool name is required and must be a string');
    });
  });

  it("should handle tools/call request with invalid parameters that trigger TypeError", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      // Give a small delay to ensure onStart has completed
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const toolCallMessage = MessageBuilders.toolCall(15, 'subtract', { a: 'not-a-number', b: 4 });

      await instance.onMessage(mock.connection, toolCallMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      ExpectedResponses.error(data, -32602, 15);
      expect(data.error.message).toContain('Invalid params');
    });
  });

  it("should handle invalid JSON gracefully", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const invalidMessage = 'invalid json';

      await instance.onMessage(mock.connection, invalidMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      ExpectedResponses.error(data, -32700);
    });
  });

  it("should handle unknown method gracefully", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const unknownMethodMessage = MessageBuilders.invalid({
        jsonrpc: '2.0',
        id: 5,
        method: 'unknown/method',
        params: {}
      });

      await instance.onMessage(mock.connection, unknownMethodMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      ExpectedResponses.error(data, -32601, 5);
    });
  });

  it("should handle unknown tool call gracefully", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const unknownToolMessage = MessageBuilders.toolCall(6, 'unknown_tool', {});

      await instance.onMessage(mock.connection, unknownToolMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      ExpectedResponses.error(data, -32601, 6);
    });
  });

  it("should handle WebSocket envelope format request", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const envelopeMessage = MessageBuilders.envelope(
        MessageBuilders.toolsList(16),
        'mcp'
      );

      await instance.onMessage(mock.connection, envelopeMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      
      // Should return an envelope response
      ExpectedResponses.envelope(data, 'mcp');
      expect(data.payload.id).toBe(16);
      expect(data.payload.result).toBeDefined();
    });
  });

  it("should handle WebSocket envelope format with invalid payload", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const envelopeMessage = MessageBuilders.envelope({
        // Invalid JSON-RPC - missing required fields
        method: 'tools/list'
      }, 'mcp');

      await instance.onMessage(mock.connection, envelopeMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      
      // Should return an envelope error response
      ExpectedResponses.envelope(data, 'mcp');
      expect(data.payload.error).toBeDefined();
      expect(data.payload.error.code).toBe(-32600); // Invalid request
    });
  });

  it("should handle notification message (no response expected)", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const notificationMessage = MessageBuilders.notification('notifications/initialized');

      await instance.onMessage(mock.connection, notificationMessage);
      
      // For notifications, no response should be sent
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeUndefined();
    });
  });

  it("should handle envelope notification message", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const envelopeNotification = MessageBuilders.envelope(
        MessageBuilders.notification('notifications/initialized'),
        'mcp'
      );

      await instance.onMessage(mock.connection, envelopeNotification);
      
      // For notifications, no response should be sent
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeUndefined();
    });
  });

  it("should handle invalid request that's neither request nor notification", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const invalidMessage = JSON.stringify({
        jsonrpc: '2.0',
        // Missing both id (for request) and method format for notification
        some: 'invalid',
        data: 'here'
      });

      await instance.onMessage(mock.connection, invalidMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      expect(data.jsonrpc).toBe('2.0');
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32600); // Invalid request
      expect(data.error.message).toContain('not a valid JSON-RPC request or notification');
    });
  });

  it("should handle envelope format with invalid request", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      const envelopeMessage = JSON.stringify({
        type: 'mcp',
        payload: {
          jsonrpc: '2.0',
          // Missing both id (for request) and proper method format for notification
          some: 'invalid',
          data: 'here'
        }
      });

      await instance.onMessage(mock.connection, envelopeMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      
      // Should return an envelope error response
      expect(data.type).toBe('mcp');
      expect(data.payload).toBeDefined();
      expect(data.payload.jsonrpc).toBe('2.0');
      expect(data.payload.error).toBeDefined();
      expect(data.payload.error.code).toBe(-32600); // Invalid request
    });
  });

  it("should handle invalid missing arguments", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      // Give a small delay to ensure onStart has completed
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const toolCallMessage = JSON.stringify({
        jsonrpc: '2.0',
        id: 17,
        method: 'tools/call',
        params: {
          name: 'subtract',
          arguments: null // This should cause an error in the tool handler
        }
      });

      await instance.onMessage(mock.connection, toolCallMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      expect(data.jsonrpc).toBe('2.0');
      expect(data.id).toBe(17);
      expect(data.error.code).toBe(-32602); // Invalid params for null arguments
    });
  });

  it("should error on empty params", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      // Give a small delay to ensure onStart has completed
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const malformedMessage = JSON.stringify({
        jsonrpc: '2.0',
        id: 18,
        method: 'tools/call',
        params: {
          name: 'subtract',
          // Create arguments that might cause an error during processing
          arguments: {
            a: undefined, // This should cause a TypeError in the subtract function
            b: null
          }
        }
      });

      await instance.onMessage(mock.connection, malformedMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      expect(data.jsonrpc).toBe('2.0');
      expect(data.id).toBe(18);
      expect(data.error.code).toBe(-32602);
    });
  });

  it("should handle request with missing id (notification format)", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      // Create a notification request (no id field means no response expected)
      const notificationMessage = JSON.stringify({
        jsonrpc: '2.0',
        // Intentionally omit id to make this a notification
        method: 'tools/call',
        params: {
          name: 'subtract',
          arguments: { a: 10, b: 5 }
        }
      });

      await instance.onMessage(mock.connection, notificationMessage);
      
      // For notifications, no response should be sent per JSON-RPC spec
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeUndefined();
    });
  });

  it("should handle request with malformed id causing internal error", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      // Create a request that will cause issues during error handling
      const message = JSON.stringify({
        jsonrpc: '2.0',
        id: {}, // malformed id - object instead of string/number
        method: 'unknown/method',
        params: {}
      });

      await instance.onMessage(mock.connection, message);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      
      // Should handle the malformed id gracefully
      expect(data.jsonrpc).toBe('2.0');
      // Worry was that id might be preserved as an object
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32600); // Invalid request (not method not found)
    });
  });

  it("should handle envelope format with malformed envelope", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      // Test envelope format that causes parsing issues
      const envelopeMessage = JSON.stringify({
        type: "WebSocketMessage",
        // malformed payload that's not valid JSON-RPC
        payload: {
          invalid: "not jsonrpc"
        }
      });

      await instance.onMessage(mock.connection, envelopeMessage);
      
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeDefined();
      
      const data = JSON.parse(sentMessage);
      
      // The malformed envelope should trigger an envelope response with error
      expect(data.type).toBe("WebSocketMessage");
      expect(data.payload).toBeDefined();
      expect(data.payload.jsonrpc).toBe('2.0');
      expect(data.payload.error).toBeDefined();
      expect(data.payload.error.code).toBe(-32600); // Invalid request
    });
  });

  // Test for non-string messages in onMessage
  it("should ignore non-string messages", async () => {
    await runTestWithLumenize(async (instance, mock, state) => {
      await mock.waitForConnection(instance);
      
      // Send a non-string message (Buffer, ArrayBuffer, etc.)
      const buffer = new ArrayBuffer(8);
      await instance.onMessage(mock.connection, buffer as any);
      
      // No response should be sent
      const sentMessage = mock.getLastMessage();
      expect(sentMessage).toBeUndefined();
    });
  });
});
