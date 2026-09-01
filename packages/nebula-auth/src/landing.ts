/**
 * Where a login (or an invite letter's "go to the app" link) lands, split by TIER.
 *
 * Extracted from `worker-token.ts` so the invite entry helper (`invite-entry.ts`) can build the
 * `invite-existing` redirect from the same rule the login redirects use, without a module cycle
 * (worker-token → invite-entry → worker-token).
 */
import { parseId } from './parse-id';
import { NEBULA_AUTH_PREFIX } from './types';

/**
 * The built-app surface a **star**-tier login lands on. Hardcoded, not an env var: `/app` is where a
 * tenant's instance of the user-developer's app is served, and that is fixed by the routing scheme
 * (`run_worker_first: ["/app/*", …]`), not by deployment.
 */
export const STAR_LANDING_PREFIX = '/app';

/**
 * The control-plane surface every non-star tier lands on. Hardcoded for the same reason
 * {@link STAR_LANDING_PREFIX} is: `/studio/{scope}` is fixed by the routing scheme, not by
 * deployment. It used to read `NEBULA_AUTH_REDIRECT`, a knob inherited from `@lumenize/auth` back
 * when any host app could configure where login landed; nebula-auth serves one app, the value never
 * held a second setting, and its own star arm was already hardcoded beside it.
 */
export const STUDIO_LANDING_PREFIX = '/studio';

/** Where a proved address chooses what to enter — the Home screen, per scope. */
export function homePath(universeGalaxyStarId: string): string {
  return `${NEBULA_AUTH_PREFIX}/${encodeURIComponent(universeGalaxyStarId)}/home`;
}

/** Where a proved address with NO memberships lands: the claim screen. */
export const SIGNUP_PATH = `${NEBULA_AUTH_PREFIX}/signup`;

/**
 * Where a POST-ACCEPT navigation for `universeGalaxyStarId` lands, split by TIER.
 *
 * A **star** is an end user arriving at the app they signed up for; every other tier is a
 * user-developer arriving at their own control plane.
 *
 * ⚠️ **Derive the tier from a SERVER-TRUSTED id.** On the success path that is the scope the consumed
 * token resolved to, never the URL's `instanceName`: `parseScopeGuard` only *format*-validates that
 * segment and never cross-checks it against the token (the registry keys on `tokenHash` alone), so
 * keying off it would let a caller pick another tier's landing surface. The error path has no token to
 * resolve, so it necessarily falls back to the URL segment — which is safe there precisely because it
 * grants nothing: the response is a bare `?error=` redirect either way.
 */
export function landingBase(universeGalaxyStarId: string | undefined): string {
  let tier: string | undefined;
  if (universeGalaxyStarId) {
    try { tier = parseId(universeGalaxyStarId).tier; } catch { /* unparseable → treat as non-star */ }
  }
  return tier === 'star' ? STAR_LANDING_PREFIX : STUDIO_LANDING_PREFIX;
}
