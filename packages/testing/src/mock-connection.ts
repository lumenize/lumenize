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
