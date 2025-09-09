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
        },
        configurable: true
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
 * - ✅ Supports any client library that uses the WebSocket API
 * - ✅ Supports cookies, origin, and other browser WebSocket behaviors
 * - ✅ Allows inspection of messages sent and received
 * - ✅ Provides access to real ExecutionContext for storage inspection
 * 
 * @param durableObjectStub - The Durable Object stub to run within
 * @param testFn - Function that receives mock, instance, and DurableObjectState
 * @param timeoutMs - Timeout in milliseconds (default: 1000)
 */
export async function runWithWebSocketMock<T>(
  durableObjectStub: any,
  testFn: (mock: any, instance: T, ctx: any) => Promise<void> | void,
  timeoutMs: number = 1000
): Promise<void> {
  return runInDurableObject(durableObjectStub, async (instance: T, ctx: any) => {
    // Create a separate ExecutionContext for waitUntil tracking
    // Note: ctx here is DurableObjectState, but we need ExecutionContext for waitOnExecutionContext
    const execCtx = createExecutionContext();
    await runWebSocketMockInternal((mock: any) => testFn(mock, instance, ctx), execCtx, instance, timeoutMs);
  });
}

/**
 * Internal helper function that handles the WebSocket mocking logic
 */
async function runWebSocketMockInternal<T>(
  testFn: (mock: any) => Promise<void> | void,
  execCtx: any,
  instance: T,
  timeoutMs: number = 1000
): Promise<void> {
  return new Promise<void>(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`WebSocket mock test timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Create a mock connection that can communicate with the Durable Object
    const sentMessages: string[] = [];
    let attachment: any = null;
    let testError: Error | null = null;
    
    const mockConnection = {
      deserializeAttachment: () => attachment,
      serializeAttachment: (obj: object) => { attachment = obj; },
      send: (message: string) => {
        sentMessages.push(message);
      },
      close: (code?: number, reason?: string) => {
        console.debug('Mock connection close called', { code, reason });  // TODO: Should we store this to inspect later? Is the client-side close code? How do we see the server-side?
      },
      toString: () => 'mock-connection-websocket-test'
    };

    // Create mock object for inspection and tracking
    const mock = {
      messagesSent: [] as string[],
      messagesReceived: [] as string[],
      connections: [] as any[],
      pendingOperations: [] as Promise<any>[],
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
        
        // Check if any event handlers threw errors and rethrow them
        if (testError) {
          throw testError;
        }
      },
      // Helper methods to access mock connection state
      getLastResponse: () => sentMessages[sentMessages.length - 1],
      getAllResponses: () => [...sentMessages],
      clearResponses: () => sentMessages.length = 0
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
      
      // Track this connection
      mock.connections.push(this);
      
      // Create a WebSocket-like object that routes responses back to our mock
      const mockWebSocket = {
        send: (message: string) => {
          // This is the response from the DO - capture it
          mock.clearResponses();
          mockConnection.send(message);
        },
        deserializeAttachment: () => mockConnection.deserializeAttachment(),
        serializeAttachment: (obj: object) => mockConnection.serializeAttachment(obj),
        close: (code?: number, reason?: string) => mockConnection.close(code, reason)
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
            // Clear any previous responses to ensure we get the latest
            mock.clearResponses();
            
            // Check if the instance has a webSocketMessage method (like our test harness)
            if (instance && typeof (instance as any).webSocketMessage === 'function') {
              // Call the DO's webSocketMessage method with our mock WebSocket
              await (instance as any).webSocketMessage(mockWebSocket, data);
              
              // Get the response that was sent via mockWebSocket.send() -> mockConnection.send()
              const response = mock.getLastResponse();
              if (response) {
                // Track received message
                mock.messagesReceived.push(response);
                
                const messageEvent = new MessageEvent('message', { data: response });
                
                // Safely call onmessage handler and catch any errors
                if (this.onmessage) {
                  try {
                    const result = this.onmessage(messageEvent);
                    if (result instanceof Promise) {
                      await result;
                    }
                  } catch (error) {
                    testError = error instanceof Error ? error : new Error(String(error));
                  }
                }
                
                // Safely dispatch event and catch any errors from addEventListener handlers
                try {
                  this.dispatchEvent(messageEvent);
                } catch (error) {
                  if (!testError) {
                    testError = error instanceof Error ? error : new Error(String(error));
                  }
                }
              }
            } else {
              // Fallback to simple echo responses for DOs that don't have webSocketMessage
              let response = 'unknown';
              if (data === 'ping') response = 'pong';
              if (data === 'increment') response = '1';
              
              // Track received message
              mock.messagesReceived.push(response);
              
              const messageEvent = new MessageEvent('message', { data: response });
              
              // Safely call onmessage handler and catch any errors
              if (this.onmessage) {
                try {
                  const result = this.onmessage(messageEvent);
                  if (result instanceof Promise) {
                    await result;
                  }
                } catch (error) {
                  testError = error instanceof Error ? error : new Error(String(error));
                }
              }
              
              // Safely dispatch event and catch any errors from addEventListener handlers
              try {
                this.dispatchEvent(messageEvent);
              } catch (error) {
                if (!testError) {
                  testError = error instanceof Error ? error : new Error(String(error));
                }
              }
            }
          } catch (error) {
            console.error('Error in WebSocket send:', error);
            
            // Call DO's webSocketError lifecycle method if it exists
            try {
              if (instance && typeof (instance as any).webSocketError === 'function') {
                await (instance as any).webSocketError(mockWebSocket, error instanceof Error ? error : new Error(String(error)));
              }
            } catch (errorHandlerError) {
              console.error('Error in webSocketError handler:', errorHandlerError);
            }
            
            const errorEvent = new Event('error');
            if (this.onerror) {
              try {
                const result = this.onerror(errorEvent);
                if (result instanceof Promise) {
                  await result;
                }
              } catch (handlerError) {
                testError = handlerError instanceof Error ? handlerError : new Error(String(handlerError));
              }
            }
            
            try {
              this.dispatchEvent(errorEvent);
            } catch (dispatchError) {
              if (!testError) {
                testError = dispatchError instanceof Error ? dispatchError : new Error(String(dispatchError));
              }
            }
            
            testError = error instanceof Error ? error : new Error(String(error));
          }
        });
        
        mock.pendingOperations.push(responsePromise);
      };
      
      this.close = (code = 1000, reason = '') => {
        this.readyState = 3; // CLOSED
        
        // Call DO's webSocketClose lifecycle method if it exists
        const closePromise = Promise.resolve().then(async () => {
          try {
            if (instance && typeof (instance as any).webSocketClose === 'function') {
              await (instance as any).webSocketClose(mockWebSocket, code, reason, true);
            }
          } catch (error) {
            // If webSocketClose throws an error, call webSocketError
            if (instance && typeof (instance as any).webSocketError === 'function') {
              try {
                await (instance as any).webSocketError(mockWebSocket, error instanceof Error ? error : new Error(String(error)));
              } catch (errorHandlerError) {
                console.error('Error in webSocketError handler:', errorHandlerError);
              }
            }
            testError = error instanceof Error ? error : new Error(String(error));
          }
        });
        mock.pendingOperations.push(closePromise);
        
        // Trigger close event
        const closeEvent = new CloseEvent('close', { code, reason });
        if (this.onclose) {
          try {
            const result = this.onclose(closeEvent);
            if (result instanceof Promise) {
              mock.pendingOperations.push(result);
            }
          } catch (error) {
            testError = error instanceof Error ? error : new Error(String(error));
          }
        }
        
        try {
          this.dispatchEvent(closeEvent);
        } catch (error) {
          if (!testError) {
            testError = error instanceof Error ? error : new Error(String(error));
          }
        }
      };
      
      // Simulate connection opening immediately but track as pending operation
      const openPromise = Promise.resolve().then(async () => {
        this.readyState = 1; // OPEN
        
        // Call DO's webSocketOpen lifecycle method if it exists
        try {
          if (instance && typeof (instance as any).webSocketOpen === 'function') {
            await (instance as any).webSocketOpen(mockWebSocket);
          }
        } catch (error) {
          // If webSocketOpen throws an error, call webSocketError
          if (instance && typeof (instance as any).webSocketError === 'function') {
            try {
              await (instance as any).webSocketError(mockWebSocket, error instanceof Error ? error : new Error(String(error)));
            } catch (errorHandlerError) {
              console.error('Error in webSocketError handler:', errorHandlerError);
            }
          }
          testError = error instanceof Error ? error : new Error(String(error));
        }
        
        const openEvent = new Event('open');
        
        // Safely call onopen handler and catch any errors
        if (this.onopen) {
          try {
            const result = this.onopen(openEvent);
            if (result instanceof Promise) {
              await result;
            }
          } catch (error) {
            testError = error instanceof Error ? error : new Error(String(error));
          }
        }
        
        // Safely dispatch event and catch any errors from addEventListener handlers
        try {
          this.dispatchEvent(openEvent);
        } catch (error) {
          if (!testError) {
            testError = error instanceof Error ? error : new Error(String(error));
          }
        }
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
