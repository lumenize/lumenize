/**
 * Run `fn` under the call context a covering admin's Client call carries, for the `dev-studio`
 * lane's direct in-DO calls. A loop tool runs under the claims recorded on a post, and a probe
 * here writes that post itself, through the Resources plane, which records the claims of the
 * call it runs in and takes a write only from a Client's call. With no call context there is
 * neither, so the probe's own call stands in as that Client's.
 *
 * In-DO calls still skip the door (the passage step and the method's guard), as
 * `runInDurableObject` always has; what this restores is the claims the code below the door
 * reads. Mesh's context store is internal, so it is imported by path: the test and the Durable
 * Object share one module instance, so this is the store `this.lmz.callContext` reads.
 */
import { runWithCallContext } from '../../../../../packages/mesh/src/lmz-api-context.workerd';
import type { CallContext } from '@lumenize/mesh';

/** The admin every probe call here runs as. Ids shaped like a person's, as `lmz.actFor` requires. */
const ADMIN_SUB = '0ad31000-0000-4000-8000-000000000001';
const ADMIN_PROFILE = '0ad31000-0000-4000-8000-000000000002';

export function asCaller<T>(instance: string, fn: () => T, node?: { lmz: { __init(options: { instanceName: string }): void } }): T {
  // A node learns its name from its first call. The dominion bypass is confined to that name, so
  // an unnamed node would refuse this admin the chat floor.
  node?.lmz.__init({ instanceName: instance });
  const context: CallContext = {
    callChain: [{ type: 'LumenizeClient', bindingName: 'GALAXY', instanceName: `${instance}/${ADMIN_SUB}.probe` }],
    originAuth: {
      sub: ADMIN_SUB,
      claims: {
        sub: ADMIN_SUB, aud: instance, profileId: ADMIN_PROFILE,
        access: { scopeAdmin: true, authScope: instance.split('.')[0] },
      },
    } as CallContext['originAuth'],
  };
  return runWithCallContext(context, fn);
}
