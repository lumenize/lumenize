/**
 * Which auth screen a path renders.
 *
 * ⚠️ **This test exists because the alternative was a `v-if` chain.** Deciding the screen by the
 * order of `v-if` / `v-else-if` branches in the shell would put the precedence in template syntax,
 * where no mutation can flip it and no test can see it — the failure shape `calibration.md`
 * § *You will put a decision in a framework's syntax* was written for, after a chat status froze
 * forever because a transient branch sat ahead of a terminal one. `screenForPath` is a named
 * function precisely so this file can exist.
 *
 * Every screen is a page on the platform host, and no path carries a scope: Home is the root, the
 * rest sit under `/auth/`. The property that matters is the fall-through — a route the Worker
 * answers with JSON, such as the refresh or a link's lookup, must never render a screen.
 */
import { describe, it, expect } from 'vitest';
import { screenForPath } from '../../../nebula-studio-ui/src/auth/routes';

describe('auth SPA screen routing', () => {
  it('routes Home at the root and every screen under /auth/', () => {
    expect(screenForPath('/')).toEqual({ screen: 'home' });
    expect(screenForPath('/auth/login')).toEqual({ screen: 'login' });
    expect(screenForPath('/auth/signup')).toEqual({ screen: 'signup' });
    expect(screenForPath('/auth/emails')).toEqual({ screen: 'emails' });
    expect(screenForPath('/auth/magic-link')).toEqual({ screen: 'magic-link' });
    expect(screenForPath('/auth/logout')).toEqual({ screen: 'logout' });
  });

  it('anything else is unknown rather than a wrong screen', () => {
    // ⚠️ The JSON routes are the ones that matter: each sits beside a screen's path, and a loose
    // match would render HTML where a page expects JSON.
    expect(screenForPath('/auth/refresh-token').screen).toBe('unknown');
    expect(screenForPath('/auth/magic-link/lookup').screen).toBe('unknown');
    expect(screenForPath('/auth/home-summary').screen).toBe('unknown');
    // The retired scope-path shape names nothing now.
    expect(screenForPath('/auth/acme/home').screen).toBe('unknown');
    expect(screenForPath('/auth').screen).toBe('unknown');
    expect(screenForPath('/acme').screen).toBe('unknown');
  });

  it('a trailing slash still routes', () => {
    expect(screenForPath('/auth/login/').screen).toBe('login');
    expect(screenForPath('/auth/magic-link/').screen).toBe('magic-link');
  });
});
