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

import { routeDORequest } from '@lumenize/utils';
import { TestEndpointsDO } from './TestEndpointsDO';

export { TestEndpointsDO };
export { createTestEndpoints, buildTestEndpointUrl } from './client';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route all requests to TestEndpointsDO
    // URL format: /{bindingName}/{instanceName}/{endpoint}
    // bindingName is extracted from URL and matched case-insensitively against env bindings
    const response = await routeDORequest(request, env);
    
    // Return 404 if routeDORequest didn't match the request
    return response ?? new Response('Not Found', { status: 404 });
  }
};

interface Env {
  TEST_TOKEN: string;
  TEST_ENDPOINTS_DO: DurableObjectNamespace;
}
