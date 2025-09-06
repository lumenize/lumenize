import { Connection, WSMessage } from 'partyserver';

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
 * Simple WebSocket proxy that directly communicates with server instance
 * without the complexity of runInDurableObject within the proxy.
 * Useful for integration testing between LumenizeClient and Lumenize server.
 */
export function createDirectWebSocketProxy(serverInstance: any, mockConnection: any): () => void {
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
          
          // Send response back to client immediately
          const messageEvent = new MessageEvent('message', {
            data: JSON.stringify(responseEnvelope)
          });
          
          if (this.onmessage) {
            this.onmessage(messageEvent);
          }
          this.dispatchEvent(messageEvent);
          
          // Clear the message from mock for next call
          mockConnection.clearMessages();
        }
      } catch (error) {
        console.error('Error in WebSocket proxy send:', error);
        
        // Send error to client immediately
        const errorEvent = new Event('error');
        if (this.onerror) {
          this.onerror(errorEvent);
        }
        this.dispatchEvent(errorEvent);
      }
    };
    
    this.close = () => {
      this.readyState = 3; // CLOSED
      // Make close synchronous
      const closeEvent = new CloseEvent('close', { code: 1000, reason: 'Normal closure' });
      if (this.onclose) {
        this.onclose(closeEvent);
      }
      this.dispatchEvent(closeEvent);
    };
    
    // Simulate connection opening immediately
    const openEvent = new Event('open');
    if (this.onopen) {
      this.onopen(openEvent);
    }
    this.dispatchEvent(openEvent);
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
