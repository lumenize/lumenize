/**
 * The platform host's own routes, as an app of its own: login and signup, Home, a link's page and
 * its consume, acceptance, logout and the refresh — every step in a session's lifecycle, on
 * `platform.lumenize.dev` alone (ADR-022).
 *
 * The default `fetch` reaches it through the self-referencing `PLATFORM_HOST` service binding, the
 * way `AUTH_EMAIL_SENDER` reaches `AuthEmailSender`, for `/` and every path under `/auth/` on the
 * platform host. Its answer is final; a path it does not know is its 404.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { routeAuthRequest } from '@lumenize/mesh/auth';
import { scopeLifecycleHooks } from './scope-lifecycle-hooks';

export class PlatformHost extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    return (await routeAuthRequest(request, this.env, { hooks: scopeLifecycleHooks }))
      ?? new Response('Not Found', { status: 404 });
  }
}
