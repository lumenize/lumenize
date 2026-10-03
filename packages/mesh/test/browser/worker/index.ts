/**
 * Browser-test worker for @lumenize/mesh — mirrors the documented
 * getting-started.mdx pattern verbatim, with two overrides: the
 * `AuthEmailSender.from` address (a `lumenize.io` address, a verified sender),
 * and mail through Resend rather than the `send_email` binding (`EMAIL_PROVIDER`
 * in wrangler.jsonc).
 *
 * Everything else — the `createAuthRoutes` + `createRouteDORequestAuthHooks`
 * + `routeDORequest(prefix:'gateway', ...authHooks)` composition, the
 * `DocumentDO` + `SpellCheckWorker` mesh nodes — is re-exported as-is from
 * `test/for-docs/getting-started/`. That keeps the browser test pinned to
 * the canonical pattern: if a change to the getting-started example breaks
 * the documented worker setup, this test fails loudly.
 *
 * See website/docs/mesh/getting-started.mdx § "Step 6: Set Up the Worker
 * Entry Point" for the source-of-truth pattern.
 */

import { env } from 'cloudflare:workers';
import { routeDORequest } from '@lumenize/routing';
import {
  LumenizeAuth,
  createAuthRoutes,
  createRouteDORequestAuthHooks,
  AuthEmailSenderBase,
} from '@lumenize/auth';
import { LumenizeClientGateway } from '../../../src/index.js';

// Re-export DO classes for wrangler bindings
export { LumenizeClientGateway, LumenizeAuth };
export { DocumentDO } from '../../for-docs/getting-started/document-do.js';
export { SpellCheckWorker, type SpellFinding } from '../../for-docs/getting-started/spell-check-worker.js';

/**
 * Test-only email sender. Differs from the getting-started example only in
 * the `from` address — `lumenize.io` is a verified sender; `auth@example.com`
 * (the example in the doc) wouldn't actually deliver. A sender on a domain that isn't onboarded drops silently, and
 * the magic-link login then waits out the test timeout.
 */
export class AuthEmailSender extends AuthEmailSenderBase {
  from = 'test@lumenize.io';
}

// Module-top-level construction mirrors `getting-started.mdx § Step 6`
// verbatim. JWT secrets must exist on the Worker before deploy — see
// `tasks/playwright-test-template.md` for the bootstrap procedure (deploy
// once with placeholder vars to create the Worker, `wrangler secret bulk`
// the real keys, then deploy again).
const authRoutes = createAuthRoutes(env);
const authHooks = await createRouteDORequestAuthHooks(env);

export default {
  async fetch(request: Request) {
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
