/**
 * What a Mesh test Worker composes so its Clients log in through Mesh's own auth layer and reach a
 * host node the way a page's Client does: the Registry, the Profile, a facade, the scope lifecycle
 * hooks, and a `fetch` that answers `/auth/*` and a Client's upgrade at `/gateway/{id}` on a scope's
 * host.
 *
 * A Worker exports the classes for its wrangler bindings and builds its `fetch` with
 * {@link meshTestFetch}, naming the binding each tier of scope lives under:
 *
 * ```ts
 * const TIERS = { universe: 'CLIENT_HOST_DO', galaxy: 'CLIENT_HOST_DO', star: 'CLIENT_HOST_DO' } as const;
 * export default { fetch: meshTestFetch(TIERS) };
 * ```
 *
 * The suites run with `AUTH_TEST_MODE` in their vitest bindings, so the Registry hands each magic link
 * back instead of mailing it (ADR-009 rung 2), and `test/support/login.ts` follows it.
 */
import { debug } from '@lumenize/debug';
import { routeAuthRequest } from '../../src/auth/router';
import { hostedUpgrade, type TierBindings } from '../../src/auth/hosted-upgrade';
import { AuthFacade } from '../../src/auth/auth-facade';
import { deploymentOrigin, parseHost } from '../../src/auth/hosts';
import { rawRpcStub, type RawRpcSurface } from '../../src/raw-rpc';
import type { ScopedMeshDO } from '../../src/scoped-mesh-do';
import type { ScopeLifecycleHooks } from '../../src/auth/types';

export { AuthRegistry } from '../../src/auth/auth-registry';
export { Profile } from '../../src/auth/profile';

/**
 * Whether a teardown's rejection is the reset it ordered: `ScopedMeshDO.teardown` ends in
 * `ctx.abort('scope-deleted')`, which rejects the call that asked for it.
 */
function isOrderedReset(err: unknown): boolean {
  return err instanceof Error && err.message === 'scope-deleted'
    && (err as { durableObjectReset?: unknown }).durableObjectReset === true;
}

/**
 * The hooks a test Worker's router and facade call: each target scope's node is torn down through
 * `@rawRpc()`, at the binding its tier lives under. No test node orders a certificate.
 */
export function scopeLifecycleHooks(tiers: TierBindings): ScopeLifecycleHooks {
  return {
    async teardown(targets, cause, operationId) {
      await Promise.all(targets.map(async ({ instanceName, tier }) => {
        try {
          // Every tier binding names a scoped node; the Worker's own binding union does not say so.
          const node = rawRpcStub(tiers[tier] as Parameters<typeof rawRpcStub>[0], instanceName) as unknown as RawRpcSurface<ScopedMeshDO>;
          await node.teardown(cause, operationId);
        } catch (err) {
          if (isOrderedReset(err)) return;
          debug('test.scope.teardown').error('teardown failed', {
            instanceName, tier, cause, message: (err as Error)?.message,
          });
        }
      }));
    },
    async orderCertificate() {},
  };
}

/** A facade whose hooks tear down the test Worker's own host nodes. */
export function authFacadeFor(tiers: TierBindings): typeof AuthFacade {
  const hooks = scopeLifecycleHooks(tiers);
  // A concrete subclass per Worker; `hooks` is abstract on the base.
  return class TestAuthFacade extends AuthFacade {
    protected readonly hooks = hooks;
  } as unknown as typeof AuthFacade;
}

/**
 * The Worker's `fetch`: a Client's upgrade on a scope's host goes to the node that host spells, at
 * the binding `tiers` names for its tier; every `/auth/*` route goes to Mesh's router; anything else
 * is `fallthrough`'s, or a 404.
 */
export function meshTestFetch(
  tiers: TierBindings,
  fallthrough?: (request: Request, env: Env) => Promise<Response | undefined> | Response | undefined,
): (request: Request, env: Env) => Promise<Response> {
  const hooks = scopeLifecycleHooks(tiers);
  return async (request, env) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/gateway/')) {
      const target = parseHost(url.host, deploymentOrigin(env));
      if (target?.kind === 'scope' || target?.kind === 'persona') {
        return hostedUpgrade(request, target.scope, tiers, env);
      }
      return new Response('Not Found', { status: 404 });
    }
    return (await routeAuthRequest(request, env, { hooks }))
      ?? (await fallthrough?.(request, env))
      ?? new Response('Not Found', { status: 404 });
  };
}
