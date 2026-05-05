/**
 * Browser-test Worker entrypoint.
 *
 * Mirrors apps/nebula/test/test-apps/baseline/index.ts but skips the
 * `instrumentDOProject()` wrapping — the browser harness drives transactions
 * via NebulaClient (mesh), so the lumenize-rpc test instrumentation isn't
 * needed.
 *
 * `StarTest` is reused so server-side test affordances (`whoAmI()`,
 * `inspectOntologyKv()`) stay consistent with the existing test-app suite.
 * `NebulaClientTest` lives browser-side in tests, not as a DO binding.
 */

export {
  Universe,
  Galaxy,
  ResourceHistory,
  entrypoint as default,
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
