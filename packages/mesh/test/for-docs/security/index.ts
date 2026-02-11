/**
 * Worker entry point for security.mdx examples
 *
 * Re-exports DO classes for wrangler bindings and handles routing.
 */

import { env } from 'cloudflare:workers';
import { routeDORequest } from '@lumenize/routing';
import {
  LumenizeAuth,
  createAuthRoutes,
  createRouteDORequestAuthHooks
} from '@lumenize/auth';
import { LumenizeClientGateway } from '../../../src/index.js';

// Re-export classes for wrangler bindings
export { LumenizeClientGateway, LumenizeAuth };
export { UserProfileDO } from './user-profile-do.js';
export { TeamDocDO } from './team-doc-do.js';

// Create auth routes and hooks once at module level
const authRoutes = createAuthRoutes(env);
const authHooks = await createRouteDORequestAuthHooks(env);

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
      cors: { origin: ['https://localhost'] },
      ...authHooks,
    });

    if (response) {
      return response;
    }

    return new Response('Not Found', { status: 404 });
  },
};
