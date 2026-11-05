/**
 * Which auth screen a path renders — the whole of the SPA's routing, as one pure function.
 *
 * ⚠️ **A named function rather than a `v-if` chain in the shell.** The order of a `v-if` /
 * `v-else-if` chain is a decision expressed in template syntax, where no mutation can flip it and no
 * test can see it (`calibration.md` § *You will put a decision in a framework's syntax*). Here the
 * mapping is data, so it lives somewhere a test can assert it and a mutation can break it.
 *
 * Every screen is a page on the platform host: Home at its root, the rest under `/auth/`.
 */
export type AuthScreen =
  | { screen: 'home' }
  | { screen: 'login' }
  | { screen: 'signup' }
  | { screen: 'emails' }
  | { screen: 'magic-link' }
  | { screen: 'logout' }
  | { screen: 'unknown' };

const SCREENS: Record<string, AuthScreen> = {
  '/': { screen: 'home' },
  '/auth/login': { screen: 'login' },
  '/auth/signup': { screen: 'signup' },
  '/auth/emails': { screen: 'emails' },
  '/auth/magic-link': { screen: 'magic-link' },
  '/auth/logout': { screen: 'logout' },
};

export function screenForPath(pathname: string): AuthScreen {
  const path = pathname.replace(/\/+$/, '') || '/';
  return SCREENS[path] ?? { screen: 'unknown' };
}
