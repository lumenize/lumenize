import { type RouteOptions } from './route-do-request';

export class InvalidStubPathError extends Error {
  code: 'INVALID_STUB_PATH' = 'INVALID_STUB_PATH';
  httpErrorCode: number = 400;

  constructor(pathname: string) {
    super(`Invalid path for DO stub: '${pathname}'. Expected format: [/prefix]/binding-name/instance-name/...`);
    this.name = 'InvalidStubPathError';
  }
}

export class PrefixNotFoundError extends Error {
  code: 'PREFIX_NOT_FOUND' = 'PREFIX_NOT_FOUND';
  httpErrorCode: number = 404;

  constructor(pathname: string, expectedPrefix: string) {
    super(`Path '${pathname}' does not start with required prefix '${expectedPrefix}'`);
    this.name = 'PrefixNotFoundError';
  }
}

/**
 * Parse pathname to extract binding segment and instance segment, accounting for optional prefix.
 * 
 * @param pathname - The URL pathname (e.g., "/my-do/instance-123/some/path" or "/__rpc/something/my-do/instance-123/path")
 * @param options - Route options containing optional prefix
 * @returns Object with doBindingNameSegment and doInstanceNameOrId
 * @throws {InvalidStubPathError} If pathname doesn't have required segments after prefix removal
 * @throws {PrefixNotFoundError} If required prefix is not found at start of pathname
 */
export function parsePathname(pathname: string, options?: RouteOptions): { doBindingNameSegment: string; doInstanceNameOrId: string } {
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
      throw new PrefixNotFoundError(pathname, prefixWithoutTrailingSlash);
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

  const doBindingNameSegment = segments[0];
  const doInstanceNameOrId = segments[1];

  return { doBindingNameSegment, doInstanceNameOrId };
}