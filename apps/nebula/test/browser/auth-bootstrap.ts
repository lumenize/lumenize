/**
 * Auth bootstrap for the Nebula browser harness — drives a real magic-link
 * email round-trip end-to-end:
 *
 *   1. Test → wrangler-dev, on the platform host: a claim, or POST /auth/email-magic-link
 *   2. wrangler-dev → Resend → SMTP
 *   3. Cloudflare Email Routing → deployed `email-test` Worker
 *   4. email-test Worker → WebSocket push back to test (waitForEmail)
 *   5. Test → the link's page: its POST /auth/magic-link (cookies captured)
 *   6. NebulaClient on a scope's page → POST /auth/refresh-token on the platform host, `Origin`
 *      naming the page (cookies sent, JWT returned)
 *
 * No test-mode bypass — exercises the same code path a real user would
 * exercise. The audit-test-mode.sh script ensures no future change leaks
 * AUTH_TEST_MODE into wrangler configs / npm scripts / CI.
 */

import { provisionAndLogin, provisionStarAdmin } from '../lib/email-login';
import type { Browser } from '@lumenize/testing';

interface BootstrapAdminOptions {
  /** Browser instance to use for HTTP calls (cookies persist across calls). */
  browser: Browser;
  /** wrangler-dev base URL (provided by globalSetup, e.g. 'https://localhost:51234'). */
  baseUrl: string;
  /** Scope (universeGalaxyStarId) to authenticate at — e.g. 'acme.app.tenant-a'. */
  scope: string;
  /**
   * Email to register / log in — any `*@lumenize-test.dev` address reaches the deployed email-test
   * Worker. Prefer `uniqueTestEmail()`: mail to one much-used address queued for 17–114 s on
   * 2026-10-03 while a fresh address arrived in about a second.
   */
  email: string;
  /** TEST_TOKEN for authenticating with the deployed email-test DO. */
  testToken: string;
}

/**
 * End-to-end bootstrap of an **exact-star** admin. After this resolves, the Browser's jar holds the
 * platform host's refresh cookie named for `scope`, and a `NebulaClient` on that scope's page mints
 * access JWTs from it through the real refresh.
 *
 * `provisionStarAdmin` walks the path a real tenant walks: the universe and galaxy are provisioned
 * by their own admin, then the **open** `claim-star` mints this email as the star's admin and emails
 * the claim link. ADR-009 rung 1 — a real send, received by the deployed `email-test` Worker, no
 * test-mode bypass.
 *
 * ⚠️ The resulting identity is an exact-star admin, not a universe admin. That is deliberate and is
 * the higher-fidelity fixture (a confinement assertion passes vacuously under a universe admin), but
 * it means this helper cannot bootstrap a scope ABOVE the star, nor a reserved `{u}.{g}.dev` Star,
 * which nobody founds. For those use {@link bootstrapUniverseAdmin}.
 */
export async function bootstrapStarAdmin(options: BootstrapAdminOptions): Promise<void> {
  const { browser, baseUrl, scope, email, testToken } = options;
  await provisionStarAdmin({ baseUrl, scope, email, testToken, fetchImpl: browser.fetch });
}

/**
 * Bootstrap a **universe admin** and provision the tree down to `scope`, leaving the universe's
 * refresh cookie in the Browser. Returns the universe scope. Its admin membership mints on every
 * page beneath the universe, so a client on a galaxy's or Star's page acts there as the universe's
 * admin — the shape production uses for anyone working across an account.
 */
export async function bootstrapUniverseAdmin(options: BootstrapAdminOptions): Promise<string> {
  const { browser, baseUrl, scope, email, testToken } = options;
  const universe = scope.split('.')[0];
  await provisionAndLogin({ baseUrl, scope, email, testToken, fetchImpl: browser.fetch });
  return universe;
}
