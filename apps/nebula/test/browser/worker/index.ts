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
 *
 * KNOWN BUG (2026-04-28): this Worker currently crashes at module load under
 * real `wrangler dev` with `Cannot read properties of undefined (reading
 * 'slice')`. Vitest-pool-workers' miniflare hides the bug because of
 * different env-initialization timing. See
 * tasks/nebula-deployable-and-browser-harness.md Phase 1.
 */

export {
  NebulaClientGateway,
  Universe,
  Galaxy,
  ResourceHistory,
  entrypoint as default,
} from '@lumenize/nebula';

export { NebulaAuth, NebulaAuthRegistry, NebulaEmailSender } from '@lumenize/nebula-auth';

export { StarTest } from '../../test-apps/baseline/index';
