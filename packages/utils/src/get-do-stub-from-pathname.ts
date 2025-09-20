import { getDONamespaceFromPathname } from './get-do-namespace-from-pathname.js';

export class InvalidStubPathError extends Error {
  code: 'INVALID_STUB_PATH' = 'INVALID_STUB_PATH';
  httpErrorCode: number = 400;

  constructor(pathname: string) {
    super(`Invalid path for DO stub: '${pathname}'. Expected format: /binding-name/instance-name/...`);
    this.name = 'InvalidStubPathError';
  }
}

/**
 * Extract the second path segment from a URL pathname for the DO instance name.
 * Returns null if no valid segment found.
 */
function extractInstanceName(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  return segments.length >= 2 ? segments[1] : null;
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
export function getDOStubFromPathname(pathname: string, env: Record<string, any>): any {
  // Get the namespace using existing function
  const namespace = getDONamespaceFromPathname(pathname, env);
  
  // Extract the instance name (second path segment)
  const instanceName = extractInstanceName(pathname);
  if (!instanceName) {
    throw new InvalidStubPathError(pathname);
  }
  
  // Determine if this is a unique ID (64-char hex string) or a named instance
  const isUniqueId = /^[a-f0-9]{64}$/.test(instanceName);
  
  if (isUniqueId) {
    // For unique IDs, use idFromString to get the proper DurableObjectId
    const id = namespace.idFromString(instanceName);
    return namespace.get(id);
  } else {
    // For named instances, use getByName as before
    return namespace.getByName(instanceName);
  }
}
