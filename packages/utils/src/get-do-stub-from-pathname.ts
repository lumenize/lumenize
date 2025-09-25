import { getDONamespaceFromPathSegment } from './get-do-namespace-from-path-segment';
import { type RouteOptions } from './route-do-request'

export class InvalidStubPathError extends Error {
  code: 'INVALID_STUB_PATH' = 'INVALID_STUB_PATH';
  httpErrorCode: number = 400;

  constructor(pathname: string) {
    super(`Invalid path for DO stub: '${pathname}'. Expected format: [/prefix]/binding-name/instance-name/...`);
    this.name = 'InvalidStubPathError';
  }
}

/**
 * Parse pathname to extract binding segment and instance segment, accounting for optional prefix.
 * 
 * @param pathname - The URL pathname (e.g., "/my-do/instance-123/some/path" or "/__rpc/something/my-do/instance-123/path")
 * @param options - Route options containing optional prefix
 * @returns Object with bindingSegment and instanceNameOrIdSegment
 * @throws {InvalidStubPathError} If pathname doesn't have required segments after prefix removal
 */
function parsePathname(pathname: string, options?: RouteOptions): { bindingSegment: string; instanceNameOrIdSegment: string } {
  let processedPathname = pathname;
  
  // Handle prefix removal if provided
  if (options?.prefix) {
    // Normalize prefix (ensure it starts with / and doesn't end with /)
    const normalizedPrefix = options.prefix.startsWith('/') 
      ? options.prefix 
      : `/${options.prefix}`;
    const prefixWithoutTrailingSlash = normalizedPrefix.endsWith('/') 
      ? normalizedPrefix.slice(0, -1) 
      : normalizedPrefix;
    
    // If pathname doesn't start with prefix, throw error
    if (!pathname.startsWith(prefixWithoutTrailingSlash)) {
      throw new InvalidStubPathError(pathname);
    }
    
    // Remove the prefix from pathname for DO routing
    processedPathname = pathname.slice(prefixWithoutTrailingSlash.length) || '/';
  }
  
  // Split pathname into segments, filtering out empty strings
  const segments = processedPathname.split('/').filter(Boolean);
  
  // We need at least 2 segments for binding name and instance name/ID
  if (segments.length < 2) {
    throw new InvalidStubPathError(pathname);
  }
  
  const bindingSegment = segments[0];
  const instanceNameOrIdSegment = segments[1];
  
  return { bindingSegment, instanceNameOrIdSegment };
}

/**
 * Get a Durable Object stub from a URL pathname with intelligent case conversion for binding resolution.
 * 
 * @param pathname - The URL pathname (e.g., "/my-do/instance-123/some/path")
 * @param env - The Cloudflare Workers environment object
 * @returns The DurableObjectStub for the matched binding and instance
 * @throws {InvalidPathError} If no binding path segment provided
 * @throws {InvalidStubPathError} If no instance name path segment provided
 * @throws {DOBindingNotFoundError} If no matching binding found
 * @throws {MultipleBindingsFoundError} If multiple bindings match the path segment
 * 
 * @example
 * ```typescript
 * // URL: /my-do/user-session-abc123/connect
 * // Env has: { MY_DO: durableObjectNamespace }
 * const stub = getDOStubFromPathname('/my-do/user-session-abc123/connect', env);
 * 
 * // URL: /userSession/guid-456/data  
 * // Env has: { UserSession: durableObjectNamespace }
 * const stub = getDOStubFromPathname('/userSession/guid-456/data', env);
 * 
 * // URL: /my-do/8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99/connect
 * // Handles unique IDs (64-char hex strings) using idFromString instead of getByName
 * const stub = getDOStubFromPathname('/my-do/8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99/connect', env);
 * ```
 */
export function getDOStubFromPathname(pathname: string, env: Record<string, any>, options?: RouteOptions): any {
  // Extract the instance name (second path segment)
  const { bindingSegment, instanceNameOrIdSegment } = parsePathname(pathname, options);

  // Get the namespace using existing function
  const namespace = getDONamespaceFromPathSegment(bindingSegment, env);
  
  // Determine if this is a unique ID (64-char hex string) or a named instance
  const isUniqueId = /^[a-f0-9]{64}$/.test(instanceNameOrIdSegment);
  
  let stub;
  if (isUniqueId) {
    // For unique IDs, use idFromString to get the proper DurableObjectId
    const id = namespace.idFromString(instanceNameOrIdSegment);
    stub = namespace.get(id);
  } else {
    // For named instances, use getByName as before
    stub = namespace.getByName(instanceNameOrIdSegment);
  }
  return { stub, namespace, bindingSegment, instanceNameOrIdSegment };
}
