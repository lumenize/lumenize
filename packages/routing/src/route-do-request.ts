import { getDOStub } from './get-do-stub';
import { parsePathname } from './parse-pathname';
import { getDONamespaceFromPathSegment } from './get-do-namespace-from-path-segment';
import { debug } from '@lumenize/debug';

/**
 * Error thrown when a pathname has a valid doBindingName segment but not a 
 * doInstanceNameOrId segment.
 * 
 * A valid DO path must have at least 2 segments after prefix removal:
 * [/prefix]/doBindingName/doInstanceNameOrId[/additional-path]
 */
export class MissingInstanceNameError extends Error {
  code: 'MISSING_INSTANCE_NAME' = 'MISSING_INSTANCE_NAME';
  httpErrorCode: number = 400;

  constructor(pathname: string) {
    super(`doBindingName found but doInstanceNameOrId missing. Expected format: [/prefix]/doBindingName/doInstanceNameOrId/...`);
    this.name = 'MissingInstanceNameError';
  }
}

/**
 * CORS configuration options. See [CORS Support](/docs/routing/cors-support) for details.
 */
export type CorsOptions = 
  | false  // No CORS headers
  | true   // Permissive: echo any Origin
  | { origin: string[] }  // Whitelist of allowed origins
  | { origin: (origin: string, request: Request) => boolean };  // Custom validation function

/**
 * Context passed to routing hooks (onBeforeConnect, onBeforeRequest).
 *
 * Provides information about the target Durable Object so hooks can make
 * routing decisions or enhance requests with additional context.
 */
export interface RouteDORequestHooksContext {
  /** The resolved DurableObjectNamespace for the binding */
  doNamespace: any;
  /** The instance name or unique ID from the URL path */
  doInstanceNameOrId: string;
}

/**
 * Configuration options for DO request routing and authentication hooks.
 */
export interface RouteOptions {
  /**
   * Hook called before WebSocket requests (Upgrade: websocket) reach the Durable Object.
   *
   * @param request - The incoming WebSocket upgrade request
   * @param context - Routing context with DO namespace and instance identifier
   * @returns Response to block call to DO, Request to enhance request, undefined/void to continue
   */
  onBeforeConnect?: (
    request: Request,
    context: RouteDORequestHooksContext
  ) => Promise<Response | Request | undefined | void> | Response | Request | undefined | void;

  /**
   * Hook called before non-WebSocket HTTP requests reach the Durable Object.
   *
   * @param request - The incoming HTTP request
   * @param context - Routing context with DO namespace and instance identifier
   * @returns Response to block call to DO, Request to enhance request, undefined/void to continue
   */
  onBeforeRequest?: (
    request: Request,
    context: RouteDORequestHooksContext
  ) => Promise<Response | Request | undefined | void> | Response | Request | undefined | void;

  /**
   * URL prefix that must be present before DO routing path.
   */
  prefix?: string;

  /**
   * CORS configuration for cross-origin requests.
   * 
   * - `false` (default): No CORS headers
   * - `true`: Permissive mode - echo any request's Origin header
   * - `{ origin: string[] }`: Whitelist of allowed origins
   * - `{ origin: (origin: string, request: Request) => boolean }`: Custom validation function
   * 
   * For detailed examples and security considerations, see https://lumenize.com/docs/routing/cors-support
   */
  cors?: CorsOptions;

  /**
   * Add Agent/PartyKit compatibility headers to requests forwarded to the DO.
   * 
   * When `true`, automatically adds these headers before forwarding:
   * - `x-partykit-namespace`: The DO binding name segment from the URL
   * - `x-partykit-room`: The DO instance name or ID from the URL
   * 
   * These headers are required by Cloudflare's `Agent` class (from the `agents` package)
   * and PartyKit's `Server` class (from the `partyserver` package).
   * 
   * When enabled, `prefix` defaults to `'agents'` (matching the agents package convention)
   * unless explicitly overridden.
   * 
   * @default false
   */
  agentCompatibility?: boolean;
}

/**
 * Check if a cross-origin request should get CORS headers based on configuration.
 * 
 * @param origin - The Origin header value from the request
 * @param corsOptions - The CORS configuration
 * @param request - The full request object for validator function inspection
 * @returns true if CORS headers should be added, false otherwise
 */
export function isOriginAllowed(origin: string, corsOptions: CorsOptions, request: Request): boolean {
  if (corsOptions === false) {
    return false;
  }
  
  if (corsOptions === true) {
    return true;
  }
  
  // Handle object configuration
  if (Array.isArray(corsOptions.origin)) {
    return corsOptions.origin.includes(origin);
  }
  
  // Function validator - pass both origin and request
  return corsOptions.origin(origin, request);
}

/**
 * Add CORS headers to a response if origin is allowed.
 *
 * @param response - The response to add headers to
 * @param origin - The allowed origin to reflect
 * @returns New Response with CORS headers
 */
export function addCorsHeaders(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', 'Origin');

  // For WebSocket upgrades (status 101), preserve the webSocket property
  const init: ResponseInit = {
    status: response.status,
    statusText: response.statusText,
    headers
  };

  if (response.webSocket) {
    init.webSocket = response.webSocket;
  }

  return new Response(response.body, init);
}

/**
 * Decision returned by {@link applyCorsPolicy}: either an early response the
 * caller should return immediately (preflight 204 or 403 reject), or an
 * `allowedOrigin` the caller should use to wrap its final response with
 * {@link addCorsHeaders}.
 */
export interface CorsDecision {
  /**
   * If set, return this Response immediately. Already wrapped with CORS
   * headers if appropriate (preflight 204 with `Access-Control-Allow-Origin`
   * when origin is allowed; bare 403 when origin is rejected).
   */
  earlyResponse?: Response;
  /**
   * The origin to reflect in `Access-Control-Allow-Origin` when wrapping the
   * caller's final response. `null` means no CORS headers should be added
   * (either CORS is disabled, no Origin header was present, or the request
   * is allowed through without CORS — see preflight/reject paths).
   */
  allowedOrigin: string | null;
}

/**
 * Apply a shared CORS policy to a request. Used by every router in this
 * monorepo that exposes a browser-callable surface.
 *
 * Behavior matches what was previously inlined in {@link routeDORequest}:
 * - CORS disabled or no `Origin` header → `allowedOrigin: null`, no early response.
 * - Allowed origin, `OPTIONS` preflight → 204 with CORS headers (early response).
 * - Allowed origin, any other method → `allowedOrigin: origin`; caller wraps response.
 * - Disallowed origin, `OPTIONS` preflight → 204 without CORS headers (browser blocks).
 * - Disallowed origin, any other method → 403 reject (early response, no headers).
 *
 * @param request - The incoming request
 * @param corsOptions - The CORS configuration (`false` disables CORS entirely)
 * @returns A {@link CorsDecision} for the caller to act on
 */
export function applyCorsPolicy(request: Request, corsOptions: CorsOptions): CorsDecision {
  const requestOrigin = request.headers.get('Origin');

  // No Origin header or CORS disabled → pass through with no CORS state
  if (!requestOrigin || corsOptions === false) {
    return { allowedOrigin: null };
  }

  const allowedOrigin = isOriginAllowed(requestOrigin, corsOptions, request) ? requestOrigin : null;

  // Preflight: always respond to OPTIONS when CORS is enabled and Origin is present
  if (request.method === 'OPTIONS') {
    const response = new Response(null, { status: 204 });
    if (allowedOrigin) {
      return { earlyResponse: addCorsHeaders(response, allowedOrigin), allowedOrigin: null };
    }
    return { earlyResponse: response, allowedOrigin: null };
  }

  // Non-OPTIONS with disallowed origin: 403 without CORS headers
  if (!allowedOrigin) {
    return {
      earlyResponse: new Response('Forbidden: Origin not allowed', { status: 403 }),
      allowedOrigin: null,
    };
  }

  // Allowed origin, non-preflight: caller wraps response with addCorsHeaders(..., allowedOrigin)
  return { allowedOrigin };
}

/**
 * Routes requests to Durable Objects with support for authentication hooks and prefix matching.
 * 
 * A near drop-in replacement for Cloudflare's `routeAgentRequest` and PartyKit's `routePartyRequest`,
 * with enhanced binding name matching flexibility and standard Cloudflare naming conventions.
 * 
 * **URL Format:**
 * `[/${prefix}]/${doBindingName}/${doInstanceNameOrId}[/path...]`
 * 
 * **Key Features:**
 * - Case-insensitive DO binding name matching (MY_DO matches my-do, MyDO, MyDo, etc.)
 * - Supports both named instances and unique ID strings
 * - Automatically detects 64-character hex strings and routes using idFromString()
 * - Returns undefined if the request doesn't match (Hono convention)
 * - Pre-request/connect hooks for authentication and Request enhancement
 * - Comprehensive CORS support
 * 
 * **Hook Behavior:**
 * - WebSocket requests (Upgrade: websocket) → calls `onBeforeConnect` only
 * - Non-WebSocket requests → calls `onBeforeRequest` only
 * 
 * For complete documentation with examples, see https://lumenize.com/docs/routing/route-do-request
 * 
 * @param request - The incoming HTTP request to route
 * @param env - Environment object containing DO bindings
 * @param options - Configuration options for routing and hooks
 * @param options.prefix - URL prefix to match before DO routing (default: none, or 'agents' when agentCompatibility is true)
 * @param options.agentCompatibility - Add Agent/PartyKit compatibility headers (default: false)
 * @param options.onBeforeConnect - Hook called before WebSocket requests reach the DO
 * @param options.onBeforeRequest - Hook called before non-WebSocket requests reach the DO
 * @param options.cors - CORS configuration for cross-origin requests (default: false)
 * 
 * @returns Promise resolving to Response if request was handled, undefined if not matched
 * 
 * @throws {MissingInstanceNameError} When binding name is found but doInstanceNameOrId is missing
 * @throws {MultipleBindingsFoundError} When multiple DO bindings match the doBindingName segment
 */
export async function routeDORequest(request: Request, env: any, options: RouteOptions = {}): Promise<Response | undefined> {
  const log = debug('lmz.utils.routeDORequest');
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Default prefix to 'agents' when agentCompatibility is enabled
  const effectiveOptions = {
    ...options,
    prefix: options.prefix ?? (options.agentCompatibility ? 'agents' : undefined)
  };

  const parseResult = parsePathname(pathname, effectiveOptions);
  
  // Return early if no match (prefix doesn't match or no segments)
  if (!parseResult) {
    return undefined;
  }

  const { doBindingNameSegment, doInstanceNameOrId } = parseResult;

  // Get the namespace and normalized binding name using existing function
  const result = getDONamespaceFromPathSegment(doBindingNameSegment, env);
  
  // Return early if no matching binding found
  if (!result) {
    return undefined;
  }

  const { bindingName, namespace: doNamespace } = result;

  // Throw error if we have a matching binding but missing instance name
  if (doInstanceNameOrId === undefined) {
    throw new MissingInstanceNameError(pathname);
  }

  // Check CORS configuration via shared helper
  const corsDecision = applyCorsPolicy(request, options.cors ?? false);
  if (corsDecision.earlyResponse) {
    log.debug('CORS early response', {
      status: corsDecision.earlyResponse.status,
      method: request.method,
      origin: request.headers.get('Origin'),
      binding: doBindingNameSegment,
      instance: doInstanceNameOrId,
    });
    return corsDecision.earlyResponse;
  }
  const allowedOrigin = corsDecision.allowedOrigin;

  const hookContext = { doNamespace, doInstanceNameOrId };

  // Call hooks based on request type (matching Cloudflare's if/else behavior)
  const isWebSocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";

  if (isWebSocket) {
    if (options?.onBeforeConnect) {
      const result = await options.onBeforeConnect(request, hookContext);
      if (result instanceof Response) {
        log.debug('onBeforeConnect blocked request', {
          binding: bindingName,
          instance: doInstanceNameOrId,
          status: result.status
        });
        return allowedOrigin ? addCorsHeaders(result, allowedOrigin) : result;
      }
      if (result instanceof Request) {
        log.debug('onBeforeConnect modified request', {
          binding: bindingName,
          instance: doInstanceNameOrId
        });
        request = result;
      }
    }
  } else {
    if (options?.onBeforeRequest) {
      const result = await options.onBeforeRequest(request, hookContext);
      if (result instanceof Response) {
        log.debug('onBeforeRequest blocked request', {
          binding: bindingName,
          instance: doInstanceNameOrId,
          method: request.method,
          status: result.status
        });
        return allowedOrigin ? addCorsHeaders(result, allowedOrigin) : result;
      }
      if (result instanceof Request) {
        log.debug('onBeforeRequest modified request', {
          binding: bindingName,
          instance: doInstanceNameOrId,
          method: request.method
        });
        request = result;
      }
    }
  }

  const stub = getDOStub(doNamespace, doInstanceNameOrId);
  
  log.debug('Routing to DO', {
    binding: bindingName,
    instance: doInstanceNameOrId,
    method: request.method,
    pathname,
    isWebSocket,
    hasCors: !!allowedOrigin
  });
  
  // Add routing context headers
  // These headers provide the DO with information about how it was accessed
  const headers = new Headers(request.headers);
  if (options.agentCompatibility) {
    // Agent/PartyKit compatibility mode uses their header names
    headers.set("x-partykit-room", doInstanceNameOrId);
    headers.set("x-partykit-namespace", doBindingNameSegment);
  } else {
    // Standard Lumenize mode uses normalized binding name
    headers.set("X-Lumenize-DO-Instance-Name-Or-Id", doInstanceNameOrId);
    headers.set("X-Lumenize-DO-Binding-Name", bindingName);
  }
  
  // Create new request with added headers
  // Clone the request first to avoid body stream issues
  const forwardRequest = new Request(request, { headers });
  
  const response = await stub.fetch(forwardRequest);
  
  // Add CORS headers to DO response if origin is allowed
  return allowedOrigin ? addCorsHeaders(response, allowedOrigin) : response;
}
