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
 * The property that actually matters: the scope-less paths win over the `/auth/{scope}/home`
 * pattern. `signup` must never be read as a scope.
 */
import { describe, it, expect } from 'vitest';
import { screenForPath } from '../../../nebula-studio-ui/src/auth/routes';

describe('auth SPA screen routing', () => {
  it('routes the three scope-less screens', () => {
    expect(screenForPath('/auth/login')).toEqual({ screen: 'login' });
    expect(screenForPath('/auth/signup')).toEqual({ screen: 'signup' });
    expect(screenForPath('/auth/emails')).toEqual({ screen: 'emails' });
  });

  it('routes Home and carries the scope, decoded', () => {
    expect(screenForPath('/auth/acme/home')).toEqual({ screen: 'home', scope: 'acme' });
    // Scopes are dotted, and the segment is URL-encoded on the way in.
    expect(screenForPath('/auth/acme.crm.dev/home')).toEqual({ screen: 'home', scope: 'acme.crm.dev' });
    expect(screenForPath(`/auth/${encodeURIComponent('acme.crm')}/home`))
      .toEqual({ screen: 'home', scope: 'acme.crm' });
  });

  it('a fixed screen is never read as a scope', () => {
    // Reds against reordering the match so the `/auth/{scope}/…` pattern is tried first — which is
    // the class of bug that lives invisibly in a template's branch order.
    expect(screenForPath('/auth/signup').screen).toBe('signup');
    expect(screenForPath('/auth/login').screen).toBe('login');
  });

  it('anything else is unknown rather than a wrong screen', () => {
    // ⚠️ `refresh-token` is the one that matters: it sits one segment from `/auth/{scope}/home`, and
    // a loose match would render HTML where the app expects JSON.
    expect(screenForPath('/auth/acme/refresh-token').screen).toBe('unknown');
    expect(screenForPath('/auth/acme/home/extra').screen).toBe('unknown');
    expect(screenForPath('/auth').screen).toBe('unknown');
    expect(screenForPath('/acme').screen).toBe('unknown');
  });

  it('a trailing slash still routes', () => {
    expect(screenForPath('/auth/login/').screen).toBe('login');
    expect(screenForPath('/auth/acme/home/').screen).toBe('home');
  });
});
