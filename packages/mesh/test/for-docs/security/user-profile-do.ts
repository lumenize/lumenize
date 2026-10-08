/**
 * UserProfileDO - Demonstrates onBeforeCall() ownership + admin pattern
 *
 * Named by its user's `sub`, a UUID, so it is an unscoped node that checks its own callers.
 *
 * From website/docs/mesh/security.mdx - Class-Level: `onBeforeCall()`
 */

import { UnscopedMeshDO, mesh, type AuthClaims } from '../../../src/index.js';

export class UserProfileDO extends UnscopedMeshDO<Env> {
  onBeforeCall() {
    super.onBeforeCall();

    const { originAuth } = this.lmz.callContext;
    const isOwner = originAuth?.sub === this.lmz.instanceName;
    // An admin of the workspace the caller signed in to
    const isAdmin = (originAuth?.claims as AuthClaims | undefined)?.access?.scopeAdmin;

    if (!isOwner && !isAdmin) {
      throw new Error('Access denied');
    }
  }

  /**
   * Get the user's profile data (only owner or admin can access)
   */
  @mesh()
  getProfile(): { sub: string; message: string } {
    return {
      sub: this.lmz.callContext.originAuth!.sub,
      message: 'Profile data',
    };
  }
}
