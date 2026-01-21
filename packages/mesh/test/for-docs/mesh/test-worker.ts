/**
 * Worker entry point for getting-started.mdx examples
 *
 * Re-exports DO classes for wrangler bindings and handles routing.
 */

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
export { DocumentDO } from './document-do.js';
export { SpellCheckWorker, type SpellFinding } from './spell-check-worker.js';

// Worker entry point
export default {
  async fetch(request: Request, env: Env) {
    // Get public keys from env
    const publicKeys = [env.JWT_PUBLIC_KEY_BLUE, env.JWT_PUBLIC_KEY_GREEN].filter(Boolean);

    // Handle auth routes (/auth/email-magic-link, /auth/magic-link, /auth/refresh-token, /auth/logout)
    const authRoutes = createAuthRoutes(env, { redirect: '/app' });
    const authResponse = await authRoutes(request);
    if (authResponse) {
      return authResponse;
    }

    // Create auth middleware for WebSocket and HTTP requests
    const wsAuth = await createWebSocketAuthMiddleware({ publicKeysPem: publicKeys });
    const httpAuth = await createAuthMiddleware({ publicKeysPem: publicKeys });

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
