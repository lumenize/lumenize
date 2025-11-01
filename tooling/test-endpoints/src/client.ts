/**
 * Test endpoint configuration for Lumenize integration tests.
 * 
 * Use this instead of httpbin.org for reliable, fast test endpoints.
 * 
 * The token and URL are stored in .dev.vars for local dev and as Cloudflare secrets in production.
 * 
 * **Instance Isolation**: Each test should use a unique instance name to prevent cross-test
 * pollution. The instance name is part of the URL and routes to an isolated DO instance.
 */

/**
 * Build a test endpoint URL with DO routing
 * 
 * @param baseUrl - Base URL for test endpoints (from env.TEST_ENDPOINTS_URL)
 * @param path - Endpoint path (e.g., '/uuid', '/status/200')
 * @param instanceName - Unique instance name for DO isolation
 * @param token - Optional token to append as query parameter
 * @returns Full URL with DO routing
 * 
 * @example
 * ```typescript
 * const url = buildTestEndpointUrl(
 *   env.TEST_ENDPOINTS_URL,
 *   '/uuid',
 *   'my-test',
 *   env.TEST_TOKEN
 * );
 * // Returns: https://test-endpoints.../test-endpoints-do/my-test/uuid?token=...
 * ```
 */
export function buildTestEndpointUrl(
  baseUrl: string,
  path: string,
  instanceName: string,
  token?: string
): string {
  const basePath = `/test-endpoints-do/${instanceName}`;
  const url = `${baseUrl}${basePath}${path}`;
  
  if (token) {
    const separator = path.includes('?') ? '&' : '?';
    return `${url}${separator}token=${token}`;
  }
  
  return url;
}

/**
 * Create test endpoints client with token, URL, and instance name
 *
 * @param token - Test token (from env.TEST_TOKEN)
 * @param baseUrl - Base URL for test endpoints (from env.TEST_ENDPOINTS_URL)
 * @param instanceName - Unique instance name for DO isolation (e.g., test suite name)
 * @returns Client object with createRequest, fetch, and buildUrl methods
 *
 * @example
 * ```typescript
 * // In your test setup:
 * const TEST_ENDPOINTS = createTestEndpoints(
 *   env.TEST_TOKEN,
 *   env.TEST_ENDPOINTS_URL,
 *   'my-test-suite'  // Unique per test suite for isolation
 * );
 *
 * // Use in tests:
 * const response = await TEST_ENDPOINTS.fetch('/uuid');
 * 
 * // Or build URL for use elsewhere:
 * const url = TEST_ENDPOINTS.buildUrl('/uuid');
 * ```
 */
export function createTestEndpoints(
  token: string,
  baseUrl: string,
  instanceName: string = 'default'
) {
  // Build base path with DO routing: /{bindingName}/{instanceName}
  const basePath = `/test-endpoints-do/${instanceName}`;

  return {
    /**
     * Build full URL with DO routing and token
     *
     * @param path - Endpoint path (e.g., '/uuid', '/status/200')
     * @returns Full URL with DO routing and token
     */
    buildUrl(path: string): string {
      return buildTestEndpointUrl(baseUrl, path, instanceName, token);
    },

    /**
     * Create request with test token and DO routing
     *
     * @param path - Endpoint path (e.g., '/uuid', '/status/200')
     * @param init - Standard fetch RequestInit options
     */
    createRequest(path: string, init?: RequestInit): Request {
      const headers = new Headers(init?.headers);
      headers.set('X-Test-Token', token);

      return new Request(`${baseUrl}${basePath}${path}`, {
        ...init,
        headers
      });
    },

    /**
     * Fetch with test token and DO routing
     *
     * @param path - Endpoint path (e.g., '/uuid', '/status/200')
     * @param init - Standard fetch RequestInit options
     */
    async fetch(path: string, init?: RequestInit): Promise<Response> {
      return fetch(this.createRequest(path, init));
    }
  };
}
