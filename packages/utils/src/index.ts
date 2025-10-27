// Export all utility functions
export * from './get-do-namespace-from-path-segment';
export * from './get-do-stub';
export * from './parse-pathname';
export * from './websocket-utils';
export * from './route-do-request';
export * from './cookie-utils';
export * from './browser';
export * from './websocket-shim';
export * from './metrics';
export * from './web-api-serialization';

// Convenience exports
import { routeDORequest, type RouteOptions } from './route-do-request';

/**
 * Convenience wrapper for `routeDORequest` with `agentCompatibility: true`.
 * 
 * A drop-in replacement for Cloudflare's `routeAgentRequest` from the `agents` package.
 * Automatically adds required headers (`x-partykit-namespace`, `x-partykit-room`) and
 * defaults to `prefix: 'agents'` for routing Agent DOs.
 * 
 * @param request - The incoming HTTP request to route
 * @param env - Environment object containing DO bindings
 * @param options - Configuration options (agentCompatibility is set to true)
 * @returns Promise resolving to Response if request was handled, undefined if not matched
 * 
 * @example
 * ```typescript
 * export default {
 *   async fetch(request, env) {
 *     return (
 *       await routeAgentRequest(request, env) ||
 *       new Response("Not Found", { status: 404 })
 *     );
 *   }
 * }
 * ```
 */
export async function routeAgentRequest(
  request: Request, 
  env: any, 
  options: Omit<RouteOptions, 'agentCompatibility'> = {}
): Promise<Response | undefined> {
  return routeDORequest(request, env, { ...options, agentCompatibility: true });
}
