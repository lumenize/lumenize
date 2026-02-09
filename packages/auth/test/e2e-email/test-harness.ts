import { LumenizeAuth } from '../../src/lumenize-auth.js';
import { ResendEmailSender } from '../../src/resend-email-sender.js';
import { createAuthRoutes } from '../../src/create-auth-routes.js';
import { routeDORequest } from '@lumenize/utils';

// Re-export the Auth DO for wrangler
export { LumenizeAuth };

// AuthEmailSender for the e2e test — sends real emails via Resend
// from the verified test.lumenize.com domain
export class AuthEmailSender extends ResendEmailSender {
  from = 'auth@test.lumenize.com';
  appName = 'Lumenize Test';
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const authRoutes = createAuthRoutes(env, { cors: true });
    const authResponse = await authRoutes(request);
    if (authResponse) return authResponse;

    const directResponse = await routeDORequest(request, env);
    if (directResponse) return directResponse;

    return new Response('Not Found', { status: 404 });
  },
};
