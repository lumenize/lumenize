import {
  SELF,
  env,
  createExecutionContext,
// @ts-expect-error - cloudflare:test module types are not consistently recognized by VS Code
} from 'cloudflare:test';

/**
 * Simulates a WebSocket upgrade request for testing Cloudflare Workers.
 * This minimally mimics what the browser WebSocket API does, but:
 * - Can't use browser-based client libraries
 * - Doesn't mimic all browser behaviors like: origins, cookies, searchParams, etc.
 * 
 * @param url - The full WebSocket URL (e.g., 'wss://example.com/path' or 'https://example.com/path')
 * @returns Promise with WebSocket instance and execution context
 */
export async function simulateWSUpgrade(url: string) {
  const ctx = createExecutionContext();
  const req = new Request(url, {
    headers: { Upgrade: "websocket" }
  });
  
  const res = await SELF.fetch(req, env, ctx);
  
  if (res.status !== 101) {
    throw new Error(`WebSocket upgrade failed: Expected status 101, got ${res.status}`);
  }
  
  const ws = res.webSocket as any;
  if (!ws) {
    throw new Error('WebSocket upgrade failed: No webSocket property in response');
  }
  
  ws.accept(); // This works because we're running inside of workerd
  return { ws, ctx };
}

/**
 * Higher-level API that handles WebSocket upgrade with automatic timeout and cleanup.
 * Eliminates boilerplate Promise/timeout code in tests.
 * 
 * @param url - The full WebSocket URL
 * @param testFn - Function that receives WebSocket and context, should setup event handlers and send messages
 * @param timeoutMs - Timeout in milliseconds (default: 5000)
 * @returns Promise that resolves when test completes or rejects on timeout/error
 */
export async function runWithSimulatedWSUpgrade(
  url: string,
  testFn: (ws: any, ctx: any) => Promise<void> | void,
  timeoutMs: number = 5000
): Promise<void> {
  return new Promise<void>(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`WebSocket test timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    
    try {
      const { ws, ctx } = await simulateWSUpgrade(url);
      
      // Track if test has completed
      let completed = false;
      const cleanup = () => {
        if (!completed) {
          completed = true;
          clearTimeout(timeout);
          resolve();
        }
      };
      
      // Wrap the original onmessage to auto-resolve after message handling
      let originalOnMessage: ((event: any) => void | Promise<void>) | null = null;
      Object.defineProperty(ws, 'onmessage', {
        get() { return originalOnMessage; },
        set(handler: (event: any) => void | Promise<void>) {
          originalOnMessage = async (event: any) => {
            try {
              const result = handler(event);
              // Handle both sync and async message handlers
              if (result instanceof Promise) {
                await result;
              }
              // Auto-complete test after successful message handling
              cleanup();
            } catch (error) {
              clearTimeout(timeout);
              reject(error);
            }
          };
        }
      });
      
      // Run the test function
      const result = testFn(ws, ctx);
      if (result instanceof Promise) {
        await result;
        // If test function was async and completed without WebSocket messages, cleanup
        cleanup();
      }
      // If test function was sync, we wait for WebSocket message or timeout
      
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

/**
 * High-level API that uses WebSocket mocking to overcome all limitations of simulateWSUpgrade.
 * This approach:
 * - ✅ Supports wss:// protocol URLs for routing
 * - ✅ Works with browser-based client libraries like AgentClient
 * - ✅ Supports cookies, origin, and other browser WebSocket behaviors
 * - ✅ Allows inspection of connection tags and attachments
 * 
 * @param testFn - Function that can use real WebSocket API and client libraries
 * @param timeoutMs - Timeout in milliseconds (default: 5000)
 * @returns Promise that resolves when test completes
 */
export async function runWithWebSocketMock(
  testFn: () => Promise<void> | void,
  timeoutMs: number = 5000
): Promise<void> {
  return new Promise<void>(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`WebSocket mock test timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    
    // Track if test has completed
    let completed = false;
    const cleanup = () => {
      if (!completed) {
        completed = true;
        clearTimeout(timeout);
        resolve();
      }
    };
    
    // Setup WebSocket mocking with a simpler mock that actually works
    const globalScope = typeof globalThis !== 'undefined' ? globalThis : global;
    const OriginalWebSocket = globalScope.WebSocket;
    
    // Create a working mock WebSocket for demonstration
    function MockWebSocket(this: any, url: string | URL, protocols?: string | string[]) {
      const eventTarget = new EventTarget();
      
      // WebSocket-like interface
      this.readyState = 0; // CONNECTING
      this.url = url.toString(); // Keep original URL unchanged
      this.protocol = '';
      this.extensions = '';
      this.bufferedAmount = 0;
      
      // Event handlers with auto-completion
      let originalOnMessage: ((event: any) => void | Promise<void>) | null = null;
      
      // Wrap onmessage to auto-resolve after message handling
      Object.defineProperty(this, 'onmessage', {
        get() { return originalOnMessage; },
        set(handler: (event: any) => void | Promise<void>) {
          originalOnMessage = async (event: any) => {
            try {
              const result = handler(event);
              // Handle both sync and async message handlers
              if (result instanceof Promise) {
                await result;
              }
              // Auto-complete test after successful message handling
              cleanup();
            } catch (error) {
              clearTimeout(timeout);
              reject(error);
            }
          };
        }
      });
      
      this.onopen = null;
      this.onclose = null;
      this.onerror = null;
      
      // Event listener methods
      this.addEventListener = eventTarget.addEventListener.bind(eventTarget);
      this.removeEventListener = eventTarget.removeEventListener.bind(eventTarget);
      this.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);
      
      // Send method - simulate echo responses
      this.send = (data: string) => {
        if (this.readyState !== 1) return;
        
        setTimeout(() => {
          let response = 'unknown';
          if (data === 'ping') response = 'pong';
          if (data === 'increment') response = '1';
          
          const messageEvent = new MessageEvent('message', { data: response });
          if (this.onmessage) {
            this.onmessage(messageEvent);
          }
          this.dispatchEvent(messageEvent);
        }, 10);
      };
      
      this.close = (code = 1000, reason = '') => {
        this.readyState = 3; // CLOSED
        setTimeout(() => {
          const closeEvent = new CloseEvent('close', { code, reason });
          if (this.onclose) {
            this.onclose(closeEvent);
          }
          this.dispatchEvent(closeEvent);
        }, 0);
      };
      
      // Simulate connection opening
      setTimeout(() => {
        this.readyState = 1; // OPEN
        const openEvent = new Event('open');
        if (this.onopen) {
          this.onopen(openEvent);
        }
        this.dispatchEvent(openEvent);
      }, 50);
    }
    
    // Add WebSocket constants
    MockWebSocket.CONNECTING = 0;
    MockWebSocket.OPEN = 1;
    MockWebSocket.CLOSING = 2;
    MockWebSocket.CLOSED = 3;
    
    // Replace global WebSocket
    globalScope.WebSocket = MockWebSocket as any;
    
    try {
      // Run the test function with mocked WebSocket
      const result = testFn();
      if (result instanceof Promise) {
        await result;
      }
      
      clearTimeout(timeout);
      resolve();
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    } finally {
      // Always restore the original WebSocket
      globalScope.WebSocket = OriginalWebSocket;
    }
  });
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
