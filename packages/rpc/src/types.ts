/**
 * Operation types that align with JavaScript Proxy traps
 */
export type Operation = 
  | { type: 'get', key: string | number | symbol }     // Property/element access
  | { type: 'apply', args: any[] };                    // Function calls

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
 * Request format sent to DO RPC endpoint
 */
export interface RPCRequest {
  operations: OperationChain;
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

