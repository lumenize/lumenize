/**
 * Operation types that align with JavaScript Proxy traps
 * @internal
 */
export type Operation = 
  | { type: 'get', key: string | number | symbol }     // Property/element access
  | { type: 'apply', args: any[] };                    // Function calls (deserialized, ready for execution)

/**
 * Chain of operations to execute on the DO instance
 * 
 * Note: The client-side proxy uses two OperationChain instances:
 * 1. A "prefix" chain stored in cached intermediate proxies (e.g., myDO.ctx.storage)
 * 2. An "extension" chain for the current operation (e.g., .get('key'))
 * These are concatenated before sending over the wire to form the complete operation sequence.
 * @internal
 */
export type OperationChain = Operation[];

/**
 * Core batched RPC request format used by all transports.
 * Multiple operation chains batched together
 * 
 * The entire request object will be encoded using @ungap/structured-clone/json
 * stringify() at the transport boundary.
 * @internal
 */
export interface RpcBatchRequest {
  batch: Array<{
    id: string;
    operations: OperationChain;
  }>;
}

/**
 * Core batched RPC response format used by all transports.
 * Multiple results batched together.
 * 
 * The entire response object will be encoded using @ungap/structured-clone/json
 * stringify() at the transport boundary.
 * @internal
 */
export interface RpcBatchResponse {
  batch: Array<{
    id: string;
    success: boolean;
    result?: any;
    error?: any;
  }>;
}

/**
 * WebSocket message envelope that wraps RpcBatchRequest with a type discriminator.
 * The type field allows multiple message types to coexist on the same WebSocket connection.
 * @internal
 */
export interface RpcWebSocketMessage extends RpcBatchRequest {
  type: string; // Derived from prefix, e.g., '__rpc'
}

/**
 * WebSocket message envelope that wraps RpcBatchResponse with a type discriminator.
 * @internal
 */
export interface RpcWebSocketMessageResponse extends RpcBatchResponse {
  type: string; // Derived from prefix, e.g., '__rpc'
}

/**
 * Configuration for RPC system on the Durable Object (server) side.
 * Used by both lumenizeRpcDO() factory and handleRpcRequest() for manual routing.
 */
export interface RpcConfig {
  /**
   * Base path for RPC endpoints
   * @default "/__rpc"
   */
  prefix?: string;
  
  /**
   * Maximum depth for operation chains (security)
   * @default 50
   */
  maxDepth?: number;
  
  /**
   * Maximum arguments per apply operation (security)
   * @default 100
   */
  maxArgs?: number;
}

/**
 * Internal marker for remote functions during serialization.
 * When the DO returns an object with functions, those functions are replaced
 * with these markers. The client converts them back to callable proxies.
 * @internal
 */
export interface RemoteFunctionMarker {
  __isRemoteFunction: true;
  __operationChain: OperationChain;
  __functionName: string;
}

/**
 * Type guard to check if an object is a remote function marker.
 * Used internally by the client to identify functions that should be
 * converted back to callable proxies.
 * @internal
 */
export function isRemoteFunctionMarker(obj: any): obj is RemoteFunctionMarker {
  return obj && typeof obj === 'object' && obj.__isRemoteFunction === true;
}

/**
 * Internal marker for nested operations during serialization.
 * When a client passes an unawaited RPC call result as an argument to another call,
 * this marker carries the operation chain that needs to be executed server-side first.
 * The server recursively executes the nested operation and substitutes the result.
 * @internal
 */
export interface NestedOperationMarker {
  __isNestedOperation: true;
  __operationChain: OperationChain;
}

/**
 * Type guard to check if an object is a nested operation marker.
 * Used internally by the server to identify arguments that need recursive execution.
 * @internal
 */
export function isNestedOperationMarker(obj: any): obj is NestedOperationMarker {
  return obj && typeof obj === 'object' && obj.__isNestedOperation === true;
}

// =====================================================================================
// CLIENT-SIDE TYPES
// =====================================================================================

/**
 * Exposes `ctx` and `env` as public properties for TypeScript.
 * 
 * These properties are `protected` in DurableObject but accessible at runtime through
 * the RPC proxy. This type makes TypeScript happy about that access.
 * 
 * @example
 * ```typescript
 * type MyDOType = RpcAccessible<InstanceType<typeof MyDO>>;
 * using client = createRpcClient<MyDOType>(...);
 * await client.ctx.storage.put('key', 'value'); // TypeScript allows this
 * ```
 */
export type RpcAccessible<T> = Omit<T, 'ctx' | 'env'> & {
  ctx: DurableObjectState;
  env: any;
};

/**
 * Configuration options for creating an RPC client.
 * These are the optional parameters passed to createRpcClient().
 * 
 * @example
 * ```typescript
 * const client = createRpcClient<MyDO>('MY_DO', 'instance-name', {
 *   transport: 'websocket',
 *   baseUrl: 'https://api.example.com',
 *   headers: { 'Authorization': 'Bearer token' }
 * });
 * ```
 */
export interface RpcClientConfig {
  /**
   * Transport type to use for RPC communication
   * @default 'websocket'
   */
  transport?: 'websocket' | 'http';
  
  /**
   * Base URL for the RPC endpoints
   * @default location.origin (browser) or 'http://localhost:8787' (Node)
   */
  baseUrl?: string;
  
  /**
   * RPC endpoint prefix (must match server-side RpcConfig.prefix)
   * @default '/__rpc'
   */
  prefix?: string;
  
  /**
   * Request timeout in milliseconds
   * @default 30000
   */
  timeout?: number;
  
  /**
   * Alternative fetch function (e.g. `SELF.fetch.bind(SELF)` for in vitest Workers pool env)
   * @default globalThis.fetch
   */
  fetch?: typeof globalThis.fetch;
  
  /**
   * Request headers to include in all HTTP RPC requests
   * @default {}
   */
  headers?: Record<string, string>;
  
  /**
   * WebSocket class. Use the WebSocket that's returned from `getWebSocketShim(...)` in vitest Workers pool env
   * @default globalThis.WebSocket
   */
  WebSocketClass?: new (url: string, protocols?: string | string[]) => WebSocket;
}

/**
 * Internal full configuration with required binding name and instance ID.
 * This is what's used internally by RpcClient after createRpcClient merges the parameters.
 * @internal
 */
export interface RpcClientInternalConfig extends RpcClientConfig {
  /**
   * Name of the DO binding in your wrangler config
   */
  doBindingName: string;
  
  /**
   * Instance ID or name for the specific DO instance.
   * Can be either:
   * - A named instance (any string)
   * - A unique ID (64-character hex string)
   */
  doInstanceNameOrId: string;
}

/**
 * Lifecycle methods added to the RPC client proxy by createRpcClient().
 * 
 * These methods are mixed into the returned proxy object alongside the
 * Durable Object's own methods to provide connection management and debugging.
 */
export interface RpcClientProxy {
  /**
   * Automatic cleanup when using 'using' syntax.
   * Disconnects WebSocket synchronously (ws.close() is synchronous).
   * 
   * @example
   * ```typescript
   * using client = createRpcClient<MyDO>('MY_DO', 'instance-name');
   * // Use client here - auto-connects on first method call
   * // disconnect() called automatically at end of scope
   * ```
   */
  [Symbol.dispose](): void;

  /**
   * Returns a plain object representation of the proxied object with functions
   * represented as readable strings like "functionName [Function]".
   * Useful for debugging and testing.
   * 
   * @example
   * ```typescript
   * const client = createRpcClient<MyDO>('MY_DO', 'instance-name');
   * const structure = await client.__asObject();
   * // {
   * //   increment: "increment [Function]",
   * //   ctx: {
   * //     storage: {
   * //       get: "get [Function]",
   * //       ...
   * //     }
   * //   }
   * // }
   * ```
   */
  __asObject?(): Promise<any>;
}

/**
 * Transport interface for executing batched RPC operations.
 * Different transports can be implemented (HTTP, WebSocket, MessagePort, etc.).
 * 
 * Transports are responsible for sending/receiving batch requests but NOT for
 * batching operations - that's handled by the RpcClient using microtask queuing.
 * @internal
 */
export interface RpcTransport {
  /**
   * Execute a batch of operation chains.
   * Returns responses in the same order as requests (matched by id).
   */
  execute(batch: RpcBatchRequest): Promise<RpcBatchResponse>;
  
  // Optional lifecycle methods for stateful transports (e.g., WebSocket)
  connect?(): Promise<void>;
  disconnect?(): void;
  isConnected?(): boolean;
}

