import type { Operation, OperationChain, RPCRequest, RPCResponse, RPCConfig } from './types';

/**
 * Browser-specific RPC client configuration
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
 * Forward declaration for RPCClient
 */
export interface RPCClient {
  execute(operations: OperationChain): Promise<any>;
}

/**
 * Internal state for proxy objects
 */
export interface ProxyState {
  operationChain: OperationChain;
  rpcClient: RPCClient;
}

/**
 * Symbol used to identify proxy objects
 */
export const PROXY_STATE_SYMBOL = Symbol('lumenize-rpc-proxy-state');

/**
 * Type guard to check if an object is a proxy with state
 */
export function isProxyObject(obj: any): obj is ProxyState & Record<string | symbol, any> {
  return obj && typeof obj === 'object' && obj[PROXY_STATE_SYMBOL] !== undefined;
}

/**
 * Type guard to check if an object is a remote function marker
 */
export function isRemoteFunctionMarker(obj: any): obj is import('./types').RemoteFunctionMarker {
  return obj && typeof obj === 'object' && obj.__isRemoteFunction === true;
}