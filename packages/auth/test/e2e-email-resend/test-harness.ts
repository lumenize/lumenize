import { LumenizeAuth } from '../../src/lumenize-auth.js';
import { AuthEmailSenderBase } from '../../src/auth-email-sender-base.js';
import { createAuthRoutes } from '../../src/create-auth-routes.js';
import { routeDORequest } from '@lumenize/routing';

// Re-export the Auth DO for wrangler
export { LumenizeAuth };

// AuthEmailSender for the Resend e2e smoke test — keeps the Resend path exercised
// alongside the default Cloudflare path. Uses the verified test.lumenize.com
// Resend sending domain.
export class AuthEmailSender extends AuthEmailSenderBase {
  from = 'auth@test.lumenize.com';
  appName = 'Lumenize Test (Resend)';
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
