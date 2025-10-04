import type { OperationChain, RemoteFunctionMarker, RpcClientConfig, RpcClientProxy, RpcTransport } from './types';
import { isRemoteFunctionMarker } from './types';
import { HttpPostRpcTransport } from './http-post-transport';
import { WebSocketRpcTransport } from './websocket-rpc-transport';
import { convertRemoteFunctionsToStrings } from './object-inspection';

/**
 * Creates an RPC client that proxies method calls to a remote Durable Object.
 * Connection is established automatically on first method call (lazy connection).
 * Use 'await using' for automatic cleanup, or manually manage lifecycle.
 * 
 * @see [Usage Examples](https://lumenize.com/docs/rpc/quick-start#creating-an-rpc-client) - Complete tested examples
 * 
 * @typeParam T - The type of the Durable Object being called. Use {@link RpcAccessible} to expose protected properties like `ctx` and `env`.
 * @param config - Configuration for the RPC client
 * @returns A proxy object with both lifecycle methods and DO method calls
 */
export function createRpcClient<T>(config: RpcClientConfig): T & RpcClientProxy {
  const client = new RpcClient<T>(config);
  return client as any; // Constructor returns Proxy, so type is correct
}

/**
 * RPC Client that maintains a persistent connection to a Durable Object.
 * The constructor returns a Proxy that forwards unknown methods to the DO.
 */
export class RpcClient<T> {
  #config: Required<Omit<RpcClientConfig, 'doBindingName' | 'doInstanceNameOrId' | 'WebSocketClass'>> & { 
    doBindingName: string;
    doInstanceNameOrId: string;
    WebSocketClass?: RpcClientConfig['WebSocketClass'];
  };
  #transport: RpcTransport | null = null;
  #doProxy: T | null = null;

  constructor(config: RpcClientConfig) {
    // Set defaults and merge with user config
    this.#config = {
      transport: 'websocket',
      prefix: '/__rpc',
      baseUrl: typeof location !== 'undefined' ? location.origin : 'http://localhost:8787',
      timeout: 30000,
      fetch: globalThis.fetch,
      headers: {},
      WebSocketClass: WebSocket,
      ...config
    };

    // Create the DO proxy handler
    const proxyHandler = new ProxyHandler(this);
    this.#doProxy = new Proxy(() => {}, proxyHandler) as T;

    // Return a Proxy that merges lifecycle methods with DO methods
    // NOTE: Coverage tools may not properly instrument Proxy trap handlers
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        // Handle disposal symbols for explicit resource management
        // Bind to the target (RpcClient instance) not the receiver (proxy)
        if (prop === Symbol.asyncDispose || prop === Symbol.dispose) {
          const method = Reflect.get(target, prop, target); // Use target as receiver
          return typeof method === 'function' ? method.bind(target) : method;
        }

        // Delegate all other property access to the DO proxy
        return Reflect.get(this.#doProxy as any, prop, receiver);
      }
    }) as any;
  }

  // Internal method to establish connection (called lazily on first execute)
  private async connect(): Promise<void> {
    if (this.#transport?.isConnected?.()) {
      return; // Already connected
    }

    // Create transport based on configuration
    this.#transport = this.createTransport();

    // Call transport's connect() if it exists (for stateful transports like WebSocket)
    if (this.#transport.connect) {
      await this.#transport.connect();
    }
  }

  private createTransport(): RpcTransport {
    if (this.#config.transport === 'http') {
      // Create HTTP POST transport
      return new HttpPostRpcTransport({
        baseUrl: this.#config.baseUrl,
        prefix: this.#config.prefix,
        doBindingName: this.#config.doBindingName,
        doInstanceNameOrId: this.#config.doInstanceNameOrId,
        timeout: this.#config.timeout,
        fetch: this.#config.fetch,
        headers: this.#config.headers
      });
    } else {
      // Create WebSocket transport (default)
      return new WebSocketRpcTransport({
        baseUrl: this.#config.baseUrl,
        prefix: this.#config.prefix,
        doBindingName: this.#config.doBindingName,
        doInstanceNameOrId: this.#config.doInstanceNameOrId,
        timeout: this.#config.timeout,
        WebSocketClass: this.#config.WebSocketClass
      });
    }
  }

  // Internal method to disconnect (called by Symbol.asyncDispose)
  private async disconnect(): Promise<void> {
    if (!this.#transport) {
      return; // No transport to disconnect
    }

    // Call transport's disconnect() if it exists (for stateful transports like WebSocket)
    if (this.#transport.disconnect) {
      await this.#transport.disconnect();
    }

    // Clean up transport
    this.#transport = null;
  }

  // Explicit resource management (Symbol.dispose)
  // Enables: using client = createRpcClient(...);
  async [Symbol.asyncDispose](): Promise<void> {
    await this.disconnect();
  }

  // Synchronous dispose (calls async version)
  // For environments that only support Symbol.dispose
  [Symbol.dispose](): void {
    // Schedule async disconnect but don't wait
    // Note: This is not ideal but required for sync dispose
    void this.disconnect();
  }

  // Internal method to execute operations (called by ProxyHandler)
  async execute(operations: OperationChain, skipProcessing = false): Promise<any> {
    // Lazy initialization: create transport on first use if not already created
    if (!this.#transport) {
      // Create transport synchronously to avoid race conditions
      this.#transport = this.createTransport();
    }
    
    // Ensure connection is established (for stateful transports like WebSocket)
    if (!this.#transport.isConnected?.()) {
      await this.connect();
    }

    // Execute the operation chain via transport
    const result = await this.#transport.execute(operations);
    
    // Optionally skip processing (for __asObject which handles conversion itself)
    if (skipProcessing) {
      return result;
    }
    
    // Process the result to convert remote function markers to proxies
    return this.processRemoteFunctions(result, []);
  }

  processRemoteFunctions(obj: any, baseOperations: any[]): any {
    // Base case: if it's a remote function marker, create a proxy for it
    if (obj && typeof obj === 'object' && isRemoteFunctionMarker(obj)) {
      const remoteFn = obj as RemoteFunctionMarker;
      return new Proxy(() => {}, {
        apply: (target, thisArg, args) => {
          const operations: OperationChain = [...baseOperations, ...remoteFn.__operationChain, { type: 'apply', args }];
          return this.execute(operations);
        }
      });
    }

    if (obj === null || typeof obj !== 'object') {
      return obj; // Primitive values pass through unchanged
    }

    // Arrays need recursive processing to check for remote function markers
    if (Array.isArray(obj)) {
      return obj.map(item => this.processRemoteFunctions(item, baseOperations));
    }

    // Check if this is a plain object (not a built-in type like Date, Map, etc.)
    // Built-in types that structured-clone preserves (Date, Map, Set, RegExp, ArrayBuffer, 
    // TypedArrays, Error) should pass through unchanged - they're already properly deserialized.
    // Note: Custom class instances are NOT preserved by structured-clone - they become plain 
    // objects during serialization, so they'll be processed recursively below.
    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype) {
      // Not a plain object - it's a built-in type that was preserved by structured-clone
      return obj;
    }

    // Process plain object properties recursively
    const processed: any = {};
    for (const [key, value] of Object.entries(obj)) {
      processed[key] = this.processRemoteFunctions(value, baseOperations);
    }
    return processed;
  }
}

class ProxyHandler {
  #operationChain: OperationChain = [];
  #rpcClient: RpcClient<any>;

  constructor(rpcClient: RpcClient<any>) {
    this.#rpcClient = rpcClient;
  }

  get(target: any, key: string | symbol): any {
    // Symbols can't be serialized for RPC, so return undefined for any symbol access
    // (lifecycle symbols like Symbol.asyncDispose are handled by the outer proxy)
    if (typeof key === 'symbol') {
      return undefined;
    }

    // Special method for debugging/testing: __asObject() returns the object structure
    // with functions as readable strings like "functionName [Function]"
    if (key === '__asObject') {
      return async () => {
        // Execute the current operation chain to get the object
        const operations = [...this.#operationChain];
        this.#operationChain = [];
        // Skip normal processing to avoid circular reference issues
        const result = await this.#rpcClient.execute(operations, true);
        // Convert remote function markers to readable strings
        return convertRemoteFunctionsToStrings(result);
      };
    }

    // Special case: 'then' property access should execute the operation chain
    // but not add 'then' to the chain. This makes proxies thenable (for await)
    // without contaminating the operation chain with 'then' operations.
    if (key === 'then') {
      // Return a .then method that executes the current operation chain
      const operations = [...this.#operationChain];
      this.#operationChain = [];
      const promise = this.#rpcClient.execute(operations);
      return promise.then.bind(promise);
    }

    // Add 'get' operation to chain
    this.#operationChain.push({ type: 'get', key });

    // Return a new proxy that will handle the next operation
    const proxy = this.createProxyWithCurrentChain();
    
    // Reset the operation chain after creating the proxy with the current chain
    this.#operationChain = [];
    
    return proxy;
  }

  apply(target: any, thisArg: any, args: any[]): any {
    // NOTE: This trap is not called in normal operation. The proxy returned by createProxyWithCurrentChain
    // handles the apply operation. This trap would only be called if the initial proxy (before any property
    // access) were called directly as a function, which is not a supported use case.
    // Coverage tools may not properly instrument this defensive code path.
    // Add 'apply' operation to chain and execute
    this.#operationChain.push({ type: 'apply', args });

    // Execute the operation chain and wrap result in thenable proxy
    const resultPromise = this.executeOperations([...this.#operationChain]);
    return this.createThenableProxy(resultPromise);
  }

  // Helper to execute operations
  private executeOperations(operations: OperationChain): Promise<any> {
    return this.#rpcClient.execute(operations);
  }

  // Helper to process remote functions
  private processRemoteFunctions(obj: any, baseOperations: any[]): any {
    return this.#rpcClient.processRemoteFunctions(obj, baseOperations);
  }

  private createThenableProxy(promise: Promise<any>): any {
    const self = this;
    
    // Use a function as the proxy target so it can be called
    const callableTarget = function() {};
    
    // NOTE: Coverage tools may not properly instrument Proxy trap handlers
    return new Proxy(callableTarget, {
      get(target: any, key: string | symbol, receiver: any) {
        // Allow standard Promise methods by delegating to the promise
        if (key === 'then' || key === 'catch' || key === 'finally') {
          const method = (promise as any)[key];
          return typeof method === 'function' ? method.bind(promise) : method;
        }
        
        // For other properties, create a new thenable proxy that accesses the property after resolution
        // AND processes it through processRemoteFunctions
        const nestedPromise = promise.then((resolved: any) => {
          const propertyValue = resolved?.[key];
          // Process the property value to convert any remote function markers
          return self.processRemoteFunctions(propertyValue, []);
        });
        
        // Important: Don't wrap the result in a thenable proxy if it's already a proxy (from processRemoteFunctions)
        // Instead, return a proxy that will behave correctly whether the result is a function/proxy or a value
        const nestedCallableTarget = function() {};
        return new Proxy(nestedCallableTarget, {
          get(t: any, k: string | symbol) {
            if (k === 'then' || k === 'catch' || k === 'finally') {
              const method = (nestedPromise as any)[k];
              return typeof method === 'function' ? method.bind(nestedPromise) : method;
            }
            // Further property access - chain another thenable proxy
            const furtherPromise = nestedPromise.then((r: any) => {
              const furtherValue = r?.[k];
              return self.processRemoteFunctions(furtherValue, []);
            });
            return self.createThenableProxy(furtherPromise);
          },
          apply(t: any, thisArg: any, args: any[]) {
            // Call as function - the promise resolves to a callable (proxy or function)
            return nestedPromise.then((fnOrProxy: any) => {
              // Try to call it - if it's a proxy with apply trap or a function, this will work
              try {
                return fnOrProxy.apply(thisArg, args);
              } catch (e) {
                throw new Error(`Attempted to call a non-function value: ${e}`);
              }
            });
          }
        });
      },
      apply(target: any, thisArg: any, args: any[]) {
        // The promise itself is being called as a function
        // This means the previous property access resolved to a function
        return promise.then((fn: any) => {
          // Try to call it - if it's a proxy with apply trap or a function, this will work
          try {
            return fn.apply(thisArg, args);
          } catch (e) {
            throw new Error(`Attempted to call a non-function value: ${e}`);
          }
        });
      }
    });
  }

  private createProxyWithCurrentChain(): any {
    // This is the main entry point for handling property access and method calls.
    // The returned proxy handles both further property access (via get trap) and method calls (via apply trap).
    // NOTE: Coverage tools may not properly instrument Proxy trap handlers
    const currentChain = [...this.#operationChain];

    return new Proxy(() => {}, {
      get: (target: any, key: string | symbol) => {
        // Special case: 'then' should execute the chain but not add 'then' to it
        if (key === 'then') {
          const promise = this.executeOperations(currentChain);
          return promise.then.bind(promise);
        }
        // Create NEW chain to avoid mutation of shared closure variable
        const newChain: OperationChain = [...currentChain, { type: 'get', key }];
        return this.createProxyWithCurrentChainForChain(newChain);
      },
      apply: (target: any, thisArg: any, args: any[]) => {
        // Create NEW chain to avoid mutation of shared closure variable
        const finalChain: OperationChain = [...currentChain, { type: 'apply', args }];
        const resultPromise = this.executeOperations(finalChain);
        return this.createThenableProxy(resultPromise);
      }
    });
  }

  private createProxyWithCurrentChainForChain(chain: import('./types').OperationChain): any {
    // NOTE: Coverage tools may not properly instrument Proxy trap handlers
    return new Proxy(() => {}, {
      get: (target: any, key: string | symbol) => {
        // Special case: 'then' should execute the chain but not add 'then' to it
        if (key === 'then') {
          const promise = this.executeOperations(chain);
          return promise.then.bind(promise);
        }
        const newChain: import('./types').OperationChain = [...chain, { type: 'get', key }];
        return this.createProxyWithCurrentChainForChain(newChain);
      },
      apply: (target: any, thisArg: any, args: any[]) => {
        const finalChain: import('./types').OperationChain = [...chain, { type: 'apply', args }];
        const resultPromise = this.executeOperations(finalChain);
        return this.createThenableProxy(resultPromise);
      }
    });
  }
}