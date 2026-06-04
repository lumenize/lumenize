/**
 * Browser-test worker for @lumenize/mesh — mirrors the documented
 * getting-started.mdx pattern verbatim, with a single override: the
 * `AuthEmailSender.from` address (overridden so emails route through the
 * lumenize.com domain Larry has onboarded to Cloudflare Email Sending).
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
  CloudflareEmailSender,
} from '@lumenize/auth';
import { LumenizeClientGateway } from '../../../src/index.js';

// Re-export DO classes for wrangler bindings
export { LumenizeClientGateway, LumenizeAuth };
export { DocumentDO } from '../../for-docs/getting-started/document-do.js';
export { SpellCheckWorker, type SpellFinding } from '../../for-docs/getting-started/spell-check-worker.js';

/**
 * Test-only email sender. Differs from the getting-started example only in
 * the `from` address — Larry has `lumenize.com` onboarded for Cloudflare
 * Email Sending; `auth@example.com` (the example in the doc) wouldn't
 * actually deliver.
 */
export class AuthEmailSender extends CloudflareEmailSender {
  from = 'auth@nebula.lumenize.com';
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
