/**
 * NebulaDO — Base class for all Nebula Durable Objects
 *
 * Provides universeGalaxyStarId binding via onBeforeCall() and
 * shared guard functions for @mesh(guard) decorators.
 */

import { LumenizeDO } from '@lumenize/mesh';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

/**
 * Guard: require admin access in the caller's JWT claims.
 * Used with @mesh(requireAdmin) on subclass methods.
 */
export function requireAdmin(instance: NebulaDO) {
  const claims = instance.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined;
  if (!claims?.access?.admin) {
    throw new Error('Admin access required');
  }
}

/**
 * NebulaDO — base class for Universe, Galaxy, Star, and ResourceHistory.
 *
 * onBeforeCall() permanently locks each DO instance to the active scope
 * (universe, galaxy, or star) that first accessed it by storing the JWT's
 * `aud` claim. Subsequent calls with a different `aud` are rejected.
 */
export class NebulaDO extends LumenizeDO {
  onBeforeCall() {
    const claims = this.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined;
    const universeGalaxyStarId = claims?.aud;

    // Reject calls that didn't come through NebulaClientGateway
    if (!universeGalaxyStarId) {
      throw new Error('Missing active scope (aud) in callContext');
    }

    // Store on first call, throw on mismatch
    const stored = this.ctx.storage.kv.get<string>('__nebula_universeGalaxyStarId');
    if (!stored) {
      this.ctx.storage.kv.put('__nebula_universeGalaxyStarId', universeGalaxyStarId);
    } else if (stored !== universeGalaxyStarId) {
      throw new Error('Active-scope mismatch');
    }
  }
}
