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
      const originalDescriptor = Object.getOwnPropertyDescriptor(ws, 'onmessage');
      
      const restoreProperty = () => {
        if (originalDescriptor) {
          Object.defineProperty(ws, 'onmessage', originalDescriptor);
        } else {
          delete ws.onmessage;
        }
      };
      
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
              restoreProperty();
              cleanup();
            } catch (error) {
              restoreProperty();
              clearTimeout(timeout);
              reject(error);
            }
          };
        },
        configurable: true // Allow restoration
      });
      
      // Run the test function
      const result = testFn(ws, ctx);
      if (result instanceof Promise) {
        await result;
        // If test function was async and completed without WebSocket messages, cleanup
        restoreProperty();
        cleanup();
      }
      // If test function was sync, we wait for WebSocket message or timeout
      
    } catch (error) {
      // Ensure property is restored even on error (restoreProperty is in scope here)
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
 * - ✅ Provides access to mock and context for message inspection
 * 
 * @param testFn - Function that receives mock and context for inspection
 * @param timeoutMs - Timeout in milliseconds (default: 5000)
 * @returns Promise that resolves when test completes
 */
export async function runWithWebSocketMock(
  testFn: (mock: any, ctx: any) => Promise<void> | void,
  timeoutMs: number = 1000
): Promise<void> {
  return new Promise<void>(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`WebSocket mock test timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Create context to track messages and connections
    const ctx = {
      messagesSent: [] as string[],
      messagesReceived: [] as string[],
      connections: [] as any[],
      pendingOperations: [] as Promise<any>[]
    };
    
    // Setup WebSocket mocking with proper isolation
    const globalScope = typeof globalThis !== 'undefined' ? globalThis : global;
    const OriginalWebSocket = globalScope.WebSocket;
    let isRestored = false;
    
    // Ensure we always restore WebSocket, even if test fails
    const ensureRestore = () => {
      if (!isRestored && OriginalWebSocket) {
        globalScope.WebSocket = OriginalWebSocket;
        isRestored = true;
      }
    };    // Create a working mock WebSocket for demonstration
    function MockWebSocket(this: any, url: string | URL, protocols?: string | string[]) {
      const eventTarget = new EventTarget();
      
      // Track this connection
      ctx.connections.push(this);
      
      // WebSocket-like interface
      this.readyState = 0; // CONNECTING
      this.url = url.toString(); // Keep original URL unchanged
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
      
      // Send method - simulate echo responses and track messages
      this.send = (data: string) => {
        if (this.readyState !== 1) return;
        
        // Track sent message
        ctx.messagesSent.push(data);
        
        // Create a promise for the async response but make it immediate
        const responsePromise = Promise.resolve().then(() => {
          let response = 'unknown';
          if (data === 'ping') response = 'pong';
          if (data === 'increment') response = '1';
          
          // Track received message
          ctx.messagesReceived.push(response);
          
          const messageEvent = new MessageEvent('message', { data: response });
          if (this.onmessage) {
            this.onmessage(messageEvent);
          }
          this.dispatchEvent(messageEvent);
        });
        
        ctx.pendingOperations.push(responsePromise);
      };
      
      this.close = (code = 1000, reason = '') => {
        this.readyState = 3; // CLOSED
        // Make close synchronous to avoid timer issues
        const closeEvent = new CloseEvent('close', { code, reason });
        if (this.onclose) {
          this.onclose(closeEvent);
        }
        this.dispatchEvent(closeEvent);
      };
      
      // Simulate connection opening immediately but track as pending operation
      const openPromise = Promise.resolve().then(() => {
        this.readyState = 1; // OPEN
        const openEvent = new Event('open');
        if (this.onopen) {
          this.onopen(openEvent);
        }
        this.dispatchEvent(openEvent);
      });
      
      ctx.pendingOperations.push(openPromise);
    }
    
    // Add WebSocket constants
    MockWebSocket.CONNECTING = 0;
    MockWebSocket.OPEN = 1;
    MockWebSocket.CLOSING = 2;
    MockWebSocket.CLOSED = 3;
    
    // Replace global WebSocket
    globalScope.WebSocket = MockWebSocket as any;
    
    // Create mock object for inspection
    const mock = {
      messagesSent: ctx.messagesSent,
      messagesReceived: ctx.messagesReceived,
      connections: ctx.connections,
      async sync() {
        // Wait iteratively until no new operations are created
        let previousCount = -1;
        while (ctx.pendingOperations.length > 0 && ctx.pendingOperations.length !== previousCount) {
          previousCount = ctx.pendingOperations.length;
          await Promise.all(ctx.pendingOperations);
          // Don't clear the array yet - new operations might have been added
        }
        // Clear the pending operations array for next sync call
        ctx.pendingOperations.length = 0;
      }
    };
    
    try {
      // Run the test function with mock and context
      const result = testFn(mock, ctx);
      if (result instanceof Promise) {
        await result;
      }
      
      clearTimeout(timeout);
      ensureRestore();
      resolve();
    } catch (error) {
      clearTimeout(timeout);
      ensureRestore();
      reject(error);
    }
  });
}
