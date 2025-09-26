import { type RouteOptions } from './route-do-request';

/**
 * Error thrown when a pathname doesn't have the required segments for DO routing.
 * 
 * A valid DO path must have at least 2 segments after prefix removal:
 * [/prefix]/binding-name/instance-name[/additional-path]
 */
export class InvalidStubPathError extends Error {
  code: 'INVALID_STUB_PATH' = 'INVALID_STUB_PATH';
  httpErrorCode: number = 400;

  constructor(pathname: string) {
    super(`Invalid path for DO stub: '${pathname}'. Expected format: [/prefix]/binding-name/instance-name/...`);
    this.name = 'InvalidStubPathError';
  }
}

/**
 * Error thrown when a pathname doesn't start with a required prefix.
 * 
 * Used when RouteOptions.prefix is specified but the incoming pathname
 * doesn't match the expected prefix pattern.
 */
export class PrefixNotFoundError extends Error {
  code: 'PREFIX_NOT_FOUND' = 'PREFIX_NOT_FOUND';
  httpErrorCode: number = 404;

  constructor(pathname: string, expectedPrefix: string) {
    super(`Path '${pathname}' does not start with required prefix '${expectedPrefix}'`);
    this.name = 'PrefixNotFoundError';
  }
}

/**
 * Parse pathname to extract DO binding name segment and instance identifier, accounting for optional prefix.
 * 
 * This function handles the core pathname parsing logic for Durable Object routing:
 * 1. Removes optional prefix if specified
 * 2. Splits remaining path into segments
 * 3. Extracts first segment as binding name and second as instance identifier
 * 4. Validates that both required segments are present
 * 
 * @param pathname - The URL pathname to parse
 * @param options - Route options containing optional prefix configuration
 * @param options.prefix - Optional prefix that must be present at start of pathname
 * @returns Object containing the parsed segments
 * @returns returns.doBindingNameSegment - The DO binding name segment (e.g., "my-do" from "/my-do/instance")
 * @returns returns.doInstanceNameOrId - The instance name or unique ID segment (e.g., "instance" from "/my-do/instance")
 * @throws {PrefixNotFoundError} If required prefix is not found at start of pathname
 * @throws {InvalidStubPathError} If pathname doesn't have required segments after prefix removal
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
 * // Handles unique IDs
 * parsePathname('/my-do/8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99');
 * // → { doBindingNameSegment: 'my-do', doInstanceNameOrId: '8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99' }
 * ```
 */
export function parsePathname(pathname: string, options?: RouteOptions): { doBindingNameSegment: string; doInstanceNameOrId: string } {
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

    // Validate that pathname starts with the required prefix
    if (!pathname.startsWith(prefixWithoutTrailingSlash)) {
      throw new PrefixNotFoundError(pathname, prefixWithoutTrailingSlash);
    }

    // Remove the matched prefix from pathname, leaving the DO routing portion
    // Example: '/api/v1/my-do/instance' with prefix '/api/v1' → '/my-do/instance'
    processedPathname = pathname.slice(prefixWithoutTrailingSlash.length) || '/';
  }

  // Split pathname into segments, filtering out empty strings from leading/trailing slashes
  // Example: '/my-do/instance/path' → ['my-do', 'instance', 'path']
  const segments = processedPathname.split('/').filter(Boolean);

  // Validate minimum required segments: binding-name and instance-name/id
  // Any additional segments after these two are considered part of the forwarded path
  if (segments.length < 2) {
    throw new InvalidStubPathError(pathname);
  }

  // Extract the two required segments for DO routing
  const doBindingNameSegment = segments[0];  // Used for env binding lookup (e.g., 'my-do' → env.MY_DO)
  const doInstanceNameOrId = segments[1];    // Used for getByName() or idFromString() + get()

  return { doBindingNameSegment, doInstanceNameOrId };
}