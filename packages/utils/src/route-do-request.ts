import { getDOStub } from './get-do-stub';
import { InvalidStubPathError, PrefixNotFoundError, parsePathname } from './parse-pathname';
import { DOBindingNotFoundError, getDONamespaceFromPathSegment } from './get-do-namespace-from-path-segment';

/**
 * Configuration options for DO request routing and authentication hooks.
 */
export interface RouteOptions {
  /**
   * Hook called before WebSocket requests (Upgrade: websocket) reach the Durable Object.
   * 
   * @param request - The incoming WebSocket upgrade request
   * @param context - Routing context with DO namespace and instance identifier
   * @param context.doNamespace - The resolved DurableObjectNamespace for the binding
   * @param context.doInstanceNameOrId - The instance name or unique ID from the URL path
   * @returns Response to block request, Request to modify request, undefined/void to continue
   */
  onBeforeConnect?: (
    request: Request, 
    context: { doNamespace: any; doInstanceNameOrId: string }
  ) => Promise<Response | Request | undefined | void> | Response | Request | undefined | void;

  /**
   * Hook called before non-WebSocket HTTP requests reach the Durable Object.
   * 
   * @param request - The incoming HTTP request  
   * @param context - Routing context with DO namespace and instance identifier
   * @param context.doNamespace - The resolved DurableObjectNamespace for the binding
   * @param context.doInstanceNameOrId - The instance name or unique ID from the URL path
   * @returns Response to block request, Request to modify request, undefined/void to continue
   */
  onBeforeRequest?: (
    request: Request, 
    context: { doNamespace: any; doInstanceNameOrId: string }
  ) => Promise<Response | Request | undefined | void> | Response | Request | undefined | void;

  /**
   * URL prefix that must be present before DO routing path.
   * 
   * @example '/agents' makes it match '/agents/my-do/instance' but not '/my-do/instance'
   */
  prefix?: string;
}

/**
 * Routes requests to Durable Objects with support for authentication hooks and prefix matching.
 * 
 * This function provides a drop-in replacement for Cloudflare's routeAgentRequest and PartyKit's
 * routePartyRuest with enhanced flexibility for DO binding name matching and clear, consistent 
 * naming conventions.
 * 
 * **URL Format:**
 * `[/${prefix}]/${doBindingName}/${instanceNameOrIdString}[/path...]`
 * 
 * **Key Features:**
 * - Case-insensitive DO binding name matching (MY_DO matches my-do, MyDO, MyDo, etc.)
 * - Supports both named instances and unique ID strings in the instance path segment
 * - Automatically detects 64-character hex strings (from newUniqueId().toString()) 
 *   and routes them using idFromString() + get() instead of getByName()
 * - No confusing renaming: doBindingName stays doBindingName, instanceName stays instanceName
 *   rather than party/agent, room/name
 * - Follows Hono convention: returns undefined if the request doesn't match
 * - Pre-request/connect hooks to check authentication
 * 
 * **Hook Behavior (matches Cloudflare agents and PartyServer):**
 * - WebSocket requests (Upgrade: websocket) → calls `onBeforeConnect` only
 * - Non-WebSocket requests → calls `onBeforeRequest` only  
 * 
 * @param request - The incoming HTTP request to route
 * @param env - Environment object containing DO bindings (e.g., { MY_DO: DurableObjectNamespace })
 * @param options - Configuration options for routing and hooks
 * @param options.prefix - URL prefix to match before DO routing (default: none)
 * @param options.onBeforeConnect - Hook called before WebSocket requests reach the DO
 * @param options.onBeforeRequest - Hook called before non-WebSocket requests reach the DO
 * 
 * @returns Promise resolving to Response if request was handled, undefined if not matched
 * 
 * @throws {Error} Propagates errors from DO fetch calls or hook execution
 * 
 * @example
 * ```typescript
 * // Basic usage in a Worker fetch handler
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     // Try to route to DOs first
 *     const doResponse = await routeDORequest(request, env);
 *     if (doResponse) return doResponse;
 *     
 *     // Fallback for non-DO requests
 *     return new Response("Not Found", { status: 404 });
 *   }
 * };
 * 
 * // Advanced usage with authentication and prefix
 * const response = await routeDORequest(request, env, {
 *   // Route only URLs starting with /agents/
 *   prefix: '/agents',
 *   
 *   // Authentication for WebSocket connections
 *   onBeforeConnect: async (request, { doNamespace, doInstanceNameOrId }) => {
 *     // Validate WebSocket auth token
 *     const token = request.headers.get('Authorization');
 *     if (!token || !await validateToken(token)) {
 *       // Return Response to block connection
 *       return new Response('Unauthorized', { status: 401 });
 *     }
 *     
 *     // Add user info to headers for DO  
 *     const modifiedRequest = new Request(request);
 *     modifiedRequest.headers.set('X-User-ID', await getUserId(token));
 *     return modifiedRequest; // Return modified Request to continue
 *     
 *     // Return nothing/undefined to continue with original request
 *   },
 *   
 *   // Authentication for HTTP requests  
 *   onBeforeRequest: async (request, { doNamespace, doInstanceNameOrId }) => {
 *     // Log request for analytics
 *     console.log(`HTTP request to instance: ${doInstanceNameOrId}`, request.method, request.url);
 *     
 *     // API key validation
 *     const apiKey = request.headers.get('X-API-Key');
 *     if (request.method !== 'GET' && !apiKey) {
 *       return Response.json(
 *         { error: 'API key required for write operations' }, 
 *         { status: 403 }
 *       );
 *     }
 *     
 *     // You can also create a stub early if needed for validation:
 *     // const stub = doNamespace.getByName(doInstanceNameOrId);
 *     // const info = await stub.fetch(new Request('http://internal/info'));
 *     
 *     // Continue processing - return nothing
 *   }
 * });
 * 
 * // URL Examples:
 * // /my-do/instance123                           → routes to env.MY_DO.getByName('instance123')
 * // /chat-room/lobby                             → routes to env.CHAT_ROOM.getByName('lobby')  
 * // /my-do/8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99  
 * //                                              → routes to env.MY_DO.get(env.MY_DO.idFromString('8aa7...'))
 * // /agents/user-do/john                         → with prefix, routes to env.USER_DO.getByName('john')
 * // /websocket-do/game1                          → WebSocket upgrade calls onBeforeConnect
 * // /regular-do/service                          → HTTP request calls onBeforeRequest
 * ```
 */
export async function routeDORequest(request: Request, env: any, options: RouteOptions = {}): Promise<Response | undefined> {
  try {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const { doBindingNameSegment, doInstanceNameOrId } = parsePathname(pathname, options);

    // Get the namespace using existing function
    const doNamespace = getDONamespaceFromPathSegment(doBindingNameSegment, env);

    const hookContext = { doNamespace, doInstanceNameOrId };

    // Call hooks based on request type (matching Cloudflare's if/else behavior)
    const isWebSocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";

    if (isWebSocket) {
      if (options?.onBeforeConnect) {
        const result = await options.onBeforeConnect(request, hookContext);
        if (result instanceof Response) {
          return result;
        }
        if (result instanceof Request) {
          request = result;
        }
      }
    } else {
      if (options?.onBeforeRequest) {
        const result = await options.onBeforeRequest(request, hookContext);
        if (result instanceof Response) {
          return result;
        }
        if (result instanceof Request) {
          request = result;
        }
      }
    }

    const stub = getDOStub(doNamespace, doInstanceNameOrId);
    return await stub.fetch(request);
  } catch (error: any) {
    if (error instanceof DOBindingNotFoundError || error instanceof InvalidStubPathError || error instanceof PrefixNotFoundError) return undefined
    throw (error);
  }
}
