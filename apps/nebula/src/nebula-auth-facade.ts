/**
 * The Nebula Worker's `NebulaAuthFacade` — nebula-auth's facade with the scope lifecycle hooks that
 * only this Worker can supply. Same class name as the base, so the `NEBULA_AUTH_FACADE` binding's
 * `entrypoint` is unchanged. It sets `hooks` and nothing else: every check lives in the base.
 */
import { NebulaAuthFacade as NebulaAuthFacadeBase } from '@lumenize/nebula-auth/facade';
import { scopeLifecycleHooks } from './scope-lifecycle-hooks';

export class NebulaAuthFacade extends NebulaAuthFacadeBase {
  protected readonly hooks = scopeLifecycleHooks;
}
