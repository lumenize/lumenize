/**
 * Test HTTP endpoints for Lumenize integration tests.
 * 
 * Provides httpbin.org-like endpoints with built-in request/response tracking.
 * 
 * Routes all requests to TestEndpointsDO via routeDORequest.
 * Test specifies instance name in URL path: /do/{instanceName}/{endpoint}
 * 
 * Available endpoints:
 * - GET /uuid - Returns JSON with a random UUID
 * - GET /json - Returns sample JSON data
 * - GET /status/{code} - Returns specified HTTP status code
 * - GET /delay/{milliseconds} - Delays response by N milliseconds (max 30000)
 * - POST /echo - Echoes back request body and headers
 * 
 * Authentication (one of):
 * - X-Test-Token: <token> header
 * - ?token=<token> query parameter
 */

import { routeDORequest } from '@lumenize/routing';
import { TestEndpointsDO } from './TestEndpointsDO';
import { EnvTestDO } from './EnvTestDO';

export { TestEndpointsDO, EnvTestDO };
export { createTestEndpoints, buildTestEndpointUrl } from './client';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Worker-level env test endpoint (no DO involved)
    if (url.pathname === '/worker-env-test') {
      return new Response(JSON.stringify({
        debugValue: env.DEBUG || 'NOT_SET',
        timestamp: Date.now(),
        note: 'This is read directly from Worker env (no DO)'
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Route all other requests to DOs
    // URL format: /{bindingName}/{instanceName}/{endpoint}
    // bindingName is extracted from URL and matched case-insensitively against env bindings
    const response = await routeDORequest(request, env);
    
    // Return 404 if routeDORequest didn't match the request
    return response ?? new Response('Not Found', { status: 404 });
  }
};

interface Env {
  TEST_TOKEN?: string;
  DEBUG?: string;
  TEST_ENDPOINTS_DO: DurableObjectNamespace;
  ENV_TEST_DO: DurableObjectNamespace;
}
