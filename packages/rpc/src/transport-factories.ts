import type { RpcTransport } from './types';
import { HttpPostRpcTransport } from './http-post-transport';
import { WebSocketRpcTransport } from './websocket-rpc-transport';

/**
 * Create an HTTP POST RPC transport for communicating with a Durable Object.
 * 
 * @param doBindingName - Name of the DO binding from wrangler.jsonc
 * @param doInstanceNameOrId - DO instance name or ID
 * @param config - Optional transport configuration
 * @returns RpcTransport instance for HTTP communication
 * 
 * @example
 * ```typescript
 * import { createRpcClient, createHttpTransport } from '@lumenize/rpc';
 * 
 * const client = createRpcClient({
 *   transport: createHttpTransport('MY_DO', 'instance-1', {
 *     baseUrl: 'https://api.example.com',
 *     headers: { 'Authorization': 'Bearer token' }
 *   })
 * });
 * ```
 */
export function createHttpTransport(
  doBindingName: string,
  doInstanceNameOrId: string,
  config?: {
    baseUrl?: string;
    prefix?: string;
    timeout?: number;
    fetch?: typeof globalThis.fetch;
    headers?: Record<string, string>;
  }
): RpcTransport {
  return new HttpPostRpcTransport({
    doBindingName,
    doInstanceNameOrId,
    baseUrl: config?.baseUrl ?? (typeof location !== 'undefined' ? location.origin : 'http://localhost:8787'),
    prefix: config?.prefix ?? '/__rpc',
    timeout: config?.timeout ?? 30000,
    fetch: config?.fetch ?? globalThis.fetch,
    headers: config?.headers ?? {}
  });
}

/**
 * Create a WebSocket RPC transport for communicating with a Durable Object.
 * 
 * @param doBindingName - Name of the DO binding from wrangler.jsonc
 * @param doInstanceNameOrId - DO instance name or ID
 * @param config - Optional transport configuration
 * @returns RpcTransport instance for WebSocket communication
 * 
 * @example
 * ```typescript
 * import { createRpcClient, createWebSocketTransport } from '@lumenize/rpc';
 * 
 * const client = createRpcClient({
 *   transport: createWebSocketTransport('MY_DO', 'instance-1')
 * });
 * ```
 */
export function createWebSocketTransport(
  doBindingName: string,
  doInstanceNameOrId: string,
  config?: {
    baseUrl?: string;
    prefix?: string;
    timeout?: number;
    WebSocketClass?: typeof WebSocket;
  }
): RpcTransport {
  return new WebSocketRpcTransport({
    doBindingName,
    doInstanceNameOrId,
    baseUrl: config?.baseUrl ?? (typeof location !== 'undefined' ? location.origin : 'http://localhost:8787'),
    prefix: config?.prefix ?? '/__rpc',
    timeout: config?.timeout ?? 30000,
    WebSocketClass: config?.WebSocketClass ?? WebSocket
  });
}
