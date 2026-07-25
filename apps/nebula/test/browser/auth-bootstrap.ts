/**
 * Auth bootstrap for the Nebula browser harness — drives a real magic-link
 * email round-trip end-to-end:
 *
 *   1. Test → wrangler-dev:  POST /auth/<scope>/email-magic-link
 *   2. wrangler-dev → Cloudflare Email Sending → SMTP
 *   3. Cloudflare Email Routing → deployed `email-test` Worker
 *   4. email-test Worker → WebSocket push back to test (waitForEmail)
 *   5. Test → wrangler-dev: GET <magic-link URL> (cookie captured)
 *   6. NebulaClient internally → POST /auth/<scope>/refresh-token (cookie sent,
 *      JWT returned)
 *
 * No test-mode bypass — exercises the same code path a real user would
 * exercise. The audit-test-mode.sh script ensures no future change leaks
 * NEBULA_AUTH_TEST_MODE into wrangler configs / npm scripts / CI.
 */

import { provisionAndLogin, provisionStarFounder } from '../lib/email-login';
import type { Browser } from '@lumenize/testing';

interface BootstrapAdminOptions {
  /** Browser instance to use for HTTP calls (cookies persist across calls). */
  browser: Browser;
  /** wrangler-dev base URL (provided by globalSetup, e.g. 'https://localhost:51234'). */
  baseUrl: string;
  /** Scope (universeGalaxyStarId) to authenticate at — e.g. 'acme.app.tenant-a'. */
  scope: string;
  /** Email to register / log in. Should be `test@lumenize.io` so the deployed email-test Worker receives it. */
  email: string;
  /** TEST_TOKEN for authenticating with the deployed email-test DO. */
  testToken: string;
}

/**
 * End-to-end bootstrap. After this resolves, the Browser's cookie jar holds the refresh cookie
 * scoped to `/auth/${scope}/`, and the caller can construct a
 * `NebulaClient({ baseUrl, fetch: browser.fetch, … })` which mints access JWTs via the real
 * refresh-token flow.
 *
 * **Re-grounded onto `claim-star` (2026-07-25).** It used to POST `email-magic-link` and rely on
 * "the first email registered at a scope becomes its founder" — a founder-minting-on-login path that
 * was deliberately removed (identity mint is authority-point-only; the registry says outright *"NEVER
 * call from a login path"*). Between that removal and `claim-star` landing, this helper was simply
 * broken: the link was issued and emailed fine, then rejected on consumption — `getAndVerifyIdentity`
 * → null → `302 /app?error=invalid_token`, **no cookie** — which is what reddened this whole lane.
 *
 * `provisionStarFounder` closes it by walking the path a real tenant walks: the universe + galaxy are
 * provisioned by their own founder, then the **open** `claim-star` mints this email as the star's
 * founder and emails the claim link. Still ADR-009 rung 1 — a real send, received by the deployed
 * `email-test` Worker, no test-mode bypass.
 *
 * ⚠️ The resulting identity is an **exact-star** founder, not a universe admin with `{u}.*` reach.
 * That is deliberate and is the higher-fidelity fixture (a confinement assertion passes vacuously
 * under a universe admin), but it means this helper cannot bootstrap a scope ABOVE the star, and it
 * cannot bootstrap a reserved `{u}.{g}.dev` workspace — those are founderless by construction.
 *
 * For a galaxy- or universe-scoped fixture use {@link bootstrapUniverseAdmin} instead.
 */
export async function bootstrapStarFounder(options: BootstrapAdminOptions): Promise<void> {
  const { browser, baseUrl, scope, email, testToken } = options;
  await provisionStarFounder({ baseUrl, scope, email, testToken, fetchImpl: browser.fetch });
}

/**
 * Bootstrap a **universe founder** and provision the tree down to `scope`, leaving the refresh cookie
 * at `/auth/{universe}/`. Returns the universe scope, which callers pass as their client's
 * `authScope`. Reach is `{u}.*`, so the client targets any descendant via `activeScope`.
 *
 * ⚠️ **This exists because a galaxy cannot be logged into directly.** `create-galaxy` mints no
 * founder and there is no `claim-galaxy`, so no `Identities` row can ever exist at a 2-segment scope —
 * meaning no refresh cookie can ever be set at `/auth/{u}.{g}/`. The old helper POSTed
 * `email-magic-link` there and relied on login-time minting, which was removed as the
 * stranger-claims-a-child escalation; that is why every galaxy-scoped caller in this lane went red.
 *
 * Authenticating at the universe and naming the target in `activeScope` is not a workaround — it is
 * the shape production uses (`prodLogin` at `nebula-platform`, then refresh at the target).
 */
export async function bootstrapUniverseAdmin(options: BootstrapAdminOptions): Promise<string> {
  const { browser, baseUrl, scope, email, testToken } = options;
  const universe = scope.split('.')[0];
  await provisionAndLogin({ baseUrl, scope, email, testToken, fetchImpl: browser.fetch });
  return universe;
}
