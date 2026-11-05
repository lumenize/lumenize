/**
 * The checks a Worker's route declaration passes before any Client is routed by it: two `hosts`
 * routes for one tier, a lookup by own key only, a second declaration that must equal the first, and
 * the upgrade's resolver for a tier no route hosts.
 *
 * In the vitest-plugin lane with no running system because every function here is pure: each takes a
 * declaration as an argument and registers nothing. The one test of `defineRoutes` itself registers
 * in the module instance the Worker's entry also uses, and starts from nothing only because this file
 * never imports `cloudflare:test`, whose import runs that entry and its declaration (measured
 * 2026-10-09). The resolver is reachable only here, since every test Worker declares a `hosts` route
 * for all three tiers.
 */
import { describe, it, expect } from 'vitest';
import {
  defineRoutes,
  registeredRoutes,
  validateRoutes,
  checkRedeclaration,
  routeFor,
  resolveHostBinding,
  noRouteMessage,
} from '../src/routes';

const NEBULA_SHAPE = {
  UNIVERSE: { tier: 'universe', hosts: true },
  GALAXY: { tier: 'galaxy', hosts: true },
  STAR: { tier: 'star', hosts: true },
  PROFILE: 'unscoped',
  AUTH_FACADE: 'worker',
} as const;

describe('validateRoutes', () => {
  it('refuses two hosts routes for one tier, naming both bindings', () => {
    expect(() => validateRoutes({
      STAR: { tier: 'star', hosts: true },
      STAR_TOO: { tier: ['galaxy', 'star'], hosts: true },
    })).toThrow('defineRoutes(): "STAR" and "STAR_TOO" both host the "star" tier; one route per tier takes hosts: true');
  });

  it('lets a non-hosting route share a tier with the hosting one', () => {
    const routes = validateRoutes({ STAR: { tier: 'star', hosts: true }, STAR_SEARCH: { tier: 'star' } });
    expect(routes.hostsByTier.get('star')).toBe('STAR');
    expect(routeFor(routes, 'STAR_SEARCH')).toEqual({ kind: 'scoped', tiers: ['star'], hosts: false });
  });

  it('refuses a route naming no valid tier, and a value that is no route', () => {
    expect(() => validateRoutes({ X: { tier: 'planet' } })).toThrow('"X" names no valid tier');
    expect(() => validateRoutes({ X: 'scoped' })).toThrow('"X" is not a route');
  });
});

describe('routeFor', () => {
  it('finds a route by own key only, so an inherited name finds none', () => {
    const routes = validateRoutes(NEBULA_SHAPE);
    expect(routeFor(routes, 'PROFILE')).toEqual({ kind: 'unscoped' });
    for (const inherited of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(routeFor(routes, inherited)).toBeUndefined();
    }
    expect(routeFor(routes, 'AUTH_REGISTRY')).toBeUndefined();
    expect(routeFor(undefined, 'STAR')).toBeUndefined();
  });

  it('says where routes come from when a binding has none', () => {
    expect(noRouteMessage('AUTH_REGISTRY')).toBe(
      'No route from a Client to "AUTH_REGISTRY": a Client reaches only the bindings declared in defineRoutes()');
  });
});

describe('checkRedeclaration', () => {
  it('accepts an equal declaration, whatever its key order or tier order', () => {
    const first = validateRoutes(NEBULA_SHAPE);
    const again = validateRoutes({
      AUTH_FACADE: 'worker', PROFILE: 'unscoped',
      STAR: { tier: ['star'], hosts: true }, GALAXY: { tier: 'galaxy', hosts: true }, UNIVERSE: { tier: 'universe', hosts: true },
    });
    expect(() => checkRedeclaration(first, again)).not.toThrow();
  });

  it('refuses a superset, so no later call widens what a Client reaches', () => {
    const first = validateRoutes(NEBULA_SHAPE);
    const wider = validateRoutes({ ...NEBULA_SHAPE, AUTH_REGISTRY: 'unscoped' });
    expect(() => checkRedeclaration(first, wider)).toThrow(
      'defineRoutes() was called again with different routes; an app declares its routes once');
  });

  it('refuses a changed value', () => {
    const first = validateRoutes(NEBULA_SHAPE);
    const changed = validateRoutes({ ...NEBULA_SHAPE, STAR: { tier: 'star' } });
    expect(() => checkRedeclaration(first, changed)).toThrow('was called again with different routes');
  });
});

describe('defineRoutes', () => {
  // MUTATION: replace the redeclaration check with `registered = next`, and the wider declaration lands.
  it('registers once, ignores an equal second call, and refuses a different one, keeping the first', () => {
    expect(registeredRoutes()).toBeUndefined();
    defineRoutes(NEBULA_SHAPE as never);
    const declared = registeredRoutes();
    expect(declared?.routes.get('PROFILE')).toEqual({ kind: 'unscoped' });
    defineRoutes(NEBULA_SHAPE as never);
    expect(registeredRoutes()).toBe(declared);
    expect(() => defineRoutes({ ...NEBULA_SHAPE, AUTH_REGISTRY: 'unscoped' } as never)).toThrow(
      'defineRoutes() was called again with different routes; an app declares its routes once');
    expect(registeredRoutes()).toBe(declared);
  });
});

describe('resolveHostBinding', () => {
  it('answers the binding hosting a tier, and refuses a tier no route hosts, naming defineRoutes()', () => {
    const routes = validateRoutes({ STAR: { tier: 'star', hosts: true }, GALAXY: { tier: 'galaxy' } });
    expect(resolveHostBinding(routes, 'star')).toEqual({ binding: 'STAR' });
    expect(resolveHostBinding(routes, 'galaxy')).toEqual({
      refusal: 'No route hosts the "galaxy" tier: declare one with hosts: true in defineRoutes()',
    });
    expect(resolveHostBinding(undefined, 'universe')).toEqual({
      refusal: 'No route hosts the "universe" tier: declare one with hosts: true in defineRoutes()',
    });
  });
});

/** Compiled, never called: `npm run type-check` holds these, and an unused directive fails it. */
export function typedDeclarationsRefuseWrongBindings(): void {
  // @ts-expect-error A misspelled binding is no key of this Worker's environment.
  defineRoutes({ PROFLE: 'unscoped' });
  // @ts-expect-error `PROFILE` is a Durable Object namespace, so it cannot be a Worker route.
  defineRoutes({ PROFILE: 'worker' });
  // @ts-expect-error `AUTH_FACADE` is a service binding, so it cannot be a node's route.
  defineRoutes({ AUTH_FACADE: 'unscoped' });
}
