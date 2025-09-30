/**
 * Operation types that align with JavaScript Proxy traps
 */
export type Operation = 
  | { type: 'get', key: string | number | symbol }     // Property/element access
  | { type: 'apply', args: any[] };                    // Function calls (deserialized, ready for execution)

/**
 * Wire format operation types (for transport over HTTP)
 * args are structured-clone serialized for complex type support
 */
export type WireOperation = 
  | { type: 'get', key: string | number | symbol }     // Property/element access
  | { type: 'apply', args: any };                      // Function calls (serialized args array)

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
 * Wire format operation chain (for transport over HTTP)
 */
export type WireOperationChain = WireOperation[];

/**
 * Request format sent to DO RPC endpoint (wire format)
 */
export interface RPCRequest {
  operations: WireOperationChain;
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
export interface RPCResponse {
  success: boolean;
  result?: any; // Serialized with structured-clone, preserves Cloudflare types
  error?: any;  // Custom-serialized Error object preserving all properties
}

/**
 * Configuration for RPC system
 */
export interface RPCConfig {
  /**
   * Base path for RPC endpoints
   * @default "/__rpc"
   */
  basePath?: string;
  
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
 * Internal marker for remote functions during serialization
 */
export interface RemoteFunctionMarker {
  __isRemoteFunction: true;
  __operationChain: OperationChain;
  __functionName?: string;
}

// =====================================================================================
// CLIENT-SPECIFIC TYPES
// =====================================================================================

/**
 * RPC client configuration
 */
export interface BrowserRPCConfig extends RPCConfig {
  /**
   * Base URL for the Durable Object RPC endpoints
   * @default location.origin
   */
  baseUrl?: string;

  /**
   * Request timeout in milliseconds
   * @default 30000
   */
  timeout?: number;

  /**
   * Custom fetch function (for testing or alternative implementations)
   * @default globalThis.fetch
   */
  fetch?: typeof fetch;

  /**
   * Request headers to include in all RPC requests
   */
  headers?: Record<string, string>;
}



/**
 * Type guard to check if an object is a remote function marker
 */
export function isRemoteFunctionMarker(obj: any): obj is RemoteFunctionMarker {
  return obj && typeof obj === 'object' && obj.__isRemoteFunction === true;
}

