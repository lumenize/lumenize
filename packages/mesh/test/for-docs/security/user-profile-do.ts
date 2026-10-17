/**
 * UserProfileDO - Demonstrates the onBeforeCall() ownership pattern
 *
 * Named by its user's `sub`, a UUID, so it is an unscoped node that checks its own callers. It
 * belongs to a person, not to a workspace, so there is no scope an admin could hold dominion over:
 * only its owner gets in. `TeamDocDO` shows an unscoped node with an admin.
 *
 * From website/docs/mesh/security.mdx - Class-Level: `onBeforeCall()`
 */

import { UnscopedMeshDO, mesh } from '../../../src/index.js';

export class UserProfileDO extends UnscopedMeshDO<Env> {
  onBeforeCall() {
    super.onBeforeCall();

    const { originAuth } = this.lmz.callContext;
    if (originAuth?.sub !== this.lmz.instanceName) {
      throw new Error('Access denied');
    }
  }

  /**
   * Get the user's profile data (only its owner can access)
   */
  @mesh()
  getProfile(): { sub: string; message: string } {
    return {
      sub: this.lmz.callContext.originAuth!.sub,
      message: 'Profile data',
    };
  }
}
