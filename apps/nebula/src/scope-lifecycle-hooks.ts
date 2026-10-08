/**
 * The scope lifecycle hooks nebula-auth calls when a scope is deleted or created — `NebulaAuthFacade`
 * on a deletion or `createGalaxy`, and the auth router when a claim is accepted — the one module
 * that holds every `rawRpcStub` call `apps/nebula` makes (ADR-023's `@rawRpc()` bridge): a wipe
 * through `teardown()`, and a galaxy's certificate wake through `orderCertificate()`.
 *
 * nebula-auth decides WHICH scopes a deletion or a creation touches, and cannot name a Galaxy or a
 * Star (dependency direction), so it hands the targets here and this module wipes each one's Durable
 * Object through `NebulaDO.teardown()`. Neither is a mesh method: `@mesh()` would let any admin wipe
 * a live app without deleting it.
 */
import { debug } from '@lumenize/debug';
import { rawRpcStub } from '@lumenize/mesh/raw-rpc';
import type { ScopeLifecycleHooks, ScopeTarget } from '@lumenize/mesh/auth';

/** The Durable Object binding each tier's scope lives at. */
const BINDING: Record<ScopeTarget['tier'], 'UNIVERSE' | 'GALAXY' | 'STAR'> = {
  universe: 'UNIVERSE', galaxy: 'GALAXY', star: 'STAR',
};

/**
 * Whether a teardown's rejection is the reset it ordered rather than a failure. `teardown()` ends in
 * `ctx.abort('scope-deleted')`, which rejects the in-flight call; the caller receives an Error whose
 * message is the abort's reason and whose `durableObjectReset` is `true`. Measured under
 * `wrangler dev` (recorded in this module's task file's build notes); any other rejection is a
 * teardown that did not finish.
 */
function isOrderedReset(err: unknown): boolean {
  return err instanceof Error && err.message === 'scope-deleted'
    && (err as { durableObjectReset?: unknown }).durableObjectReset === true;
}

export const scopeLifecycleHooks: ScopeLifecycleHooks = {
  async teardown(targets, cause, operationId) {
    const log = debug('nebula.scope.teardown');
    // Each target on its own: one that fails is logged, naming it, and the rest still run.
    await Promise.all(targets.map(async ({ instanceName, tier }) => {
      try {
        await rawRpcStub(BINDING[tier], instanceName).teardown(cause, operationId);
        log.debug('torn down', { instanceName, tier, cause, operationId });
      } catch (err) {
        const shape = {
          name: (err as Error)?.name, message: (err as Error)?.message,
          durableObjectReset: (err as { durableObjectReset?: unknown })?.durableObjectReset,
        };
        if (isOrderedReset(err)) {
          log.debug('reset as ordered', { instanceName, tier, cause, operationId, ...shape });
          return;
        }
        log.error('teardown failed', { instanceName, tier, cause, operationId, ...shape });
      }
    }));
  },

  // The Galaxy records the wake and orders from its own alarm, so this only reaches it; a failure
  // is logged naming the galaxy, and the next wake, or an already-accepted acceptance, retries it.
  async orderCertificate(galaxy, operationId) {
    try {
      await rawRpcStub('GALAXY', galaxy).orderCertificate(operationId);
    } catch (err) {
      debug('nebula.scope.certificate').error('certificate wake failed', {
        galaxy, operationId, name: (err as Error)?.name, message: (err as Error)?.message,
      });
    }
  },
};
