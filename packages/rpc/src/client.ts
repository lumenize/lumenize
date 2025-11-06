import type {
  OperationChain, 
  RemoteFunctionMarker, 
  RpcAccessible,
  RpcBatchRequest,
  RpcClientConfig, 
  RpcClientInternalConfig, 
  RpcClientProxy, 
  RpcTransport,
  NestedOperationMarker
} from './types';
import { isRemoteFunctionMarker, isNestedOperationMarker } from './types';
import { HttpPostRpcTransport } from './http-post-transport';
import { WebSocketRpcTransport } from './websocket-rpc-transport';
import { convertRemoteFunctionsToStrings } from './object-inspection';
import { walkObject } from './walk-object';
import { isStructuredCloneNativeType } from './structured-clone-utils';
import { debug } from '@lumenize/debug';

/**
 * WeakMap to track proxy objects and their operation chains.
 * Used for object chaining and nesting (OCAN) - allows detecting when 
 * a proxy is used as an argument.
 */
const proxyToOperationChain = new WeakMap<object, OperationChain>();

/**
 * WeakMap to track proxy parent-child relationships for prefix detection.
 * When a proxy is extended (e.g., client.setValue('x').uppercaseValue()),
 * the child proxy (uppercaseValue result) is registered with its parent
 * (setValue result) so we can identify true prefix relationships.
 * This prevents false positives where two independent calls happen to have
 * identical operations.
 */
const proxyToParent = new WeakMap<object, object>();

/**
 * Map to track operation chain object references to their proxy objects.
 * This allows us to look up which proxy owns a specific operation chain
 * instance during batching, so we can build the lineage graph.
 */
const operationChainToProxy = new WeakMap<OperationChain, object>();

/**
 * WeakMap to track unique IDs for proxy objects (for alias detection).
 * When the same proxy appears multiple times in a batch, we use this ID
 * to create alias markers instead of duplicating the full operation chain.
 */
const proxyToId = new WeakMap<object, string>();

/**
 * Counter for generating unique proxy IDs.
 */
let nextProxyId = 0;

/**
 * Module-scoped variable to capture the last batch request for inspection.
 * When inspect mode is enabled, the preprocessed batch request is stored here
 * while still executing normally over the wire.
 * 
 * @example
 * ```typescript
 * import { setInspectMode, getLastBatchRequest } from '@lumenize/rpc';
 * 
 * setInspectMode(true);
 * await client.setValue('key', 'value').processValue();
 * const batchRequest = getLastBatchRequest();
 * console.log(batchRequest); // Shows the batch request structure
 * setInspectMode(false);
 * ```
 */
let _inspectMode = false;
let _lastBatch: RpcBatchRequest | null = null;

/**
 * Set inspect mode for RPC operations. When enabled, the preprocessed batch
 * request is captured in a global variable while still executing normally.
 * 
 * @example
 * ```typescript
 * import { setInspectMode, getLastBatchRequest } from '@lumenize/rpc';
 * 
 * setInspectMode(true);
 * await client.someMethod();
 * const batchRequest = getLastBatchRequest();
 * setInspectMode(false);
 * console.log(batchRequest?.batch[0].operations);
 * ```
 * 
 * @param enabled - Whether to enable inspect mode
 */
export function setInspectMode(enabled: boolean): void {
  _inspectMode = enabled;
  if (!enabled) {
    _lastBatch = null; // Clear on disable
  }
}

/**
 * Get the last captured batch request from inspect mode.
 * Returns the batch request with all preprocessed operations.
 * 
 * @returns The last batch request, or null if inspect mode is not enabled
 */
export function getLastBatchRequest(): RpcBatchRequest | null {
  return _lastBatch;
}

/**
 * Creates an RPC client that proxies method calls to a remote Durable Object.
 * For the WebSocket transport, connection is established automatically on first 
 * method call (lazy connection) and auto-reconnected on first call after disconnect.
 * 
 * Use 'using' for automatic cleanup:
 * ```typescript
 * import { createRpcClient, createWebSocketTransport } from '@lumenize/rpc';
 * 
 * using client = createRpcClient<typeof MyDO>({
 *   transport: createWebSocketTransport('MY_DO', 'instance-name')
 * });
 * await client.someMethod();
 * // disconnect() called automatically at end of scope
 * ```
 * 
 * Or manually manage lifecycle:
 * ```typescript
 * const client = createRpcClient<typeof MyDO>({
 *   transport: createWebSocketTransport('MY_DO', 'instance-name')
 * });
 * try {
 *   await client.someMethod();
 * } finally {
 *   client[Symbol.dispose]();
 * }
 * ```
 * 
 * @remarks
 * This is a factory function that returns an instance of the internal {@link RpcClient} class.
 * The factory pattern provides a cleaner API (no `new` keyword) and allows for easier
 * API evolution without breaking changes. For testing, use {@link createTestingClient}
 * which provides sensible defaults for the Cloudflare Workers test environment.
 * 
 * @see [Usage Examples](https://lumenize.com/docs/rpc/quick-start#creating-an-rpc-client)
 * 
 * @typeParam T - Either a DO instance type (e.g., `RpcAccessible<InstanceType<typeof MyDO>>`) or the DO class constructor (e.g., `typeof MyDO`). When passing a class constructor, instance type with RpcAccessible is inferred automatically.
 * @param config - Configuration with required transport
 * @returns A proxy object with both lifecycle methods and DO method calls
 */
export function createRpcClient<T>(
  config: RpcClientConfig
): (T extends abstract new (...args: any[]) => infer I ? RpcAccessible<I> : T) & RpcClientProxy {
  const client = new RpcClient<T>(config);
  return client as any; // Constructor returns Proxy, so type is correct
}

/**
 * Recursively process an operation chain to convert any nested proxy objects to pipelined operation markers.
 * This is needed because operation chains may contain proxies in their args, and those need to be
 * converted to markers before the chain can be serialized.
 * Uses walkObject() to handle the recursion consistently with other processing.
 */
async function processOperationChainForMarker(chain: OperationChain): Promise<OperationChain> {
  // Transformer to convert Proxy objects to markers
  const transformer = async (value: any) => {
    // Check if this is a proxy that needs to be converted to a marker
    if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
      const nestedChain = proxyToOperationChain.get(value);
      if (nestedChain) {
        // Recursively process the nested chain and create a marker
        const nestedProcessedChain = await processOperationChainForMarker(nestedChain);
        return {
          __isNestedOperation: true,
          __operationChain: nestedProcessedChain
        } as NestedOperationMarker;
      }
    }
    // Not a proxy, return unchanged
    return value;
  };

  // Walk the entire operation chain to find and convert nested proxies
  // Skip recursion into markers that are already fully formed
  return await walkObject(chain, transformer, {
    shouldSkipRecursion: (value) => isNestedOperationMarker(value)
  }) as OperationChain;
}

/**
 * Process outgoing operations before sending to server.
 * Walks the operation chain, finds 'apply' operations, and detects proxy arguments
 * (for OCAN), converting them to markers. Structured-clone handles all other serialization.
 * Returns both processed operations and a set of operation chains that were pipelined.
 */
async function processOutgoingOperations(
  operations: OperationChain,
  serializedProxies?: Set<string>  // Optional: shared across batch for alias detection
): Promise<{ 
  operations: OperationChain;
  pipelinedChains: Set<OperationChain>;
}> {
  const processedOperations: OperationChain = [];
  const pipelinedChains = new Set<OperationChain>();
  // Use provided Set if available (shared across batch), otherwise create new one
  const proxiesSet = serializedProxies || new Set<string>();
  
  for (const operation of operations) {
    if (operation.type === 'apply' && operation.args.length > 0) {
      // Use walkObject to convert proxies to markers in the args
      const transformer = async (value: any) => {
        // Check if this is a proxy that needs to be converted to a pipelined operation marker
        // Proxies can appear as either objects or functions depending on their target
        if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
          const operationChain = proxyToOperationChain.get(value);
          if (operationChain) {
            // Track that this operation chain was pipelined
            pipelinedChains.add(operationChain);
            
            // Get or assign unique ID for this proxy (for alias detection)
            let proxyId = proxyToId.get(value);
            if (!proxyId) {
              proxyId = `proxy-${nextProxyId++}`;
              proxyToId.set(value, proxyId);
            }
            
            // Check if this is the first occurrence of this proxy in this batch
            if (!proxiesSet.has(proxyId)) {
              // First occurrence: create full marker with both __refId and __operationChain
              proxiesSet.add(proxyId);
              
              // The operation chain may contain nested proxies in its args, so we need to
              // recursively process it to convert those proxies to markers as well
              const processedChain = await processOperationChainForMarker(operationChain);
              
              const marker: NestedOperationMarker = {
                __isNestedOperation: true,
                __refId: proxyId,
                __operationChain: processedChain
              };
              return marker;
            } else {
              // Subsequent occurrence: create alias marker with only __refId
              const aliasMarker: NestedOperationMarker = {
                __isNestedOperation: true,
                __refId: proxyId
                // No __operationChain - this is an alias!
              };
              return aliasMarker;
            }
          }
        }
        
        // Everything else passes through unchanged
        // structured-clone handles Web API objects, Errors, and special numbers natively
        return value;
      };
      
      // Walk the args array to find and convert proxies to markers
      // Skip recursing into built-in types that structured-clone handles natively
      const processedArgs = await walkObject(operation.args, transformer, {
        shouldSkipRecursion: (value) => {
          // Skip recursion for nested operation markers - they're already fully formed
          if (isNestedOperationMarker(value)) {
            return true;
          }
          // Skip recursion for structured-clone native types
          return isStructuredCloneNativeType(value);
        }
      });
      
      processedOperations.push({
        type: 'apply',
        args: processedArgs
      });
    } else {
      // 'get' operations pass through unchanged
      processedOperations.push(operation);
    }
  }
  
  return { operations: processedOperations, pipelinedChains };
}

/**
 * Queued execution waiting to be batched
 */
interface QueuedExecution {
  id: string;
  operations: OperationChain;
  proxy?: object; // The proxy object that triggered this execution (for lineage tracking)
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

/**
 * RPC Client that maintains a persistent connection to a Durable Object.
 * The constructor returns a Proxy that forwards unknown methods to the DO.
 * 
 * @internal
 * 
 * DESIGN NOTE: Why is this a class if createRpcClient() is the public API?
 * 
 * 1. Factory Pattern (createRpcClient): PUBLIC API
 *    - Cleaner syntax (no 'new' keyword required)
 *    - Easier API evolution (can change internals without breaking users)
 *    - Makes testing wrapper (createTestingClient) more natural
 * 
 * 2. Class Implementation (RpcClient): INTERNAL
 *    - Manages stateful connection lifecycle (transport, reconnection)
 *    - Implements Symbol.dispose for 'using' support (synchronous cleanup)
 *      Note: WebSocket.close() is synchronous, so async disposal is unnecessary
 *    - Uses Proxy pattern which works naturally with class instances
 *    - Provides named type (RpcClient<T>) for advanced users who need type references
 * 
 * 3. Why Both Work Together:
 *    - Factory = stable public API (simple, clean)
 *    - Class = flexible internal implementation (powerful, maintainable)
 *    - Users call createRpcClient(), get RpcClient instance
 *    - Advanced users can reference RpcClient<T> type if needed
 * 
 * This pattern provides both simplicity for common use cases and power for advanced
 * scenarios, without compromise.
 */
export class RpcClient<T> {
  #config: RpcClientConfig;
  #transport: RpcTransport;
  #connectionPromise: Promise<void> | null = null;
  #doProxy: T | null = null;
  #log = debug({})('rpc.client');
  
  // Operations in the same tick are batched
  #executionQueue: QueuedExecution[] = [];
  #batchScheduled = false;
  #nextId = 0;

  constructor(config: RpcClientConfig) {
    this.#config = config;
    this.#transport = config.transport;

    // Validate downstream messaging configuration
    if (config.onDownstream && !config.clientId) {
      throw new Error('clientId is required when using onDownstream handler');
    }

    // Set up downstream messaging if handler is provided
    if (config.onDownstream && this.#transport.setDownstreamHandler) {
      this.#setupDownstreamMessaging(config.onDownstream);
    }

    // Enable keep-alive if downstream messaging is configured
    if (config.onDownstream || config.onClose) {
      this.#transport.setKeepAlive(true);
    }

    // Create the DO proxy handler
    const proxyHandler = new ProxyHandler(this);
    this.#doProxy = new Proxy(() => {}, proxyHandler) as T;

    // Return a Proxy that merges lifecycle methods with DO methods
    // NOTE: Coverage tools may not properly instrument Proxy trap handlers
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        // Handle disposal symbols for explicit resource management
        // Note: We only implement Symbol.dispose (sync), but check for asyncDispose
        // for forward compatibility if we ever need async cleanup in the future
        // Bind to the target (RpcClient instance) not the receiver (proxy)
        if (prop === Symbol.asyncDispose || prop === Symbol.dispose) {
          const method = Reflect.get(target, prop, target); // Use target as receiver
          return typeof method === 'function' ? method.bind(target) : method;
        }

        // Handle transportInstance getter
        if (prop === 'transportInstance') {
          return target.#transport;
        }

        // Delegate all other property access to the DO proxy
        return Reflect.get(this.#doProxy as any, prop, receiver);
      }
    }) as any;
  }

  /**
   * Set up downstream messaging handler to process server-sent messages
   * @internal
   */
  #setupDownstreamMessaging(onDownstream: (payload: any) => void | Promise<void>): void {
    // Simply pass the user's handler to the transport
    // The transport will route messages with type '__downstream' to this handler
    this.#transport.setDownstreamHandler!(onDownstream);
  }

  // Internal method to establish connection (called lazily on first execute)
  async #connect(): Promise<void> {
    // For stateful transports (WebSocket), ensure connection is established
    if (this.#transport.isConnected?.()) {
      return; // Already connected
    }

    // If connection in progress, wait for it
    if (this.#connectionPromise) {
      return this.#connectionPromise;
    }

    // Only stateful transports have a connect() method
    if (!this.#transport.connect) {
      return; // HTTP transport is ready to use immediately
    }

    // Start new connection
    this.#connectionPromise = this.#connectInternal();
    
    try {
      await this.#connectionPromise;
    } finally {
      this.#connectionPromise = null;
    }
  }

  async #connectInternal(): Promise<void> {
    // Call transport's connect() (for stateful transports like WebSocket)
    if (this.#transport.connect) {
      await this.#transport.connect();
    }
  }

  // Internal method to disconnect (synchronous - ws.close() is sync)
  #disconnect(): void {
    // Call transport's disconnect() if it exists (for stateful transports like WebSocket)
    if (this.#transport.disconnect) {
      this.#transport.disconnect();
    }
  }

  // Explicit resource management (Symbol.dispose)
  // Enables: using client = createRpcClient(...);
  [Symbol.dispose](): void {
    this.#disconnect();
  }

  // Internal method to execute operations (called by ProxyHandler)
  // Queues the operation and schedules a batch send in the next microtask
  async execute(operations: OperationChain, skipProcessing = false): Promise<any> {
    // Ensure connection is established (creates transport and connects if needed)
    await this.#connect();

    // Generate unique ID for this operation
    const id = `${Date.now()}-${this.#nextId++}`;

    // Create promise for response
    const resultPromise = new Promise<any>((resolve, reject) => {
      // Queue this execution for batching WITH RAW OPERATIONS
      // Processing happens in #sendBatch() to avoid microtask boundaries breaking batching
      this.#executionQueue.push({
        id,
        operations, // Store raw operations - will be processed in batch
        resolve,
        reject
      });

      // Schedule batch send if not already scheduled
      if (!this.#batchScheduled) {
        this.#batchScheduled = true;
        queueMicrotask(() => {
          this.#sendBatch();
        });
      }
    });

    const result = await resultPromise;
    
    // Optionally skip processing (for __asObject which handles conversion itself)
    if (skipProcessing) {
      return result;
    }
    
    // Process the result to convert markers to live objects (remote function markers to proxies, etc.)
    return this.postprocessResult(result, []);
  }

  // Send all queued executions as a batch
  async #sendBatch(): Promise<void> {
    // Reset batch flag
    this.#batchScheduled = false;

    // Get all queued executions
    const queue = this.#executionQueue;
    this.#executionQueue = [];

    if (queue.length === 0) {
      return; // Nothing to send
    }

    try {
      // Process all operations in the batch (serialize Web API objects, etc.)
      // This is done here (not in execute()) to avoid microtask boundaries breaking batching
      // IMPORTANT: Process sequentially (not Promise.all) so alias detection works correctly
      const serializedProxies = new Set<string>();  // Shared across batch for alias detection
      const processedQueue: Array<{
        id: string;
        operations: OperationChain;
        resolve: (value: any) => void;
        reject: (error: any) => void;
        pipelinedChains: Set<OperationChain>;
      }> = [];
      
      for (const item of queue) {
        const processed = await processOutgoingOperations(item.operations, serializedProxies);
        processedQueue.push({
          ...item,
          operations: processed.operations,
          pipelinedChains: processed.pipelinedChains
        });
      }

      // Collect all pipelined chains across all operations in the batch
      const allPipelinedChains = new Set<OperationChain>();
      for (const item of processedQueue) {
        for (const chain of item.pipelinedChains) {
          allPipelinedChains.add(chain);
        }
      }

      // Filter out operations whose operation chains were used as pipelined arguments
      // Only send operations that are actually being awaited
      let filteredQueue = processedQueue.filter((item) => {
        // Check if this item's ORIGINAL operations (before processing) match any pipelined chain
        const originalItem = queue.find(q => q.id === item.id);
        return !allPipelinedChains.has(originalItem!.operations);
      });

      // CRITICAL: Also filter out operations that are PREFIXES of longer chains in the batch.
      // This happens when we chain operations without awaiting intermediate results:
      // e.g., const p = client.setValue('x', 'y'); await p.uppercaseValue()
      // This queues TWO operations:
      //   1. [get setValue, apply ['x', 'y']]
      //   2. [get setValue, apply ['x', 'y'], get uppercaseValue, apply []]
      // We only want to send #2 since it includes #1.
      // But we need to resolve promise #1 with the intermediate result from chain #2.
      //
      // IMPORTANT: We use proxy lineage tracking (not operation content comparison) to detect
      // true prefix relationships. This prevents false positives where two independent calls
      // happen to have identical operations (e.g., two separate client.setValue('x', 'y') calls).
      const prefixToLongerChain = new Map<string, string>(); // prefix ID -> longer chain ID
      filteredQueue = filteredQueue.filter((item) => {
        // Get the proxy object for this operation chain (if it exists)
        const originalItem = queue.find(q => q.id === item.id);
        const itemProxy = originalItem ? operationChainToProxy.get(originalItem.operations) : null;
        
        if (!itemProxy) {
          return true; // No proxy tracking, keep it
        }
        
        // Walk up the proxy lineage chain to find all ancestors
        const ancestors = new Set<object>();
        let current: object | undefined = itemProxy;
        while (current) {
          ancestors.add(current);
          current = proxyToParent.get(current);
        }
        
        // Check if any other item in the batch is a descendant of this item
        // If so, this item is a prefix and should be filtered out
        for (const other of filteredQueue) {
          if (item.id === other.id) continue; // Don't compare with self
          
          const originalOther = queue.find(q => q.id === other.id);
          const otherProxy = originalOther ? operationChainToProxy.get(originalOther.operations) : null;
          
          if (!otherProxy) continue;
          
          // Check if otherProxy is a descendant of itemProxy by walking its ancestry
          let otherCurrent: object | undefined = otherProxy;
          while (otherCurrent) {
            if (otherCurrent === itemProxy) {
              // Found it! otherProxy descends from itemProxy, so itemProxy is a prefix
              prefixToLongerChain.set(item.id, other.id);
              return false; // Filter out this prefix
            }
            otherCurrent = proxyToParent.get(otherCurrent);
          }
        }
        
        return true; // Not a prefix of any other operation
      });

      // Note: Pipelined operations (those filtered out) have their promises left pending.
      // This is correct - they should never be awaited since they're only used as arguments.
      // Their results are computed on the server as part of the operation that used them.

      // Build batch request with only non-pipelined operations
      const batchRequest: RpcBatchRequest = {
        batch: filteredQueue.map(({ id, operations }) => ({ id, operations }))
      };

      // If in inspect mode, capture the batch request for inspection
      if (_inspectMode) {
        _lastBatch = batchRequest;
      }

      // Execute the batch via transport
      const batchResponse = await this.#transport!.execute(batchRequest);

      // Route responses to the correct promises by matching IDs
      for (const response of batchResponse.batch) {
        const queued = queue.find(q => q.id === response.id);
        if (!queued) {
          this.#log.warn('Received response for unknown operation ID', { id: response.id });
          continue;
        }

        if (response.success) {
          queued.resolve(response.result);
        } else {
          // parse() already reconstructed the Error instance
          queued.reject(response.error);
        }
      }

    } catch (error) {
      // On error, reject all queued operations
      for (const { reject } of queue) {
        reject(error);
      }
    }
  }

  postprocessResult(obj: any, baseOperations: any[], seen = new WeakMap()): any {
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
      return obj; // Primitive values pass through unchanged (structured-clone handles special numbers)
    }

    // Handle circular references - return the already-processed object
    if (seen.has(obj)) {
      return seen.get(obj);
    }

    // Arrays need recursive processing to check for remote function markers
    if (Array.isArray(obj)) {
      // Create the processed array FIRST and add to seen map BEFORE processing children
      // This is crucial for handling circular references correctly
      const processedArray: any[] = [];
      seen.set(obj, processedArray);
      
      for (let i = 0; i < obj.length; i++) {
        processedArray[i] = this.postprocessResult(obj[i], baseOperations, seen);
      }
      
      return processedArray;
    }

    // Check if this is a plain object (not a built-in type like Date, Map, Error, etc.)
    // Built-in types that structured-clone preserves (Date, Map, Set, RegExp, ArrayBuffer, 
    // TypedArrays, Error, Web API objects) should pass through unchanged - they're already properly deserialized.
    // Note: Custom Error subclasses (CustomError) become base Error instances with name='CustomError'.
    // The prototype chain cannot be preserved because the class definition isn't available across boundaries.
    // Custom class instances are NOT preserved by structured-clone - they become plain 
    // objects during serialization, so they'll be processed recursively below.
    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype) {
      // Not a plain object - it's a built-in type that was preserved by structured-clone
      return obj;
    }

    // Process plain object properties recursively
    // Create the processed object FIRST and add to seen map BEFORE processing children
    const processed: any = {};
    seen.set(obj, processed);
    
    for (const [key, value] of Object.entries(obj)) {
      processed[key] = this.postprocessResult(value, baseOperations, seen);
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
    const proxy = this.#createProxyWithCurrentChain();
    
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
    const operationChain = [...this.#operationChain];
    const resultPromise = this.#executeOperations(operationChain);
    return this.#createThenableProxy(resultPromise, operationChain);
  }

  // Helper to execute operations
  #executeOperations(operations: OperationChain): Promise<any> {
    return this.#rpcClient.execute(operations);
  }

  // Helper to postprocess results by converting markers to live objects
  #postprocessResult(obj: any, baseOperations: any[]): any {
    return this.#rpcClient.postprocessResult(obj, baseOperations);
  }

  #createThenableProxy(promise: Promise<any>, operationChain?: OperationChain, parentProxy?: object): any {
    const self = this;
    
    // Use a function as the proxy target so it can be called
    const callableTarget = function() {};
    
    // NOTE: Coverage tools may not properly instrument Proxy trap handlers
    const proxy = new Proxy(callableTarget, {
      get(target: any, key: string | symbol, receiver: any) {
        // Allow standard Promise methods by delegating to the promise
        if (key === 'then' || key === 'catch' || key === 'finally') {
          const method = (promise as any)[key];
          return typeof method === 'function' ? method.bind(promise) : method;
        }
        
        // CRITICAL: If we have an operation chain, CONTINUE BUILDING THE CHAIN
        // instead of resolving the promise. This allows chaining like:
        // client.env.ROOM.getByName('x').addMessage('y')
        if (operationChain) {
          // Build a new chain by adding this property access
          const newChain: OperationChain = [...operationChain, { type: 'get', key }];
          // Pass current proxy as parent so child knows it extends this chain
          return self.#createProxyWithCurrentChainForChain(newChain, proxy);
        }
        
        // For other properties, create a new thenable proxy that accesses the property after resolution
        // AND postprocesses it to convert markers to live objects
        const nestedPromise = promise.then((resolved: any) => {
          const propertyValue = resolved?.[key];
          // Postprocess the property value to convert any markers (remote function markers, etc.)
          return self.#postprocessResult(propertyValue, []);
        });
        
        // Important: Don't wrap the result in a thenable proxy if it's already a proxy (from postprocessResult)
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
              return self.#postprocessResult(furtherValue, []);
            });
            return self.#createThenableProxy(furtherPromise);
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
    
    // Register this thenable proxy in the WeakMap if we have an operation chain
    if (operationChain) {
      proxyToOperationChain.set(proxy, operationChain);
      operationChainToProxy.set(operationChain, proxy);
      
      // Track parent-child relationship for prefix detection
      if (parentProxy) {
        proxyToParent.set(proxy, parentProxy);
      }
    }
    
    return proxy;
  }

  #createProxyWithCurrentChain(): any {
    // This is the main entry point for handling property access and method calls.
    // The returned proxy handles both further property access (via get trap) and method calls (via apply trap).
    const currentChain = [...this.#operationChain];
    return this.#createProxyWithCurrentChainForChain(currentChain);
  }

  #createProxyWithCurrentChainForChain(chain: import('./types').OperationChain, parentProxy?: object): any {
    // NOTE: Coverage tools may not properly instrument Proxy trap handlers
    const proxy = new Proxy(() => {}, {
      get: (target: any, key: string | symbol) => {
        // Special case: 'then' should execute the chain but not add 'then' to it
        if (key === 'then') {
          const promise = this.#executeOperations(chain);
          return promise.then.bind(promise);
        }
        const newChain: import('./types').OperationChain = [...chain, { type: 'get', key }];
        // Pass current proxy as parent for the new proxy
        return this.#createProxyWithCurrentChainForChain(newChain, proxy);
      },
      apply: (target: any, thisArg: any, args: any[]) => {
        // Clone the args array to prevent mutation issues
        const argsCopy = [...args];
        const finalChain: import('./types').OperationChain = [...chain, { type: 'apply', args: argsCopy }];
        const resultPromise = this.#executeOperations(finalChain);
        // Pass current proxy as parent for the thenable proxy
        return this.#createThenableProxy(resultPromise, finalChain, proxy);
      }
    });
    
    // Register this proxy in the WeakMap for OCAN detection
    proxyToOperationChain.set(proxy, chain);
    operationChainToProxy.set(chain, proxy);
    
    // Track parent-child relationship for prefix detection
    if (parentProxy) {
      proxyToParent.set(proxy, parentProxy);
    }
    
    return proxy;
  }
}