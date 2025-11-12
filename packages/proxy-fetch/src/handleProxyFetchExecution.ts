import { debug } from '@lumenize/core';
import { executeFetch } from './workerFetchExecutor.js';
import type { WorkerFetchMessage } from './types.js';

/**
 * Configuration options for the proxy-fetch execution handler
 */
export interface HandleProxyFetchOptions {
  /**
   * URL path prefix that triggers the handler
   * @default '/proxy-fetch-execute'
   */
  path?: string;
  
  /**
   * Environment variable name containing the shared secret
   * @default 'PROXY_FETCH_SECRET'
   */
  secretEnvVar?: string;
}

/**
 * Error thrown when authentication fails
 */
export class ProxyFetchAuthError extends Error {
  code: 'PROXY_FETCH_AUTH_ERROR' = 'PROXY_FETCH_AUTH_ERROR';
  httpErrorCode: number = 401;

  constructor(message: string) {
    super(message);
    this.name = 'ProxyFetchAuthError';
  }
}

/**
 * Handler for proxy-fetch execution requests.
 * 
 * This handler should be called early in your Worker's fetch handler.
 * It checks if the request is a proxy-fetch execution request and handles it,
 * otherwise returns `undefined` to allow your routing logic to continue.
 * 
 * **Authentication**: Requires `X-Proxy-Fetch-Secret` header matching `env.PROXY_FETCH_SECRET`.
 * Set this secret using: `wrangler secret put PROXY_FETCH_SECRET`
 * 
 * @example
 * ```typescript
 * import { handleProxyFetchExecution } from '@lumenize/proxy-fetch';
 * 
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     // Try proxy-fetch handler first
 *     const proxyFetchResponse = await handleProxyFetchExecution(request, env);
 *     if (proxyFetchResponse) return proxyFetchResponse;
 *     
 *     // Fall through to your routing
 *     return await routeDORequest(request, env, { prefix: 'agents' });
 *   }
 * }
 * ```
 * 
 * @param request - Incoming HTTP request
 * @param env - Worker environment (must contain DO bindings for result delivery)
 * @param options - Configuration options
 * @returns Response if handled, undefined if not our path (fall through)
 * @throws {ProxyFetchAuthError} When authentication fails
 */
export async function handleProxyFetchExecution(
  request: Request,
  env: any,
  options: HandleProxyFetchOptions = {}
): Promise<Response | undefined> {
  const log = debug({ env })('lmz.proxyFetch.handler');
  const url = new URL(request.url);
  
  // Default options
  const path = options.path ?? '/proxy-fetch-execute';
  const secretEnvVar = options.secretEnvVar ?? 'PROXY_FETCH_SECRET';
  
  // Return undefined if not our path (fall through)
  if (!url.pathname.startsWith(path)) {
    return undefined;
  }
  
  log.debug('Proxy-fetch execution request received', { path: url.pathname });
  
  // Validate secret
  const requestSecret = request.headers.get('X-Proxy-Fetch-Secret');
  const expectedSecret = env[secretEnvVar];
  
  if (!expectedSecret) {
    log.error('PROXY_FETCH_SECRET not configured in environment');
    throw new ProxyFetchAuthError('PROXY_FETCH_SECRET not configured. Set it using: wrangler secret put PROXY_FETCH_SECRET');
  }
  
  if (!requestSecret || requestSecret !== expectedSecret) {
    log.warn('Authentication failed: invalid or missing secret');
    throw new ProxyFetchAuthError('Invalid or missing X-Proxy-Fetch-Secret header');
  }
  
  // Parse message
  let message: WorkerFetchMessage;
  try {
    message = await request.json();
  } catch (error) {
    log.error('Failed to parse request body', { error: error instanceof Error ? error.message : String(error) });
    return new Response('Invalid JSON body', { status: 400 });
  }
  
  log.debug('Executing fetch', { reqId: message.reqId });
  
  // Execute fetch (this sends result back to origin DO)
  try {
    await executeFetch(message, env);
    log.debug('Fetch executed successfully', { reqId: message.reqId });
    return new Response('OK', { status: 200 });
  } catch (error) {
    log.error('Failed to execute fetch', {
      reqId: message.reqId,
      error: error instanceof Error ? error.message : String(error)
    });
    return new Response('Internal Server Error', { status: 500 });
  }
}

