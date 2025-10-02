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
 * Request format sent to DO RPC endpoint.
 * 
 * scEncodedOperations is the OperationChain encoded using @ungap/structured-clone.
 * It must be JSON.stringified before sending over the wire.
 * Typed as `any` because structured-clone creates an opaque encoded format.
 */
export interface RpcRequest {
  scEncodedOperations: any;
}

/**
 * RPC response payload sent from server to client.
 * 
 * scEncodedResult is the result encoded using @ungap/structured-clone.
 * The entire response object is JSON.stringified before sending.
 */
export interface RpcResponse {
  success: boolean;
  scEncodedResult?: any;
  error?: any;
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
 * Utility type that exposes Durable Object protected properties for RPC access.
 * 
 * When accessing Durable Object instances via RPC, TypeScript's protected modifier
 * is enforced at compile-time but does not restrict runtime access. This type utility
 * makes protected properties (like `ctx` and `env`) accessible in the type system
 * to match the runtime behavior.
 * 
 * This works by using Omit to remove the protected properties from the base type,
 * then intersecting with explicit public declarations that match the actual
 * Cloudflare Workers types.
 * 
 * @example
 * ```typescript
 * import type { RpcAccessible } from '@lumenize/rpc';
 * import { DurableObject } from 'cloudflare:workers';
 * 
 * class MyDO extends DurableObject {
 *   async myMethod() { ... }
 * }
 * 
 * const client = createRpcClient<RpcAccessible<MyDO>>({ ... });
 * const storage = await client.ctx.storage.get('key'); // No TypeScript error
 * await client.myMethod(); // Original methods still work
 * ```
 */
export type RpcAccessible<T> = Omit<T, 'ctx' | 'env'> & {
  ctx: DurableObjectState;
  env: any;
};

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
   * Instance ID or name for the specific DO instance.
   * Can be either:
   * - A named instance (any string)
   * - A unique ID (64-character hex string)
   */
  doInstanceNameOrId: string;
  
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
 * Provides transparent RPC access to Durable Object methods with automatic connection management.
 * 
 * Connection is established automatically on first method call (lazy connection).
 * Implements Symbol.asyncDispose for automatic cleanup with 'await using' keyword.
 * 
 * @example
 * ```typescript
 * // Recommended: Automatic cleanup with 'await using':
 * {
 *   await using client = createRpcClient<MyDO>({ ... });
 *   const result = await client.myMethod(); // Auto-connects on first call
 * } // Connection automatically closed when leaving scope
 * 
 * // Manual: No explicit cleanup needed for short-lived clients:
 * const client = createRpcClient<MyDO>({ ... });
 * const result = await client.myMethod(); // Auto-connects on first call
 * // WebSocket cleaned up on worker/page unload
 * 
 * // React example with useEffect:
 * useEffect(() => {
 *   const client = createRpcClient<MyDO>({ ... });
 *   // Cleanup using Symbol.asyncDispose
 *   return () => client[Symbol.asyncDispose]();
 * }, []);
 * ```
 */
export interface RpcClientProxy {
  /**
   * Automatic cleanup when using 'await using' syntax.
   * Disconnects and cleans up transport resources automatically when the client goes out of scope.
   * 
   * @example
   * ```typescript
   * await using client = createRpcClient<MyDO>({ ... });
   * // Use client here - auto-connects on first method call
   * // disconnect() called automatically at end of scope
   * ```
   */
  [Symbol.asyncDispose](): Promise<void>;
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

