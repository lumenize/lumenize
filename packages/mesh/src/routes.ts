/**
 * The routes a Worker declares for its Clients: which bindings a Client's call may name, and how
 * each is checked before a host node's Gateway sends the call on.
 *
 * A Worker that hosts Clients calls {@link defineRoutes} once, at module scope, beside its `fetch`.
 * Every Durable Object class in the Worker shares that module, so each host node's Gateway reads the
 * one declaration with no code of its own, and `hostedUpgrade` opens a socket on the route marked
 * `hosts` for the scope's tier. Nebula's, in `apps/nebula/src/entrypoint.ts`:
 *
 * ```ts
 * defineRoutes({
 *   UNIVERSE: { tier: 'universe', hosts: true },  // a scoped node; Clients' sockets open here
 *   GALAXY:   { tier: 'galaxy',   hosts: true },
 *   STAR:     { tier: 'star',     hosts: true },
 *   PROFILE:     'unscoped',                     // Mesh's Profile, named by a profileId
 *   AUTH_FACADE: 'worker',                       // Mesh's auth facade, a Worker with no instance
 * });
 * ```
 *
 * A binding left out is unreachable from a Client, whatever it binds: the Registry, an email sender,
 * a binding added later. That is the point (ADR-023: a Client makes neither bridge's hop). With
 * nothing declared, no Client connects at all, since the upgrade finds no `hosts` route.
 *
 * The pure functions here, {@link validateRoutes}, {@link checkRedeclaration},
 * {@link resolveHostBinding} and {@link routeFor}, take a declaration as an argument, so a test can
 * exercise them without registering anything; the registered routes are module-global, and a test's
 * own call would collide with its Worker's.
 */
import type { Tier } from './auth/types';

const TIERS: readonly Tier[] = ['universe', 'galaxy', 'star'];

/** A scoped node's route: the tier or tiers its instance names may parse as, and whether a Client's socket opens on it. */
export interface ScopedRoute {
  tier: Tier | readonly Tier[];
  /** `true` on the one route per tier whose node hosts the Clients of that tier's pages. */
  hosts?: boolean;
}

/**
 * The route kinds a binding of type `V` may take: a Durable Object namespace is a node, a service
 * binding a Worker. A service binding is told by its shape, a `fetch` and a `connect`, since
 * `Fetcher`'s own generics instantiate too deeply to test against.
 */
type RouteFor<V> = V extends DurableObjectNamespace<any> ? ScopedRoute | 'unscoped'
  : V extends { fetch(...args: any[]): any; connect(...args: any[]): any } ? 'worker'
  : never;

/**
 * A declaration, keyed by binding and typed from the Worker's environment, so a misspelled binding,
 * or a route kind on the wrong kind of binding, fails to compile.
 */
export type Routes<E = Cloudflare.Env> = {
  [K in keyof E as [RouteFor<E[K]>] extends [never] ? never : K]?: RouteFor<E[K]>;
};

/** A validated declaration: own keys only, in a `Map`, with each tier's hosting binding. */
export interface ValidatedRoutes {
  readonly routes: ReadonlyMap<string, NormalizedRoute>;
  readonly hostsByTier: ReadonlyMap<Tier, string>;
}

/** A route with its tiers as a sorted list, so two declarations compare by value. */
export type NormalizedRoute =
  | { kind: 'scoped'; tiers: readonly Tier[]; hosts: boolean }
  | { kind: 'unscoped' }
  | { kind: 'worker' };

/** What a Client is told when its call names a binding the Worker declared no route for. */
export function noRouteMessage(binding: string): string {
  return `No route from a Client to "${binding}": a Client reaches only the bindings declared in defineRoutes()`;
}

/** What a Client is told when its frame's `binding` or `instance` is not a string. */
export const FIELD_REFUSAL = "A call frame's binding must be a non-empty string, and its instance, if present, one too";

/** What a Client is told when it names a scope of a tier the route does not serve. */
export function tierMessage(scope: string, tier: Tier, binding: string): string {
  return `"${scope}" is a ${tier} scope, which "${binding}" does not serve`;
}

/** What a Client is told when it names a Client's address on a route that reaches only nodes. */
export function clientAddressMessage(binding: string, instance: string): string {
  return `"${binding}" serves nodes, and "${instance}" is a Client's address`;
}

/** What a Client is told when it names no instance on a route to a node. */
export function noInstanceMessage(binding: string, scoped: boolean): string {
  return scoped
    ? `"${binding}" serves nodes named by a scope; the call names none`
    : `"${binding}" serves nodes named by an id; the call names none`;
}

/** What a Client is told when it names an instance on a route to a Worker. */
export function workerInstanceMessage(binding: string, instance: string): string {
  return `"${binding}" is a Worker, which takes no instance; the call names "${instance}"`;
}

/** What an upgrade is told when no route hosts its scope's tier. */
export function noHostRouteMessage(tier: Tier): string {
  return `No route hosts the "${tier}" tier: declare one with hosts: true in defineRoutes()`;
}

function normalize(binding: string, route: unknown): NormalizedRoute {
  if (route === 'unscoped' || route === 'worker') return { kind: route };
  if (route !== null && typeof route === 'object' && 'tier' in route) {
    const { tier, hosts } = route as ScopedRoute;
    const list = typeof tier === 'string' ? [tier] : Array.isArray(tier) ? [...tier] : [];
    if (list.length === 0 || list.some((t) => !TIERS.includes(t))) {
      throw new Error(`defineRoutes(): "${binding}" names no valid tier; a scoped route names one or more of ${TIERS.join(', ')}`);
    }
    return { kind: 'scoped', tiers: [...new Set(list)].sort(), hosts: hosts === true };
  }
  throw new Error(`defineRoutes(): "${binding}" is not a route; write { tier, hosts? }, 'unscoped' or 'worker'`);
}

/**
 * Check a declaration and index it, registering nothing. Throws when two routes marked `hosts` name
 * one tier, since a socket on that tier's host would then have two places to open.
 */
export function validateRoutes(declaration: object): ValidatedRoutes {
  const routes = new Map<string, NormalizedRoute>();
  const hostsByTier = new Map<Tier, string>();
  for (const binding of Object.keys(declaration)) {
    const route = normalize(binding, (declaration as Record<string, unknown>)[binding]);
    routes.set(binding, route);
    if (route.kind === 'scoped' && route.hosts) {
      for (const tier of route.tiers) {
        const other = hostsByTier.get(tier);
        if (other !== undefined) {
          throw new Error(`defineRoutes(): "${other}" and "${binding}" both host the "${tier}` +
            `" tier; one route per tier takes hosts: true`);
        }
        hostsByTier.set(tier, binding);
      }
    }
  }
  return { routes, hostsByTier };
}

function sameRoute(a: NormalizedRoute, b: NormalizedRoute): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'scoped' || b.kind !== 'scoped') return true;
  return a.hosts === b.hosts && a.tiers.length === b.tiers.length && a.tiers.every((t, i) => t === b.tiers[i]);
}

/**
 * A second declaration must equal the first: anything else throws, so no later call, an import's
 * side effect included, can widen what a Client reaches.
 */
export function checkRedeclaration(previous: ValidatedRoutes, next: ValidatedRoutes): void {
  const same = previous.routes.size === next.routes.size
    && [...previous.routes].every(([binding, route]) => {
      const other = next.routes.get(binding);
      return other !== undefined && sameRoute(route, other);
    });
  if (!same) {
    throw new Error('defineRoutes() was called again with different routes; a Worker declares its routes once');
  }
}

/** A binding's route, looked up by own key only, so `__proto__` or `toString` finds none. */
export function routeFor(routes: ValidatedRoutes | undefined, binding: string): NormalizedRoute | undefined {
  return routes?.routes.get(binding);
}

/** The binding that hosts a tier's Clients, or the refusal naming {@link defineRoutes}. */
export function resolveHostBinding(routes: ValidatedRoutes | undefined, tier: Tier): { binding: string } | { refusal: string } {
  const binding = routes?.hostsByTier.get(tier);
  return binding === undefined ? { refusal: noHostRouteMessage(tier) } : { binding };
}

let registered: ValidatedRoutes | undefined;

/**
 * Declare the routes a Client of this Worker may call. Call it once, at module scope; a second
 * call with equal routes does nothing, and any other throws.
 */
export function defineRoutes<E = Cloudflare.Env>(declaration: Routes<E>): void {
  const next = validateRoutes(declaration);
  if (registered !== undefined) {
    checkRedeclaration(registered, next);
    return;
  }
  registered = next;
}

/** The routes this Worker declared, or `undefined` if it declared none. */
export function registeredRoutes(): ValidatedRoutes | undefined {
  return registered;
}
