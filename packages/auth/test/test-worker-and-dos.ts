import { LumenizeAuth } from '../src/lumenize-auth.js';
import { routeDORequest } from '@lumenize/utils';

// Re-export the Auth DO for wrangler
export { LumenizeAuth };

/**
 * Test Worker that routes requests to the Auth DO
 * 
 * Uses two routeDORequest calls:
 * 1. Auth routes (prefix: 'auth') - No middleware, Auth DO handles its own auth
 * 2. Other routes - Would have auth middleware in real usage
 */
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    // Auth routes - no middleware needed, Auth DO handles per-endpoint auth
    const authResponse = await routeDORequest(request, env, {
      prefix: 'auth',
      cors: true
    });
    if (authResponse) return authResponse;

    // For testing, also allow direct access to LUMENIZE_AUTH binding
    const directResponse = await routeDORequest(request, env);
    if (directResponse) return directResponse;

    return new Response('Not Found', { status: 404 });
  }
};

