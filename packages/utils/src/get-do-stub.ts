import { DOBindingNotFoundError, getDONamespaceFromPathSegment } from './get-do-namespace-from-path-segment';
import { type RouteOptions } from './route-do-request';
import { parsePathname, InvalidStubPathError, PrefixNotFoundError } from './parse-pathname';

/**
 * Get a Durable Object stub from a URL pathname with intelligent case conversion for binding resolution.
 * 
 * @param pathname - The URL pathname (e.g., "/my-do/instance-123/some/path")
 * @param env - The Cloudflare Workers environment object
 * @param options - Route options containing optional prefix
 * @returns Object containing the DurableObjectStub and parsed routing information
 * @throws {PrefixNotFoundError} If required prefix is not found at start of pathname
 * @throws {InvalidStubPathError} If no instance name path segment provided
 * @throws {DOBindingNotFoundError} If no matching binding found
 * @throws {MultipleBindingsFoundError} If multiple bindings match the path segment
 * 
 * @example
 * ```typescript
 * // URL: /my-do/user-session-abc123/connect
 * // Env has: { MY_DO: durableObjectNamespace }
 * const { stub, namespace, doBindingName, instanceNameOrId } = getDOStubFromPathname('/my-do/user-session-abc123/connect', env);
 * 
 * // URL: /userSession/guid-456/data  
 * // Env has: { UserSession: durableObjectNamespace }
 * const result = getDOStubFromPathname('/userSession/guid-456/data', env);
 * 
 * // URL: /my-do/8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99/connect
 * // Handles unique IDs (64-char hex strings) using idFromString instead of getByName
 * const result = getDOStubFromPathname('/my-do/8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99/connect', env);
 * ```
 */
export function getDOStub(doNamespace: any, doInstanceNameOrId: string): any
{
  // Determine if this is a unique ID (64-char hex string) or a named instance
  const isUniqueId = /^[a-f0-9]{64}$/.test(doInstanceNameOrId);

  let stub;
  if (isUniqueId) {
    // For unique IDs, use idFromString to get the proper DurableObjectId
    const id = doNamespace.idFromString(doInstanceNameOrId);
    stub = doNamespace.get(id);
  } else {
    // For named instances, use getByName as before
    stub = doNamespace.getByName(doInstanceNameOrId);
  }
  return stub;
}
