import { LumenizeAuth } from '../src/lumenize-auth.js';
import { createAuthRoutes } from '../src/create-auth-routes.js';
import { routeDORequest } from '@lumenize/utils';

// Re-export the Auth DO for wrangler
export { LumenizeAuth };

/**
 * Test Worker that routes requests to the Auth DO
 *
 * Uses createAuthRoutes for auth endpoints (reads prefix from env).
 */
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    // Auth routes — createAuthRoutes reads prefix from env
    const authRoutes = createAuthRoutes(env, { cors: true });
    const authResponse = await authRoutes(request);
    if (authResponse) return authResponse;

    // For testing, also allow direct access to LUMENIZE_AUTH binding
    const directResponse = await routeDORequest(request, env);
    if (directResponse) return directResponse;

    return new Response('Not Found', { status: 404 });
  }
};
