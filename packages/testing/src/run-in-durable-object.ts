import {
  env,
  createExecutionContext,
  runInDurableObject as cloudflareRunInDurableObject,
  waitOnExecutionContext,
// @ts-expect-error - cloudflare:test module types are not consistently exported
} from 'cloudflare:test';

import { WSUpgradeOptions } from './types.js';

/**
 * Get all Durable Object binding names from the environment.
 */
function getDurableObjectBindings(env: Record<string, any>): string[] {
  return Object.keys(env).filter(key => {
    const value = env[key];
    // Check if it looks like a DurableObjectNamespace
    // (has getByName, idFromName, etc. methods)
    return value && 
           typeof value === 'object' && 
           typeof value.getByName === 'function' &&
           typeof value.idFromName === 'function';
  });
}

/**
 * Get a Durable Object namespace from the environment.
 * If there's exactly one, use it. If there are multiple, throw an error.
 */
function getDurableObjectNamespace(env: Record<string, any>): any {
  const bindings = getDurableObjectBindings(env);
  
  if (bindings.length === 0) {
    throw new Error('No Durable Object bindings found in environment');
  }
  
  if (bindings.length > 1) {
    throw new Error(`Multiple Durable Object bindings found: ${bindings.join(', ')}. Please specify which one to use explicitly by passing a stub instead of a test function.`);
  }
  
  return env[bindings[0]];
}

/**
 * Creates a wrapped instance that intercepts fetch() calls to queue them through input gate simulation
 */
function createWrappedInstance<T extends object>(instance: T, mock: any): T {
  // Create a proxy that intercepts fetch method calls
  return new Proxy(instance, {
    get(target, prop, receiver) {
      if (prop === 'fetch' && typeof (target as any)[prop] === 'function') {
        // Return a wrapped version of fetch that goes through the operation queue
        return function(request: Request) {
          return mock._queueOperation(async () => {
            return await (target as any).fetch(request);
          });
        };
      }
      // For all other properties, return the original value
      return Reflect.get(target, prop, receiver);
    }
  });
}

/**
 * A drop-in replacement (superset) for Cloudflare's runInDurableObject.
 * This adds an optional WebSocket mock parameter to the end of the test callback function so you
 * can gradually add WebSocket testing to your current Durable Object tests. This mock is 
 * monkey-patched into the environment so even libraries that use the browser's native WebSocket API
 * (like AgentClient) can be part of the test
 * 
 * @param durableObjectStubOrTestFn - The Durable Object stub to run within, or the test function if auto-creating stub
 * @param testFnOrOptions - Function that receives instance, DurableObjectState, and mock, or options if first param is test function
 * @param options - Options object with timeout and WebSocket configuration (when first param is stub)
 */
export async function runInDurableObject<T extends object>(
  durableObjectStubOrTestFn: any | ((instance: T, ctx: any, mock?: any) => Promise<void> | void),
  testFnOrOptions?: ((instance: T, ctx: any, mock?: any) => Promise<void> | void) | WSUpgradeOptions,
  options?: WSUpgradeOptions
): Promise<void> {
  // Handle overloaded signature - determine if first parameter is stub or test function
  let durableObjectStub: any;
  let testFn: (instance: T, ctx: any, mock?: any) => Promise<void> | void;
  let actualOptions: WSUpgradeOptions | undefined;

  if (typeof durableObjectStubOrTestFn === 'function') {
    // First parameter is the test function, auto-create stub
    const durableObjectNamespace = getDurableObjectNamespace(env);
    const id = durableObjectNamespace.newUniqueId();
    durableObjectStub = durableObjectNamespace.get(id);
    testFn = durableObjectStubOrTestFn;
    actualOptions = testFnOrOptions as WSUpgradeOptions | undefined;
  } else {
    // First parameter is the stub, use traditional signature
    durableObjectStub = durableObjectStubOrTestFn;
    testFn = testFnOrOptions as (instance: T, ctx: any, mock?: any) => Promise<void> | void;
    actualOptions = options;
  }

  const actualTimeoutMs = actualOptions?.timeout ?? 1000;

  return cloudflareRunInDurableObject(durableObjectStub, async (instance: T, ctx: any) => {
    // Create a separate ExecutionContext for waitUntil tracking
    // Note: ctx here is DurableObjectState, but we need ExecutionContext for waitOnExecutionContext
    const execCtx = createExecutionContext();
    await runWebSocketMockInternal((mock: any) => {
      // Create a wrapped instance that intercepts fetch() calls to queue them through input gate simulation
      const wrappedInstance = createWrappedInstance(instance, mock);
      return testFn(wrappedInstance, ctx, mock);
    }, execCtx, instance, ctx, actualTimeoutMs, actualOptions);
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
  timeoutMs: number = 1000,
  options?: WSUpgradeOptions
): Promise<void> {
  return new Promise<void>(async (resolve, reject) => {
    // Create mock object for inspection and tracking
    const mock = {
      messagesSent: [] as string[],        // Client → Server (what test sent to DO)
      messagesReceived: [] as string[],    // Server → Client (what DO sent back to test)
      pendingOperations: [] as Promise<any>[],
      clientCloses: [] as {code: number, reason: string, timestamp: number}[],
      
      // Input gate simulation: serialize all DO operations to prevent race conditions
      _operationQueue: Promise.resolve() as Promise<any>,
      
      // Queue a DO operation to run serially (simulates Cloudflare's input gates)
      _queueOperation<T>(operation: () => Promise<T> | T): Promise<T> {
        const promise = this._operationQueue.then(async () => {
          return await operation();
        });
        this._operationQueue = promise.catch(() => {}); // Continue queue even if operation fails
        return promise;
      },
      
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
        
        // Wait for the operation queue to finish (ensures all DO operations complete)
        await this._operationQueue;
        
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
        // Use the operation queue to serialize DO calls (simulates Cloudflare's input gates)
        const responsePromise = mock._queueOperation(async () => {
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
        const closePromise = mock._queueOperation(async () => {
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
      const openPromise = mock._queueOperation(async () => {
        if (instance && typeof (instance as any).fetch === 'function') {
          // Build headers, starting with WebSocket upgrade headers
          const baseHeaders: Record<string, string> = {
            'Upgrade': 'websocket',
            'Connection': 'upgrade'
          };

          // Add shorthand headers if provided
          if (options?.protocols) {
            baseHeaders['Sec-WebSocket-Protocol'] = options.protocols.join(', ');
          }
          
          // Set origin - use explicit origin or derive from URL (for testing convenience)
          const origin = options?.origin || new URL(url.toString()).origin;
          baseHeaders['Origin'] = origin;

          // Merge with custom headers (custom headers override shorthand options)
          const finalHeaders = Object.assign(baseHeaders, options?.headers || {});

          // Create a proper WebSocket upgrade request
          const upgradeRequest = new Request(url.toString(), {
            method: 'GET',
            headers: finalHeaders
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
    
    const timeoutPromise = new Promise<never>((_, timeoutReject) => {
      setTimeout(() => {
        ensureRestore();
        timeoutReject(new Error(`WebSocket mock test timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    
    const testPromise = async () => {
      // Run the test function with mock
      const result = testFn(mock);
      if (result instanceof Promise) {
        await result;
      }
      ensureRestore();
    };
    
    try {
      await Promise.race([testPromise(), timeoutPromise]);
      resolve();
    } catch (error) {
      ensureRestore();
      reject(error);
    }
  });
}