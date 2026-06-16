/**
 * Browser-test Worker entrypoint.
 *
 * Wraps the production Nebula entrypoint with bench-specific routes:
 *
 *   - `/bench/colo` — returns the Worker's own colo via `request.cf.colo`.
 *     The Gateway DO for this user's session is reliably in the same colo
 *     (DOs follow first-access placement; user is consistent), so this
 *     also identifies the Gateway colo.
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
export { BenchFanoutTier } from './bench-fanout-tier';

export {
  Universe,
  Galaxy,
} from '@lumenize/nebula';

// Bench Worker binds NEBULA_CLIENT_GATEWAY → InstrumentedNebulaClientGateway,
// re-exported under the `NebulaClientGateway` name so the wrangler.jsonc class
// binding (and any prior migration history) stays unchanged.
export { InstrumentedNebulaClientGateway as NebulaClientGateway } from './instrumented-nebula-client-gateway';

export { NebulaAuth, NebulaAuthRegistry } from '@lumenize/nebula-auth';

export { StarTest } from '../../test-apps/baseline/index';

import { NebulaEmailSender } from '@lumenize/nebula-auth';

/**
 * Test-harness email sender — overrides production NebulaEmailSender's
 * `from` from `auth@nebula.lumenize.com` to `test@lumenize.io`.
 *
 * Why: the browser harness uses `send_email` with `remote: true`, which
 * proxies to real Cloudflare Email Sending. That requires the sender
 * domain to be verified on the account. `lumenize.io` is verified
 * (used by packages/auth/test/e2e-email/); `nebula.lumenize.com` is not
 * — sending from it returns "destination address is not a verified
 * address" and silently drops the email.
 *
 * Using `test@lumenize.io` as the from-address piggybacks on the
 * already-verified domain. The deployed email-test Worker (which catches
 * routed emails on lumenize.io) sees the email and pushes it back to
 * the test via WebSocket.
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

    return entrypoint.fetch(request);
  },
};
