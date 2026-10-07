/**
 * Browser-test Worker entrypoint.
 *
 * Wraps the production Nebula entrypoint with bench-specific routes:
 *
 *   - `/bench/colo` — returns the Worker's own colo via `request.cf.colo`.
 *     The host node a test's client connects to is reliably in the same colo
 *     when the test is first to touch it (DOs follow first-access placement),
 *     so this also identifies the host node's colo.
 *   - `/bench/cross-region-star?jurisdiction=eu` — creates a Star DO via
 *     `newUniqueId({ jurisdiction })` and returns its hex ID. Used by
 *     `cross-region.test.ts` to deliberately place a Star outside the
 *     user's colo for cross-region Workers RPC measurement.
 *
 * Everything else passes through to the Nebula entrypoint unchanged.
 *
 * `StarTest` is reused from the baseline test app so server-side test
 * affordances (`whoAmI()`, `inspectOntologyKv()`, `delay()`, `getColo()`)
 * stay consistent.
 */

import { entrypoint } from '@lumenize/nebula';
import { env } from 'cloudflare:workers';
import { routeAgentRequest } from 'agents';

export { BenchAgent } from './bench-agent';

export {
  Universe,
  NebulaAuthFacade,
  PlatformHost,
} from '@lumenize/nebula';
// The consent route reaches a person's Profile through the `@rawRpc()` bridge.
export { Profile } from '@lumenize/nebula-auth/profile';

// Bench Worker binds GALAXY and STAR to host nodes that emit the bench marker, re-exported under
// the names the wrangler.jsonc class bindings already use.
export { InstrumentedGalaxy as Galaxy, InstrumentedStar as StarTest } from './instrumented-hosts';

export { NebulaAuthRegistry } from '@lumenize/nebula-auth';


import { NebulaEmailSender } from '@lumenize/nebula-auth';

/**
 * Test-harness email sender — overrides production NebulaEmailSender's
 * `from` (`noreply@lumenize.io`) to `test@lumenize.io`, the sender the other
 * test lanes use.
 *
 * Why: this harness selects **Resend** (`EMAIL_PROVIDER: resend` in
 * wrangler.jsonc, no `send_email` binding), so the from-domain must be
 * verified on **Resend** — `lumenize.io` is (same setup as
 * packages/auth/test/e2e-email-resend).
 * The magic-link recipient stays `test@lumenize-test.dev`, which Cloudflare Email
 * Routing catches and forwards to the deployed email-test Worker → WebSocket
 * push back to the test. Selecting Resend lets this lane run with no CF creds
 * (incl. the secret-less Claude-hosted lane); the CF Email Sending path is
 * covered by packages/auth/test/e2e-email.
 *
 * This subclass is harness-only — production NebulaEmailSender ships
 * unchanged with its real branded from-address.
 */
export class TestNebulaEmailSender extends NebulaEmailSender {
  override from = 'test@lumenize.io';
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Bench-specific routes. Anything outside /bench/* falls through to
    // the Nebula entrypoint.
    if (url.pathname === '/bench/colo') {
      const colo = (request as any).cf?.colo ?? 'unknown';
      return Response.json({ workerColo: colo });
    }

    // Route /agents/* to the Cloudflare Agents routing layer (used by the
    // fanout-scaling bench's BenchAgent comparison side). Returns null for
    // non-matching paths so the request falls through to the Nebula entry.
    const agentResponse = await routeAgentRequest(request, env as any);
    if (agentResponse) return agentResponse;

    if (url.pathname === '/bench/cross-region-star') {
      const jurisdiction = url.searchParams.get('jurisdiction');
      if (jurisdiction !== 'eu' && jurisdiction !== 'fedramp') {
        return new Response(
          'Bad request: jurisdiction must be "eu" or "fedramp"',
          { status: 400 },
        );
      }
      const id = (env as any).STAR.newUniqueId({ jurisdiction });
      const stub = (env as any).STAR.get(id);
      // Force the DO to be created/woken so subsequent calls work. The
      // first method call is what actually places the DO.
      const colo = await stub.getColo();
      return Response.json({ id: id.toString(), jurisdiction, colo });
    }

    // FORWARD GUARD (tasks/archive/nebula-release-process.md): the shared prod entrypoint's
    // `/_version` build-compare route is reached HERE via this trailing fallthrough — NOT as a
    // "first statement", so the entrypoint's can't-be-reordered defense doesn't hold on the bench
    // worker. Never add a catch-all route ABOVE this fallthrough that would shadow `/_version`
    // (or any prod path). The bench deploy's own `--define __GIT_SHA__` substitutes the global the
    // imported prod `entrypoint` reads (this file bundles separately). Harmless either way —
    // `/_version` discloses nothing.
    return entrypoint.fetch(request);
  },
};
