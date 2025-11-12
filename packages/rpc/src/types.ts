// Re-export OCAN types from core
export type { Operation, OperationChain } from '@lumenize/core';

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
  
  /**
   * Use blockConcurrencyWhile() to ensure all RPC operations and storage
   * complete before the next request/message can be processed.
   * 
   * When enabled:
   * - Guarantees that async operations complete before the next request
   * - Ensures storage operations are fully persisted
   * - Maintains DO consistency even with async/await usage
   * 
   * When disabled (default):
   * - Relies on Cloudflare's automatic input/output gates
   * - Should still be safe if you avoid fetch(), setTimeout(), setInterval()
   * - Slightly less explicit but potentially more performant
   * 
   * @default false
   */
  blockConcurrency?: boolean;
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

// Re-export nested operation marker from core
export type { NestedOperationMarker } from '@lumenize/core';
export { isNestedOperationMarker } from '@lumenize/core';

/**
 * RPC-specific extension to NestedOperationMarker for batching optimization.
 * Adds __refId for alias detection across batched operations.
 * @internal
 */
export interface RpcNestedOperationMarker {
  __isNestedOperation: true;
  __refId?: string;  // Unique identifier for alias detection (RPC batching only)
  __operationChain?: OperationChain;  // Optional - omitted for aliases
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
 * 
 * @example
 * ```typescript
 * import { createRpcClient, createWebSocketTransport } from '@lumenize/rpc';
 * 
 * const client = createRpcClient({
 *   transport: createWebSocketTransport('MY_DO', 'instance-name')
 * });
 * ```
 */
export interface RpcClientConfig {
  /**
   * Transport instance for RPC communication.
   * Use createWebSocketTransport() or createHttpTransport() for built-in transports,
   * or provide your own RpcTransport implementation.
   * 
   * @example
   * ```typescript
   * import { createWebSocketTransport } from '@lumenize/rpc';
   * 
   * const client = createRpcClient({
   *   transport: createWebSocketTransport('my-do', 'instance-1')
   * });
   * ```
   */
  transport: RpcTransport;

  /**
   * Optional client identifier for tracking WebSocket connections on the server.
   * Required when using downstream messaging (onDownstream handler).
   * The server can use this to target specific clients when sending messages.
   */
  clientId?: string;

  /**
   * Optional handler for downstream messages sent from the server.
   * Receives deserialized payloads with full type support.
   * 
   * When provided:
   * - Automatically enables keep-alive mode
   * - Requires clientId to be set
   * - Connection stays open and auto-reconnects
   * 
   * @example
   * ```typescript
   * const client = createRpcClient({
   *   transport: createWebSocketTransport('CHAT_ROOM', 'room-123'),
   *   clientId: 'user-456',
   *   onDownstream: (message) => {
   *     console.log('New message:', message);
   *   }
   * });
   * ```
   */
  onDownstream?: (payload: any) => void | Promise<void>;

  /**
   * Optional handler called when the WebSocket connection closes.
   * Receives close code and reason, allowing the application to:
   * - Handle authentication expiration (code 4401)
   * - Refresh tokens and reconnect
   * - Update UI to show disconnected state
   * - Implement custom reconnection logic
   * 
   * Common close codes:
   * - 1000: Normal closure
   * - 1006: Abnormal closure (connection lost)
   * - 4401: Custom code for authentication expired
   * 
   * @example
   * ```typescript
   * const client = createRpcClient({
   *   transport: createWebSocketTransport('MY_DO', 'instance'),
   *   clientId: 'user-123',
   *   onClose: async (code, reason) => {
   *     if (code === 4401) {
   *       // Authentication expired - refresh and reconnect
   *       const newToken = await refreshToken();
   *       // Create new client with fresh token
   *     }
   *   }
   * });
   * ```
   */
  onClose?: (code: number, reason: string) => void | Promise<void>;
}

/**
 * Internal full configuration - same as public config now that transport is required.
 * @internal
 */
export type RpcClientInternalConfig = RpcClientConfig;

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
   * using client = createRpcClient<MyDO>({
   *   transport: createWebSocketTransport('MY_DO', 'instance-name')
   * });
   * // Use client here - auto-connects on first method call
   * // disconnect() called automatically at end of scope
   * ```
   */
  [Symbol.dispose](): void;

  /**
   * Access to the underlying transport instance.
   * Useful for advanced scenarios like checking connection status.
   * 
   * @example
   * ```typescript
   * const client = createRpcClient<MyDO>({
   *   transport: createWebSocketTransport('MY_DO', 'instance-name')
   * });
   * const isConnected = client.transportInstance.isConnected?.() ?? false;
   * ```
   */
  transportInstance: RpcTransport;

  /**
   * Returns a plain object representation of the proxied object with functions
   * represented as readable strings like "functionName [Function]".
   * Useful for debugging and testing.
   * 
   * @example
   * ```typescript
   * const client = createRpcClient<MyDO>({
   *   transport: createWebSocketTransport('MY_DO', 'instance-name')
   * });
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
  
  /**
   * Register a handler for downstream messages (type: '__downstream').
   * Handler is called with the deserialized payload for server-sent messages.
   * Used for downstream messaging - allows application layer to handle non-RPC messages.
   * Only WebSocket transport implements this.
   * @internal
   */
  setDownstreamHandler?(handler: (payload: any) => void | Promise<void>): void;
  
  /**
   * Enable/disable keep-alive mode (required).
   * When enabled:
   * - Automatically reconnects when connection drops (WebSocket only)
   * - Can reconnect hours/days later (browser tab sleep/wake)
   * HTTP transport implements as no-op.
   * 
   * Note: Does NOT send periodic pings to allow DO hibernation.
   */
  setKeepAlive(enabled: boolean): void;
}

