/**
 * Test endpoint configuration for Lumenize integration tests.
 * 
 * Use this instead of httpbin.org for reliable, fast test endpoints.
 * 
 * The token is stored in .dev.vars for local dev and as a Cloudflare secret in production.
 */

const BASE_URL = 'https://test-endpoints.transformation.workers.dev';

/**
 * Create test endpoints client with token from environment
 * 
 * @param token - Test token (from env.TEST_TOKEN in tests)
 */
export function createTestEndpoints(token: string) {
  return {
    /**
     * Create request with test token header
     */
    createRequest(path: string, init?: RequestInit): Request {
      const headers = new Headers(init?.headers);
      headers.set('X-Test-Token', token);
      
      return new Request(`${BASE_URL}${path}`, {
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
