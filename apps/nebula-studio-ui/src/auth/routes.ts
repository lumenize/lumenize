/**
 * Which auth screen a path renders — the whole of the SPA's routing, as one pure function.
 *
 * ⚠️ **A named function rather than a `v-if` chain in the shell.** The order of a `v-if` /
 * `v-else-if` chain is a decision expressed in template syntax, where no mutation can flip it and no
 * test can see it (`calibration.md` § *You will put a decision in a framework's syntax*). Here the
 * precedence is data — `/auth/signup` must not be read as a scope named "signup" — so it lives
 * somewhere a test can assert it and a mutation can break it.
 */
export type AuthScreen =
  | { screen: 'login' }
  | { screen: 'signup' }
  | { screen: 'emails' }
  | { screen: 'home'; scope: string }
  | { screen: 'unknown' };

/**
 * The scope-less paths, which must win over the `/auth/{scope}/…` pattern.
 *
 * They cannot collide in practice — `signup` is a single segment and `home` needs two — but the
 * precedence is stated rather than left to matcher order, because "which pattern was tried first"
 * is exactly the kind of decision that silently inverts during a refactor.
 */
const FIXED: Record<string, AuthScreen> = {
  '/auth/login': { screen: 'login' },
  '/auth/signup': { screen: 'signup' },
  '/auth/emails': { screen: 'emails' },
};

export function screenForPath(pathname: string): AuthScreen {
  const path = pathname.replace(/\/+$/, '') || pathname;
  const fixed = FIXED[path];
  if (fixed) return fixed;

  // `/auth/{scope}/home` — the scope segment is URL-encoded, since it carries dots.
  const match = /^\/auth\/([^/]+)\/home$/.exec(path);
  if (match) return { screen: 'home', scope: decodeURIComponent(match[1]) };

  return { screen: 'unknown' };
}
