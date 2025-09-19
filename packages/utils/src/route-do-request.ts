import { getDOStubFromPathname } from './get-do-stub-from-pathname.js';
import { DOBindingNotFoundError } from './get-do-namespace-from-pathname.js';

export interface RouteOptions {
  onBeforeConnect?: (request: Request) => Response | undefined | void;
  onBeforeRequest?: (request: Request) => Response | undefined | void;
  prefix?: string;
}

// Expects same format as Cloudflare agents package and PartyKit 
// `/${prefix}/${doBindingName}/${instanceName}`
// However, it's much less picky about the case of the doBindingName
// If the binding name is MY_DO, it'll match my-do, MyDO, MyDo, etc.
// And there is no confusing renaming of doBindingName to agent or party
// nor instanceName to name or room
// 
// Follows hono convention for handlers/middleware, returning undefined if it's not a match
export function routeDORequest(request: Request, env: any, options: RouteOptions = {}): Response | undefined {
  try {
    const url = new URL(request.url);
    let pathname = url.pathname;
    
    // Check if request matches the prefix (if provided)
    if (options.prefix) {
      // Normalize prefix (ensure it starts with / and doesn't end with /)
      const normalizedPrefix = options.prefix.startsWith('/') 
        ? options.prefix 
        : `/${options.prefix}`;
      const prefixWithoutTrailingSlash = normalizedPrefix.endsWith('/') 
        ? normalizedPrefix.slice(0, -1) 
        : normalizedPrefix;
      
      // If pathname doesn't start with prefix, this router doesn't handle it
      if (!pathname.startsWith(prefixWithoutTrailingSlash)) {
        return undefined;
      }
      
      // Remove the prefix from pathname for DO routing
      pathname = pathname.slice(prefixWithoutTrailingSlash.length) || '/';
    }

    // Check if this is a WebSocket upgrade request
    const isWebSocketUpgrade = request.method === 'GET' &&
      request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
      request.headers.get('connection')?.toLowerCase().includes('upgrade');

    // Run appropriate before hooks
    if (isWebSocketUpgrade && options.onBeforeConnect) {
      const beforeConnectResult = options.onBeforeConnect(request);
      if (beforeConnectResult instanceof Response) {
        return beforeConnectResult;
      }
    } else if (!isWebSocketUpgrade && options.onBeforeRequest) {
      const beforeRequestResult = options.onBeforeRequest(request);
      if (beforeRequestResult instanceof Response) {
        return beforeRequestResult;
      }
    }
    
    const stub = getDOStubFromPathname(pathname, env);
    return stub.fetch(request);
  } catch(error: any) {
    if (error.instanceOf && error.instanceOf(DOBindingNotFoundError)) return undefined
    throw(error);
  }
}