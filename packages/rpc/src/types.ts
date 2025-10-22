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
 * Request format sent to DO RPC endpoint.
 * 
 * The entire request object (including operations array) will be encoded using
 * @ungap/structured-clone/json stringify() at the transport boundary.
 * @internal
 */
export interface RpcRequest {
  operations: OperationChain;
}

/**
 * RPC response payload sent from server to client.
 * 
 * The entire response object (including result) will be encoded using
 * @ungap/structured-clone/json stringify() at the transport boundary.
 * @internal
 */
export interface RpcResponse {
  success: boolean;
  result?: any;
  error?: any;
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
 * await using client = createRpcClient<MyDOType>(...);
 * await client.ctx.storage.put('key', 'value'); // TypeScript allows this
 * ```
 */
export type RpcAccessible<T> = Omit<T, 'ctx' | 'env'> & {
  ctx: DurableObjectState;
  env: any;
};

/**
 * Helper type that converts a DO class constructor to its RPC-accessible instance type.
 * This eliminates boilerplate: instead of `RpcAccessible<InstanceType<typeof MyDO>>`,
 * just use `InferDOType<typeof MyDO>`.
 * 
 * @example
 * ```typescript
 * // Before (verbose)
 * type MyDOType = RpcAccessible<InstanceType<typeof MyDO>>;
 * await using client = createRpcClient<MyDOType>(...);
 * 
 * // After (simpler) - pass class directly
 * await using client = createRpcClient<typeof MyDO>(...);
 * // Type is automatically inferred as RpcAccessible<InstanceType<typeof MyDO>>
 * ```
 */
export type InferDOType<T> = T extends new (...args: any[]) => infer I 
  ? RpcAccessible<I>
  : never;

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
 * Transport interface for executing RPC operations.
 * Different transports can be implemented (HTTP, WebSocket, etc.).
 * @internal
 */
export interface RpcTransport {
  execute(operations: OperationChain): Promise<any>;
  
  // Optional lifecycle methods for stateful transports (e.g., WebSocket)
  connect?(): Promise<void>;
  disconnect?(): void;
  isConnected?(): boolean;
}

