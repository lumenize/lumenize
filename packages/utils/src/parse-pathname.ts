import { type RouteOptions } from './route-do-request';

/**
 * Parse pathname to extract DO binding name segment and instance identifier, accounting for optional prefix.
 * 
 * This function handles the core pathname parsing logic for Durable Object routing:
 * 1. Removes optional prefix if specified (returns undefined if prefix doesn't match)
 * 2. Splits remaining path into segments
 * 3. Extracts first segment as binding name and second as instance identifier
 * 4. Returns undefined if required segments are not present
 * 
 * @param pathname - The URL pathname to parse
 * @param options - Route options containing optional prefix configuration
 * @param options.prefix - Optional prefix that must be present at start of pathname
 * @returns Object containing the parsed segments, or undefined if parsing fails
 * @returns returns.doBindingNameSegment - The DO binding name segment (e.g., "my-do" from "/my-do/instance")
 * @returns returns.doInstanceNameOrId - The instance name or unique ID segment, or undefined if missing (e.g., "instance" from "/my-do/instance")
 * 
 * @example
 * ```typescript
 * // Basic parsing without prefix
 * parsePathname('/my-do/instance-123/path');
 * // → { doBindingNameSegment: 'my-do', doInstanceNameOrId: 'instance-123' }
 * 
 * // With prefix removal
 * parsePathname('/api/v1/chat-room/lobby/messages', { prefix: '/api/v1' });
 * // → { doBindingNameSegment: 'chat-room', doInstanceNameOrId: 'lobby' }
 * 
 * // No match cases return undefined
 * parsePathname('/wrong-prefix/my-do/instance', { prefix: '/api/v1' });
 * // → undefined
 * 
 * parsePathname('');  // Empty path
 * // → undefined
 * 
 * // Missing instance segment returns binding with undefined instance
 * parsePathname('/my-do');
 * // → { doBindingNameSegment: 'my-do', doInstanceNameOrId: undefined }
 * 
 * // Handles unique IDs
 * parsePathname('/my-do/8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99');
 * // → { doBindingNameSegment: 'my-do', doInstanceNameOrId: '8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99' }
 * ```
 */
export function parsePathname(pathname: string, options?: RouteOptions): { doBindingNameSegment: string; doInstanceNameOrId: string | undefined } | undefined {
  let processedPathname = pathname;

  // Handle prefix removal if specified in options
  if (options?.prefix) {
    // Normalize prefix: ensure it starts with '/' and doesn't end with '/'
    // Examples: 'api' → '/api', '/api/' → '/api', '/api' → '/api'
    const normalizedPrefix = options.prefix.startsWith('/')
      ? options.prefix
      : `/${options.prefix}`;
    const prefixWithoutTrailingSlash = normalizedPrefix.endsWith('/')
      ? normalizedPrefix.slice(0, -1)
      : normalizedPrefix;

    // Check if pathname starts with the required prefix
    if (!pathname.startsWith(prefixWithoutTrailingSlash)) {
      return undefined; // No match - prefix doesn't match
    }

    // Remove the matched prefix from pathname, leaving the DO routing portion
    // Example: '/api/v1/my-do/instance' with prefix '/api/v1' → '/my-do/instance'
    processedPathname = pathname.slice(prefixWithoutTrailingSlash.length) || '/';
  }

  // Split pathname into segments, filtering out empty strings from leading/trailing slashes
  // Example: '/my-do/instance/path' → ['my-do', 'instance', 'path']
  const segments = processedPathname.split('/').filter(Boolean);

  // Check for minimum required segments: doBindingNameSegment and doInstanceNameOrId
  // Any additional segments after these two are considered part of the forwarded path
  if (segments.length < 1) {
    return undefined; // No match - no segments at all
  }

  // Extract the binding name segment (always present if we get here)
  const doBindingNameSegment = segments[0];  // Used for env binding lookup (e.g., 'my-do' → env.MY_DO)
  
  // Extract instance segment if present, undefined if missing
  const doInstanceNameOrId = segments.length >= 2 ? segments[1] : undefined;    // Used for getByName() or idFromString() + get()

  return { doBindingNameSegment, doInstanceNameOrId };
}