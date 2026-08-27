/**
 * Where a login (or an invite letter's "go to the app" link) lands, split by TIER.
 *
 * Extracted from `worker-token.ts` so the invite entry helper (`invite-entry.ts`) can build the
 * `invite-existing` redirect from the same rule the login redirects use, without a module cycle
 * (worker-token → invite-entry → worker-token).
 */
import { parseId } from './parse-id';

/**
 * The built-app surface a **star**-tier login lands on. Hardcoded, not an env var: `/app` is where a
 * tenant's instance of the user-developer's app is served, and that is fixed by the routing scheme
 * (`run_worker_first: ["/app/*", …]`), not by deployment.
 */
export const STAR_LANDING_PREFIX = '/app';

/**
 * Where a login for `universeGalaxyStarId` lands, split by TIER.
 *
 * A **star** is an end user arriving at the app they signed up for. Every other tier is a
 * user-developer arriving at their own control plane, and rides `NEBULA_AUTH_REDIRECT` — `/studio`
 * since the Galaxy collapse flipped that env value (Studio at `/studio/{scope}`, the built app at
 * `/app/{star}`). So the non-star branch is not new behavior; it is the existing one, named.
 *
 * ⚠️ **Derive the tier from a SERVER-TRUSTED id.** On the success path that is the scope the consumed
 * token resolved to, never the URL's `instanceName`: `parseScopeGuard` only *format*-validates that
 * segment and never cross-checks it against the token (the registry keys on `tokenHash` alone), so
 * keying off it would let a caller pick another tier's landing surface. The error path has no token to
 * resolve, so it necessarily falls back to the URL segment — which is safe there precisely because it
 * grants nothing: the response is a bare `?error=` redirect either way.
 */
export function landingBase(env: Env, universeGalaxyStarId: string | undefined): string {
  let tier: string | undefined;
  if (universeGalaxyStarId) {
    try { tier = parseId(universeGalaxyStarId).tier; } catch { /* unparseable → treat as non-star */ }
  }
  const redirect = (env as any).NEBULA_AUTH_REDIRECT as string;
  return tier === 'star' ? STAR_LANDING_PREFIX : redirect.replace(/\/$/, '');
}
