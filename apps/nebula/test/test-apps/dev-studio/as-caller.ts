/**
 * Run `fn` under the call context a covering admin's call carries, for the `dev-studio` lane's
 * direct in-DO calls. A landing records its `ServedBuild` under the caller's claims, so a build
 * started with no call context records nothing, and its landing differs from production's.
 *
 * In-DO calls still skip the door (the passage step and the method's guard), as
 * `runInDurableObject` always has; what this restores is the claims the code below the door
 * reads. Mesh's context store is internal, so it is imported by path: the test and the Durable
 * Object share one module instance, so this is the store `this.lmz.callContext` reads.
 */
import { runWithCallContext } from '../../../../../packages/mesh/src/lmz-api-context.workerd';
import type { CallContext } from '@lumenize/mesh';

export function asCaller<T>(instance: string, fn: () => T): T {
  const context: CallContext = {
    callChain: [],
    originAuth: {
      sub: 'admin',
      claims: {
        sub: 'admin', aud: instance, profileId: 'p-admin',
        access: { scopeAdmin: true, authScope: instance.split('.')[0] },
      },
    } as CallContext['originAuth'],
  };
  return runWithCallContext(context, fn);
}
