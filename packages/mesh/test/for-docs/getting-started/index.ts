/**
 * Worker entry point for getting-started.mdx examples
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
export { DocumentDO } from './document-do.js';
export { SpellCheckWorker, type SpellFinding } from './spell-check-worker.js';
export { AuthEmailSender } from './auth-email-sender.js';

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
      ...authHooks,
    });

    if (response) {
      return response;
    }

    return new Response('Not Found', { status: 404 });
  },
};
