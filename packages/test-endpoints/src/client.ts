/**
 * Test endpoint configuration for Lumenize integration tests.
 * 
 * Use this instead of httpbin.org for reliable, fast test endpoints.
 * 
 * The token and URL are stored in .dev.vars for local dev and as Cloudflare secrets in production.
 */

/**
 * Create test endpoints client with token and URL from environment
 * 
 * @param token - Test token (from env.TEST_TOKEN)
 * @param baseUrl - Base URL for test endpoints (from env.TEST_ENDPOINTS_URL)
 */
export function createTestEndpoints(token: string, baseUrl: string) {
  return {
    /**
     * Create request with test token header
     */
    createRequest(path: string, init?: RequestInit): Request {
      const headers = new Headers(init?.headers);
      headers.set('X-Test-Token', token);
      
      return new Request(`${baseUrl}${path}`, {
        ...init,
        headers
      });
    },
    
    /**
     * Fetch with test token header
     */
    async fetch(path: string, init?: RequestInit): Promise<Response> {
      return fetch(this.createRequest(path, init));
    }
  };
}
