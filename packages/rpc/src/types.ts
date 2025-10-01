/**
 * Operation types that align with JavaScript Proxy traps
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
 */
export type OperationChain = Operation[];

/**
 * Request format sent to DO RPC endpoint (wire format)
 * 
 * wireOperations is the serialized OperationChain using @ungap/structured-clone.
 * It's typed as `any` because structured-clone creates an opaque serialized format
 * that we deserialize on the DO side.
 */
export interface RpcRequest {
  wireOperations: any;
}

/**
 * Response format from DO RPC endpoint
 * 
 * Serialization strategy:
 * - `result`: Uses @ungap/structured-clone for full Cloudflare-native type support
 * - `error`: Uses custom serialization to preserve all Error properties (code, statusCode, etc.)
 * - Overall response: Uses JSON.stringify (required anyway when sending HTTP responses)
 * - Client-side: Uses @ungap/structured-clone ONLY on `result` field after JSON.parse
 */
export interface RpcResponse {
  success: boolean;
  result?: any; // Serialized with structured-clone, preserves Cloudflare types
  error?: any;  // Custom-serialized Error object preserving all properties
}

/**
 * Configuration for RPC system on the Durable Object (server) side.
 * Used by both lumenizeRpcDo() factory and handleRPCRequest() for manual routing.
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
 */
export function isRemoteFunctionMarker(obj: any): obj is RemoteFunctionMarker {
  return obj && typeof obj === 'object' && obj.__isRemoteFunction === true;
}

// =====================================================================================
// CLIENT-SIDE TYPES
// =====================================================================================

/**
 * Configuration for creating an RPC client.
 * Used by createRpcClient() to establish connection to a Durable Object.
 */
export interface RpcClientConfig {
  /**
   * Name of the DO binding in your wrangler config
   */
  doBindingName: string;
  
  /**
   * Instance ID or name for the specific DO instance
   */
  doInstanceName: string;
  
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
   * Custom fetch function (for testing or alternative implementations)
   * @default globalThis.fetch
   */
  fetch?: typeof globalThis.fetch;
  
  /**
   * Request headers to include in all RPC requests
   * @default {}
   */
  headers?: Record<string, string>;
  
  /**
   * WebSocket class to use (for testing or alternative implementations)
   * @default globalThis.WebSocket
   */
  WebSocketClass?: typeof WebSocket;
}

/**
 * Type representing the proxy object returned by createRpcClient().
 * Merges the DO's methods (type T) with lifecycle methods in the $rpc namespace.
 * 
 * Implements Symbol.asyncDispose for automatic cleanup with 'using' keyword.
 * 
 * @example
 * ```typescript
 * // Manual lifecycle management:
 * const client: MyDO & RpcClientProxy = createRpcClient<MyDO>({ ... });
 * await client.$rpc.connect();
 * const result = await client.myMethod();
 * await client.$rpc.disconnect();
 * 
 * // Automatic cleanup with 'using' (recommended for UI frameworks):
 * {
 *   await using client = createRpcClient<MyDO>({ ... });
 *   await client.$rpc.connect();
 *   const result = await client.myMethod();
 * } // client.$rpc.disconnect() called automatically here
 * 
 * // React example with useEffect:
 * useEffect(() => {
 *   const client = createRpcClient<MyDO>({ ... });
 *   client.$rpc.connect();
 *   return () => client[Symbol.asyncDispose](); // or client.$rpc.disconnect()
 * }, []);
 * ```
 */
export interface RpcClientProxy {
  /**
   * Lifecycle methods for managing the RPC client connection.
   * Access these via client.$rpc.connect(), client.$rpc.disconnect(), etc.
   */
  $rpc: {
    /**
     * Establish connection to the Durable Object.
     * Must be called before making RPC calls.
     */
    connect(): Promise<void>;
    
    /**
     * Close the connection to the Durable Object.
     * Cleans up transport resources.
     * 
     * Note: This is called automatically when using 'await using' syntax.
     */
    disconnect(): Promise<void>;
    
    /**
     * Check if the client is currently connected.
     */
    isConnected(): boolean;
  };
  
  /**
   * Automatic cleanup when using 'await using' syntax.
   * Calls disconnect() automatically when the client goes out of scope.
   * 
   * @see https://github.com/tc39/proposal-explicit-resource-management
   */
  [Symbol.asyncDispose](): Promise<void>;
  
  /**
   * Synchronous cleanup when using 'using' syntax.
   * Note: Prefer Symbol.asyncDispose for proper async cleanup.
   */
  [Symbol.dispose](): void;
}

/**
 * Transport interface for executing RPC operations.
 * Different transports can be implemented (HTTP, WebSocket, etc.).
 */
export interface RpcTransport {
  execute(operations: OperationChain): Promise<any>;
  
  // Optional lifecycle methods for stateful transports (e.g., WebSocket)
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  isConnected?(): boolean;
}

