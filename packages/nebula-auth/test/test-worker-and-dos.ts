/**
 * Test worker entry point — exports DO classes and default fetch handler
 * for wrangler bindings. Lives next to test/wrangler.jsonc.
 */
import { routeNebulaAuthRequest } from '../src/router';
import { NebulaEmailSender as ProdNebulaEmailSender } from '../src/nebula-email-sender';
import { debug } from '@lumenize/debug';
import type { ResolvedEmail } from '@lumenize/auth';

// Re-export DO classes for wrangler bindings
export { NebulaAuth } from '../src/nebula-auth';
export { NebulaAuthRegistry } from '../src/nebula-auth-registry';

/**
 * Email sender service binding entrypoint (bound as AUTH_EMAIL_SENDER) — a TEST
 * subclass that captures-and-drops instead of hitting a real provider.
 *
 * Why: these unit tests exercise the auth flows, not delivery, and the symlinked
 * `.dev.vars` supplies `RESEND_API_KEY` with no `EMAIL` binding — so the
 * production `sendEmail` (via `@lumenize/email`'s `createEmailTransport`) would
 * make REAL Resend API calls that fail ("domain not verified", rate-limited) as
 * uncaught fire-and-forget rejections on the entrypoint side. Capturing here
 * keeps every send in-process and side-effect-free; the `nebula-auth.test.email`
 * debug marker lets a future test assert sends via a sink. (Real-delivery
 * coverage lives in `packages/auth/test/e2e-email*` and the nebula browser
 * harness, which use a verified domain + `remote: true`.)
 */
export class NebulaEmailSender extends ProdNebulaEmailSender {
  override async sendEmail(email: ResolvedEmail): Promise<void> {
    debug('nebula-auth.test.email').debug('captured (test sender — no real send)', {
      to: email.to,
      subject: email.subject,
    });
  }
}

// Default Worker export — test-only, not part of the library's public API
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await routeNebulaAuthRequest(request, env) ?? new Response('Not Found', { status: 404 });
  },
};
