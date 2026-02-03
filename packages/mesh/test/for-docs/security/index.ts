/**
 * Worker entry point for security.mdx examples
 *
 * Re-exports DO classes for wrangler bindings and handles routing.
 */

import { env } from 'cloudflare:workers';
import { routeDORequest } from '@lumenize/utils';
import {
  LumenizeAuth,
  createAuthRoutes,
  createWebSocketAuthMiddleware,
  createAuthMiddleware
} from '@lumenize/auth';
import { LumenizeClientGateway } from '../../../src/index.js';

// Re-export classes for wrangler bindings
export { LumenizeClientGateway, LumenizeAuth };
export { ProtectedDO } from './protected-do.js';
export { GuardedDO } from './guarded-do.js';

// Create auth routes and middleware once at module level
const publicKeys = [env.JWT_PUBLIC_KEY_BLUE, env.JWT_PUBLIC_KEY_GREEN].filter(Boolean);
const authRoutes = createAuthRoutes(env);
const wsAuth = await createWebSocketAuthMiddleware({ publicKeysPem: publicKeys });
const httpAuth = await createAuthMiddleware({ publicKeysPem: publicKeys });

// Worker entry point
export default {
  async fetch(request: Request) {
    // Handle auth routes (/auth/email-magic-link, /auth/magic-link, /auth/refresh-token, /auth/logout)
    const authResponse = await authRoutes(request);
    if (authResponse) {
      return authResponse;
    }

    const response = await routeDORequest(request, env, {
      prefix: 'gateway',
      onBeforeConnect: wsAuth,
      onBeforeRequest: httpAuth,
    });

    if (response) {
      return response;
    }

    return new Response('Not Found', { status: 404 });
  },
};
