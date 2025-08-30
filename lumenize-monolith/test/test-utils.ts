import { it, expect } from 'vitest';
// @ts-ignore - Not sure why TS can't find this
import { runInDurableObject, env } from 'cloudflare:test';
import { Connection, WSMessage } from 'partyserver';
import { Lumenize } from './test-harness';
import { LumenizeClient } from '../src/lumenize-client';

/**
 * Check if the test server is available at module load time.
 * Attempts to ping the server at http://localhost:8787/ping with a 1-second timeout.
 * 
 * @returns Promise<boolean> - true if server responds with "pong", false otherwise
 */
export async function checkServerAvailability(): Promise<boolean> {
  try {
    const response = await fetch("http://localhost:8787/ping", {
      signal: AbortSignal.timeout(1000)
    });
    const responseBody = await response.text();
    const available = responseBody === "pong";
    console.log(`Server available: ${available}`);
    return available;
  } catch (error) {
    console.log("Server ping failed during module load:", error);
    return false;
  }
}

/**
 * Create a maybeIt function that conditionally runs tests based on server availability.
 * This is useful for integration tests that require a live server to be running.
 * 
 * @param serverAvailable - Whether the server is available
 * @returns A maybeIt function that behaves like vitest's `it` but skips tests when server is unavailable
 * 
 * @example
 * ```typescript
 * const serverAvailable = await checkServerAvailability();
 * const maybeIt = createMaybeIt(serverAvailable);
 * 
 * maybeIt("should call the API", async () => {
 *   // This test runs only if server is available, otherwise it's skipped
 * });
 * 
 * maybeIt.skip("should do something", async () => {
 *   // This test is always skipped
 * });
 * 
 * maybeIt.only("should run exclusively", async () => {
 *   // This test runs exclusively if server is available, otherwise skipped
 * });
 * ```
 */
export function createMaybeIt(serverAvailable: boolean) {
  function maybeIt(name: string, fn: () => Promise<any>) {
    if (serverAvailable) {
      it(name, fn);
    } else {
      it.skip(name, fn);
    }
  }

  // Enhanced maybeIt with support for .skip and .only
  maybeIt.skip = (name: string, fn: () => Promise<any>) => {
    it.skip(name, fn);
  };

  maybeIt.only = (name: string, fn: () => Promise<any>) => {
    if (serverAvailable) {
      it.only(name, fn);
    } else {
      it.skip(name, fn);
    }
  };

  return maybeIt;
}

/**
 * Message builder helpers to reduce duplication in tests
 */
export const MessageBuilders = {
  initialize: (id: number | string = 1, protocolVersion: string | null = 'DRAFT-2025-v2', clientInfo = { name: 'test-client', version: '1.0.0' }) => {
    const params: any = {
      capabilities: { roots: { listChanged: true }, sampling: {} },
      clientInfo
    };
    if (protocolVersion !== null) {
      params.protocolVersion = protocolVersion;
    }
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params
    });
  },

  toolsList: (id: number | string = 2) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/list',
      params: {}
    }),

  toolCall: (id: number | string = 3, name?: string, args: any = { a: 10, b: 4 }) => {
    const params: any = { arguments: args };
    if (name !== undefined) {
      params.name = name;
    }
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params
    });
  },

  resourcesTemplatesList: (id: number | string = 4, params: any = {}) => {
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'resources/templates/list',
      params
    });
  },

  notification: (method = 'notifications/initialized', params = {}) =>
    JSON.stringify({
      jsonrpc: '2.0',
      method,
      params
    }),

  envelope: (payload: any, type = 'mcp') =>
    JSON.stringify({ type, payload: typeof payload === 'string' ? JSON.parse(payload) : payload }),

  invalid: (overrides = {}) =>
    JSON.stringify({
      jsonrpc: '2.0',
      some: 'invalid',
      data: 'here',
      ...overrides
    })
};

/**
 * Test expectation helpers for common response validation
 */
export const ExpectedResponses = {
  initialize: (data: any, id: number | string = 1) => {
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe(id);
    expect(data.result).toBeDefined();
    expect(data.result.serverInfo.name).toBe('lumenize');
    expect(data.result.capabilities).toBeDefined();
    expect(data.result.protocolVersion).toBe('DRAFT-2025-v2');
  },

  error: (data: any, code: number, id?: number | string) => {
    expect(data.jsonrpc).toBe('2.0');
    if (id !== undefined) expect(data.id).toBe(id);
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe(code);
  },

  toolsList: (data: any, id: number | string = 2) => {
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe(id);
    expect(data.result).toBeDefined();
    expect(data.result.tools).toBeDefined();
    expect(Array.isArray(data.result.tools)).toBe(true);
  },

  toolCall: (data: any, id: number | string = 3) => {
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe(id);
    expect(data.result).toBeDefined();
    expect(data.result.structuredContent).toBeDefined();
  },

  resourcesTemplatesList: (data: any, id: number | string = 4) => {
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe(id);
    expect(data.result).toBeDefined();
    expect(data.result.resourceTemplates).toBeDefined();
    expect(Array.isArray(data.result.resourceTemplates)).toBe(true);
  },

  envelope: (data: any, type = 'mcp') => {
    expect(data.type).toBe(type);
    expect(data.payload).toBeDefined();
    expect(data.payload.jsonrpc).toBe('2.0');
  }
};

/**
 * Factory function to create a mock connection for testing
 */
export function createMockConnection() {
  const sentMessages: string[] = [];
  const notificationHistory: any[] = []; // Track all notifications
  let attachment: any = null;
  let onConnectResolve: (() => void) | null = null;
  let onConnectPromise: Promise<void> | null = null;
  
  // Mock headers map for realistic testing
  const mockHeaders = new Map([
    ['user-agent', 'test-agent/1.0'],
    ['origin', 'https://test.example.com'],
    ['cookie', 'sessionId=test-session-123; other=value'],
    ['host', 'test.lumenize.com'],
    ['upgrade', 'websocket'],
    ['connection', 'upgrade']
  ]);
  
  const mockConnection: Connection = {
    deserializeAttachment: () => attachment,
    serializeAttachment: (obj: object) => { 
      attachment = obj;
      // Signal that onConnect has completed its work
      if (onConnectResolve) {
        onConnectResolve();
        onConnectResolve = null;
      }
    },
    send: (message: WSMessage) => {
      const msgStr = message as string;
      sentMessages.push(msgStr);
      
      // Parse and track notifications for subscription testing
      try {
        const parsed = JSON.parse(msgStr);
        
        // Handle both direct notifications and envelope format notifications
        let notification = null;
        if (parsed.method && parsed.method.startsWith('notifications/')) {
          // Direct notification format
          notification = parsed;
        } else if (parsed.type === 'mcp' && parsed.payload && parsed.payload.method && parsed.payload.method.startsWith('notifications/')) {
          // Envelope format notification
          notification = parsed.payload;
        }
        
        if (notification) {
          notificationHistory.push({
            timestamp: Date.now(),
            method: notification.method,
            params: notification.params,
            full: notification
          });
        }
      } catch (e) {
        // Ignore parse errors for non-JSON messages
      }
    },
    close: (code?: number, reason?: string) => {
      // Mock close method - in tests this would close the connection
      console.debug('Mock connection close called', { code, reason });
    },
    toString: () => 'mock-connection-test-123' // For queue key generation
  } as Connection;

  // Generate a subscriberId for this mock connection to match client behavior
  const subscriberId = crypto.randomUUID();
  
  const mockConnectionContext = {
    request: {
      headers: {
        get: (name: string) => mockHeaders.get(name.toLowerCase()) ?? null,
        has: (name: string) => mockHeaders.has(name.toLowerCase()),
        entries: () => mockHeaders.entries(),
        keys: () => mockHeaders.keys(),
        values: () => mockHeaders.values(),
        forEach: (callback: (value: string, key: string) => void) => {
          mockHeaders.forEach(callback);
        },
        [Symbol.iterator]: () => mockHeaders.entries()
      },
      url: `wss://test.lumenize.com/ws?subscriberId=${subscriberId}`,
    }
  } as any;
  
  return {
    connection: mockConnection,
    ctx: mockConnectionContext,
    getSentMessages: () => [...sentMessages],
    getLastMessage: () => sentMessages[sentMessages.length - 1],
    getMessageById: (expectedId: number) => {
      for (const msg of sentMessages) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.id === expectedId) {
            return parsed;
          }
        } catch (e) {
          throw new Error(`Failed to parse JSON message: ${msg}`);  // They should all be JSON
        }
      }
      throw new Error(`Message with id=${expectedId} not found`);
    },
    clearMessages: () => sentMessages.length = 0,
    getAttachment: () => attachment,
    
    // Enhanced notification tracking for subscription tests
    getNotifications: () => [...notificationHistory],
    getNotificationsForEntity: (entityUri: string) => 
      notificationHistory.filter(n => n.params?.uri === entityUri),
    getLastNotification: () => notificationHistory[notificationHistory.length - 1],
    waitForNotification: async (entityUri?: string, timeoutMs = 1000) => {
      const startTime = Date.now();
      const initialCount = entityUri ? 
        notificationHistory.filter(n => n.params?.uri === entityUri).length :
        notificationHistory.length;
      
      while (Date.now() - startTime < timeoutMs) {
        const currentCount = entityUri ?
          notificationHistory.filter(n => n.params?.uri === entityUri).length :
          notificationHistory.length;
        
        if (currentCount > initialCount) {
          return entityUri ?
            notificationHistory.filter(n => n.params?.uri === entityUri).slice(-1)[0] :
            notificationHistory.slice(-1)[0];
        }
        
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      throw new Error(`No notification received within ${timeoutMs}ms` + 
        (entityUri ? ` for entity ${entityUri}` : ''));
    },
    clearNotifications: () => notificationHistory.length = 0,
    
    // Helper methods for testing different scenarios
    setHeader: (name: string, value: string) => mockHeaders.set(name.toLowerCase(), value),
    removeHeader: (name: string) => mockHeaders.delete(name.toLowerCase()),
    getHeaders: () => Object.fromEntries(mockHeaders),
    // Convenience method to wait for onConnect to complete
    waitForConnection: async (instance: any) => {
      // Simulate the async nature of WebSocket onConnect - it's called after a delay
      // when the WebSocket connection is established
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Create a promise that resolves when serializeAttachment is called
      onConnectPromise = new Promise<void>((resolve) => {
        onConnectResolve = resolve;
      });
      
      // Call onConnect (which should be async but may not wait for everything)
      const onConnectResult = instance.onConnect(mockConnection, mockConnectionContext);
      
      // Wait for both the onConnect method and the serializeAttachment to complete
      await Promise.all([
        onConnectResult,
        onConnectPromise
      ]);
      
      // Clear messages after setup to ensure test independence
      sentMessages.length = 0;
      
      return mockConnection;
    },
    
    // Get the actual connection tags that would be assigned by the server
    getConnectionTags: (instance: any) => {
      if (typeof instance.getConnectionTags === 'function') {
        return instance.getConnectionTags(mockConnection, mockConnectionContext);
      }
      return [];
    }
  };
}

/**
 * Helper function to run test with Lumenize instance that's fully initialized
 * Automatically performs MCP protocol initialization (initialize + notifications/initialized)
 */
export async function runTestWithLumenize(testFn: (instance: Lumenize, mock: ReturnType<typeof createMockConnection>, state: DurableObjectState) => Promise<void>) {
  const id = env.Lumenize.newUniqueId();
  const stub = env.Lumenize.get(id) as DurableObjectStub<Lumenize>;
  return await runInDurableObject(stub, async (instance: Lumenize, state: DurableObjectState) => {
    const mock = createMockConnection();
    
    // Get the actual connection tags that the server would assign
    // This exercises the real getConnectionTags logic
    const connectionTags = mock.getConnectionTags(instance);
    
    // Mock the getWebSockets method for testing notifications
    // This now uses the REAL tags from getConnectionTags() for lookup
    const originalGetWebSockets = (instance as any).ctx.getWebSockets;
    (instance as any).ctx.getWebSockets = (tag: string) => {
      // Check if the requested tag matches any of the real connection tags
      if (connectionTags.includes(tag)) {
        // Return an array with a mock WebSocket that has a send method pointing to the mock connection
        return [{
          send: (message: string) => {
            // Delegate to the mock connection's send method which captures notifications
            mock.connection.send(message);
          }
        }];
      }
      return []; // No connections found for tags that don't match
    };
    
    // Ensure onStart is called to initialize tools
    if (typeof instance.onStart === 'function') {
      instance.onStart();
    }
    
    // Ensure onConnect is called to set up the connection attachment
    // (clearMessages happens automatically in waitForConnection)
    await mock.waitForConnection(instance);
    
    // Automatically perform MCP initialization for all tests
    await MCPHelpers.initializeConnection(instance, mock);
    
    await testFn(instance, mock, state);
    
    // Restore original method if it existed
    if (originalGetWebSockets) {
      (instance as any).ctx.getWebSockets = originalGetWebSockets;
    }
  });
}

/**
 * Helper function to properly initialize MCP connection following the full protocol
 */
export const MCPHelpers = {
  /**
   * Perform complete MCP initialization: send initialize request, then notifications/initialized
   */
  async initializeConnection(instance: Lumenize, mock: ReturnType<typeof createMockConnection>): Promise<void> {
    // Send initialize request
    const initMessage = MessageBuilders.initialize();
    await instance.onMessage(mock.connection, initMessage);
    
    // Verify initialize response was sent
    const initResponse = mock.getLastMessage();
    expect(initResponse).toBeDefined();
    const initData = JSON.parse(initResponse);
    ExpectedResponses.initialize(initData);
    
    // Clear the initialize response
    mock.clearMessages();
    
    // Send notifications/initialized to complete the handshake
    const notificationMessage = MessageBuilders.notification('notifications/initialized');
    await instance.onMessage(mock.connection, notificationMessage);
    
    // Notifications should not generate responses
    const notificationResponse = mock.getLastMessage();
    expect(notificationResponse).toBeUndefined();
  }
};

/**
 * Helper function for integration testing that sets up WebSocket proxy and runs test
 * @param testFn - Test function that receives a configured LumenizeClient
 * @param clientConfig - Optional custom client configuration
 */
export async function runClientServerIntegrationTest(
  testFn: (client: LumenizeClient) => Promise<void>,
  clientConfig?: Partial<ConstructorParameters<typeof LumenizeClient>[0]>
) {
  let restoreWebSocket: (() => void) | null = null;
  let client: LumenizeClient | null = null;
  
  try {
    await runTestWithLumenize(async (serverInstance, mockConnection) => {
      // Set up WebSocket proxy that directly routes to server
      restoreWebSocket = createDirectWebSocketProxy(serverInstance, mockConnection);
      
      // Create client - it will use our proxied WebSocket
      client = new LumenizeClient({
        galaxy: "lumenize",
        star: "test-star", 
        host: "http://localhost:8787", // Won't actually be used due to proxy
        timeout: 5000,
        capabilities: {},
        clientInfo: {
          name: "integration-test-client",
          version: "1.0.0"
        },
        // Override with any custom config
        ...clientConfig
      });

      // Wait for connection to be established through proxy
      await client.waitForConnection();
      
      // Run the actual test
      await testFn(client);
    });
  } finally {
    // Clean up - use type assertions to help TypeScript
    if (client) {
      (client as LumenizeClient).close();
      client = null;
    }
    if (restoreWebSocket) {
      (restoreWebSocket as () => void)();
      restoreWebSocket = null;
    }
  }
}

/**
 * Simple WebSocket proxy that directly communicates with server instance
 * without the complexity of runInDurableObject within the proxy.
 * Useful for integration testing between LumenizeClient and Lumenize server.
 */
export function createDirectWebSocketProxy(serverInstance: Lumenize, mockConnection: ReturnType<typeof createMockConnection>): () => void {
  const globalScope = typeof window !== 'undefined' ? window : globalThis;
  const OriginalWebSocket = globalScope.WebSocket;
  
  if (!OriginalWebSocket) {
    console.warn('WebSocket not available for monkey patching');
    return () => {};
  }

  // Mock WebSocket class that routes messages directly to server
  function MockWebSocket(this: any, url: string | URL, protocols?: string | string[]) {
    const eventTarget = new EventTarget();
    
    // WebSocket-like interface
    this.readyState = 1; // OPEN
    this.url = url.toString();
    this.protocol = '';
    this.extensions = '';
    this.bufferedAmount = 0;
    
    // Event handlers
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;
    
    // Event listener methods
    this.addEventListener = eventTarget.addEventListener.bind(eventTarget);
    this.removeEventListener = eventTarget.removeEventListener.bind(eventTarget);
    this.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);
    
    // Send method - routes directly to server
    this.send = async (data: string) => {
      try {
        // Parse the envelope from client
        const envelope = JSON.parse(data);
        
        // Extract the MCP message from the envelope
        const mcpMessage = JSON.stringify(envelope.payload);
        
        // Send directly to server's onMessage method
        await serverInstance.onMessage(mockConnection.connection, mcpMessage);
        
        // Get the response from mock connection
        const response = mockConnection.getLastMessage();
        if (response) {
          // Parse server response and wrap in envelope
          const serverPayload = JSON.parse(response);
          const responseEnvelope = {
            type: envelope.type || 'mcp',
            payload: serverPayload
          };
          
          // Send response back to client
          setTimeout(() => {
            const messageEvent = new MessageEvent('message', {
              data: JSON.stringify(responseEnvelope)
            });
            
            if (this.onmessage) {
              this.onmessage(messageEvent);
            }
            this.dispatchEvent(messageEvent);
          }, 0);
          
          // Clear the message from mock for next call
          mockConnection.clearMessages();
        }
      } catch (error) {
        console.error('Error in WebSocket proxy send:', error);
        
        // Send error to client
        setTimeout(() => {
          const errorEvent = new Event('error');
          if (this.onerror) {
            this.onerror(errorEvent);
          }
          this.dispatchEvent(errorEvent);
        }, 0);
      }
    };
    
    this.close = () => {
      this.readyState = 3; // CLOSED
      setTimeout(() => {
        const closeEvent = new CloseEvent('close', { code: 1000, reason: 'Normal closure' });
        if (this.onclose) {
          this.onclose(closeEvent);
        }
        this.dispatchEvent(closeEvent);
      }, 0);
    };
    
    // Simulate connection opening
    setTimeout(() => {
      const openEvent = new Event('open');
      if (this.onopen) {
        this.onopen(openEvent);
      }
      this.dispatchEvent(openEvent);
    }, 0);
  }
  
  // Add WebSocket constants
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  
  // Replace global WebSocket
  globalScope.WebSocket = MockWebSocket as any;
  
  // Return cleanup function
  return () => {
    globalScope.WebSocket = OriginalWebSocket;
  };
}

/**
 * Monkey patch WebSocket to inject cookies into URL search parameters for testing
 * This is needed because our test environment doesn't have proper cookie support
 * but the server expects sessionId in cookies for authentication.
 */
export function monkeyPatchWebSocketForTesting() {
  // Check if we're in a browser environment with window object
  const globalScope = typeof window !== 'undefined' ? window : globalThis;
  
  // Save the original WebSocket constructor
  const OriginalWebSocket = globalScope.WebSocket;
  
  if (!OriginalWebSocket) {
    console.warn('WebSocket not available for monkey patching');
    return () => {}; // Return no-op cleanup function
  }
  
  // Monkey patch the WebSocket constructor
  globalScope.WebSocket = function(url: string | URL, protocols?: string | string[]) {
    // Parse the URL to inject cookies
    const parsedUrl = new URL(url);
    
    // Get cookies from document if available, or use a test sessionId
    let cookies = '';
    if (typeof document !== 'undefined' && document.cookie) {
      cookies = document.cookie;
    } else {
      // In testing environment, create a test sessionId cookie
      cookies = 'sessionId=test-session-' + Math.random().toString(36).substring(7);
    }

    // Add cookies to the query string for the server to parse in test/dev environments
    parsedUrl.searchParams.append('cookies', encodeURIComponent(cookies));

    // Call the original WebSocket constructor with the modified URL
    return new OriginalWebSocket(parsedUrl.toString(), protocols);
  } as any;

  // Copy static properties if they exist
  Object.setPrototypeOf(globalScope.WebSocket, OriginalWebSocket);
  
  // Return cleanup function to restore original WebSocket
  return () => {
    globalScope.WebSocket = OriginalWebSocket;
  };
}
