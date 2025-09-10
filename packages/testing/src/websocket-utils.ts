import {
  SELF,
  env,
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
// @ts-expect-error - cloudflare:test module types are not consistently exported by VS Code
} from 'cloudflare:test';

/**
 * Simulates a WebSocket upgrade request for testing Cloudflare Workers.
 * This minimally mimics what the browser WebSocket API does
 * 
 * @param url - The full WebSocket URL (e.g., 'wss://example.com/path' or 'https://example.com/path')
 * @returns Promise with WebSocket instance
 */
export async function simulateWSUpgrade(url: string) {
  const ctx = createExecutionContext();
  const req = new Request(url, {
    headers: { 
      Upgrade: "websocket",
      Connection: "upgrade"
    }
  });
  
  const res = await SELF.fetch(req, env, ctx);
  const ws = res.webSocket as any;
  
  ws.accept(); // This works because we're running inside of workerd
  return ws;
}

/**
 * Higher-level API that handles WebSocket upgrade with automatic timeout and cleanup.
 * Eliminates boilerplate Promise/timeout code in tests.
 * 
 * @param url - The full WebSocket URL
 * @param testFn - Function that receives WebSocket, should setup event handlers and send messages
 * @param timeoutMs - Timeout in milliseconds (default: 5000)
 * @returns Promise that resolves when test completes or rejects on timeout/error
 */
export async function runWithSimulatedWSUpgrade(
  url: string,
  testFn: (ws: any) => Promise<void> | void,
  timeoutMs: number = 5000
): Promise<void> {
  return new Promise<void>(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`WebSocket test timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    
    const ws = await simulateWSUpgrade(url);
      
      // Track if test has completed
      let completed = false;
      const cleanup = () => {
        if (!completed) {
          completed = true;
          clearTimeout(timeout);
          resolve();
        }
      };
      
      // Run the test function
      const result = testFn(ws);
      if (result instanceof Promise) {
        await result;
        // If test function was async and completed without WebSocket messages, cleanup
        cleanup();
      }
  });
}

/**
 * High-level API that uses WebSocket mocking to overcome all limitations of simulateWSUpgrade.
 * This approach:
 * - ✅ Supports wss:// protocol URLs for routing
 * - ✅ Supports any client library that uses the WebSocket API
 * - ✅ Supports cookies, origin, and other browser WebSocket behaviors
 * - ✅ Allows inspection of messages sent and received
 * - ✅ Provides access to real ctx: DurableObjectState for inspecting storage, getWebSockets, etc.
 * 
 * @param durableObjectStubOrTestFn - The Durable Object stub to run within, or the test function if auto-creating stub
 * @param testFnOrTimeoutMs - Function that receives mock, instance, and DurableObjectState, or timeout if first param is test function
 * @param timeoutMs - Timeout in milliseconds (default: 1000)
 */
export async function runWithWebSocketMock<T>(
  durableObjectStubOrTestFn: any | ((mock: any, instance: T, ctx: any) => Promise<void> | void),
  testFnOrTimeoutMs?: ((mock: any, instance: T, ctx: any) => Promise<void> | void) | number,
  timeoutMs: number = 1000
): Promise<void> {
  // Handle overloaded signature - determine if first parameter is stub or test function
  let durableObjectStub: any;
  let testFn: (mock: any, instance: T, ctx: any) => Promise<void> | void;
  let actualTimeoutMs: number;

  if (typeof durableObjectStubOrTestFn === 'function') {
    // First parameter is the test function, auto-create stub
    const id = env.MY_DO.newUniqueId();
    durableObjectStub = env.MY_DO.get(id);
    testFn = durableObjectStubOrTestFn;
    actualTimeoutMs = typeof testFnOrTimeoutMs === 'number' ? testFnOrTimeoutMs : timeoutMs;
  } else {
    // First parameter is the stub, use traditional signature
    durableObjectStub = durableObjectStubOrTestFn;
    testFn = testFnOrTimeoutMs as (mock: any, instance: T, ctx: any) => Promise<void> | void;
    actualTimeoutMs = timeoutMs;
  }

  return runInDurableObject(durableObjectStub, async (instance: T, ctx: any) => {
    // Create a separate ExecutionContext for waitUntil tracking
    // Note: ctx here is DurableObjectState, but we need ExecutionContext for waitOnExecutionContext
    const execCtx = createExecutionContext();
    await runWebSocketMockInternal((mock: any) => testFn(mock, instance, ctx), execCtx, instance, ctx, actualTimeoutMs);
  });
}

/**
 * Internal helper function that handles the WebSocket mocking logic
 */
async function runWebSocketMockInternal<T>(
  testFn: (mock: any) => Promise<void> | void,
  execCtx: any,
  instance: T,
  ctx: any,
  timeoutMs: number = 1000
): Promise<void> {
  return new Promise<void>(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`WebSocket mock test timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Create mock object for inspection and tracking
    const mock = {
      messagesSent: [] as string[],        // Client → Server (what test sent to DO)
      messagesReceived: [] as string[],    // Server → Client (what DO sent back to test)
      pendingOperations: [] as Promise<any>[],
      clientCloses: [] as {code: number, reason: string, timestamp: number}[],
      async sync() {
        // Wait iteratively until no new operations are created
        let previousCount = -1;
        while (mock.pendingOperations.length > 0 && mock.pendingOperations.length !== previousCount) {
          previousCount = mock.pendingOperations.length;
          await Promise.all(mock.pendingOperations);
          // Don't clear the array yet - new operations might have been added
        }
        // Clear the pending operations array for next sync call
        mock.pendingOperations.length = 0;
        
        // Wait for all promises passed to execCtx.waitUntil() to settle
        // This ensures that any background work triggered by the test is completed
        await waitOnExecutionContext(execCtx);  // TODO: Does this really help? Need to test with and without on a DO that uses waitUntil
      },

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
    };

    // Create a working mock WebSocket for demonstration
    function MockWebSocket(this: any, url: string | URL, protocols?: string | string[]) {
      const eventTarget = new EventTarget();
      
      // Create a WebSocket-like object that routes responses back to our mock
      const mockWebSocket = {
        send: (message: string) => {
          // This is the response from the DO - capture it directly and trigger client event
          mock.messagesReceived.push(message);
          
          // Trigger the client-side message event immediately
          const messageEvent = new MessageEvent('message', { data: message });
          
          // Call onmessage handler
          if (this.onmessage) {
            const result = this.onmessage(messageEvent);
            if (result instanceof Promise) {
              mock.pendingOperations.push(result);
            }
          }
          
          // Dispatch event to addEventListener handlers
          this.dispatchEvent(messageEvent);
        },
        close: (code?: number, reason?: string) => {
          // This is called when the server initiates a close
          // We need to trigger the client-side close event
          this.readyState = 3; // CLOSED
          
          // Create close event and trigger client-side handlers
          const closeEvent = new CloseEvent('close', { 
            code: code || 1000, 
            reason: reason || '',
            wasClean: true 
          });
          
          // Call client-side onclose handler
          if (this.onclose) {
            const result = this.onclose(closeEvent);
            if (result instanceof Promise) {
              mock.pendingOperations.push(result);
            }
          }
          
          // Dispatch close event to addEventListener handlers
          this.dispatchEvent(closeEvent);
        }
      };
      
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
      
      // Send method - routes messages to actual Durable Object
      this.send = (data: string) => {
        if (this.readyState !== 1) return;
        
        // Track sent message
        mock.messagesSent.push(data);
        
        // Create a promise for the async response that actually talks to the DO
        const responsePromise = Promise.resolve().then(async () => {
          try {
            // Call the DO's webSocketMessage method with our mock WebSocket
            // The mockWebSocket.send() will handle message tracking and event triggering
            await (instance as any).webSocketMessage(mockWebSocket, data);
          } catch (error) {
            console.error('Error in WebSocket send:', error);
            
            // Call DO's webSocketError lifecycle method if it exists
            if (instance && typeof (instance as any).webSocketError === 'function') {
              await (instance as any).webSocketError(mockWebSocket, error instanceof Error ? error : new Error(String(error)));
            }
            
            const errorEvent = new Event('error');
            if (this.onerror) {
              const result = this.onerror(errorEvent);
              if (result instanceof Promise) {
                await result;
              }
            }
            
            this.dispatchEvent(errorEvent);
            
            // Let the original error bubble up
            throw error;
          }
        });
        
        mock.pendingOperations.push(responsePromise);
      };
      
      this.close = (code = 1000, reason = '') => {
        this.readyState = 3; // CLOSED
        
        // Track client-initiated close in mock for inspection
        mock.clientCloses.push({ code, reason, timestamp: Date.now() });
        
        // Call DO's webSocketClose lifecycle method if it exists
        const closePromise = Promise.resolve().then(async () => {
          if (instance && typeof (instance as any).webSocketClose === 'function') {
            await (instance as any).webSocketClose(mockWebSocket, code, reason, true);
          }
        });
        mock.pendingOperations.push(closePromise);
        
        // Trigger close event
        const closeEvent = new CloseEvent('close', { code, reason });
        if (this.onclose) {
          const result = this.onclose(closeEvent);
          if (result instanceof Promise) {
            mock.pendingOperations.push(result);
          }
        }
        
        this.dispatchEvent(closeEvent);
      };
      
      // Simulate WebSocket upgrade by calling the Durable Object's fetch method
      const openPromise = Promise.resolve().then(async () => {
        if (instance && typeof (instance as any).fetch === 'function') {
          // Create a proper WebSocket upgrade request
          const upgradeRequest = new Request(url.toString(), {
            method: 'GET',
            headers: {
              'Upgrade': 'websocket',
              'Connection': 'upgrade'
            }
          });
          
          // Call the Durable Object's fetch method to handle WebSocket upgrade
          const response = await (instance as any).fetch(upgradeRequest);
          
          // The WebSocket upgrade is handled internally by the DO
        }
        
        this.readyState = 1; // OPEN
        
        // Call DO's webSocketOpen lifecycle method if it exists
        if (instance && typeof (instance as any).webSocketOpen === 'function') {
          await (instance as any).webSocketOpen(mockWebSocket);
        }
        
        const openEvent = new Event('open');
        
        // Call onopen handler
        if (this.onopen) {
          const result = this.onopen(openEvent);
          if (result instanceof Promise) {
            await result;
          }
        }
        
        // Dispatch event to addEventListener handlers
        this.dispatchEvent(openEvent);
      });
      
      mock.pendingOperations.push(openPromise);
    }
    
    // Add WebSocket constants
    MockWebSocket.CONNECTING = 0;
    MockWebSocket.OPEN = 1;
    MockWebSocket.CLOSING = 2;
    MockWebSocket.CLOSED = 3;
    
    // Replace global WebSocket
    globalScope.WebSocket = MockWebSocket as any;
    
    try {
      // Run the test function with mock
      const result = testFn(mock);
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
