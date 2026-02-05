/**
 * UserProfileDO - Demonstrates onBeforeCall() ownership + admin pattern
 *
 * From website/docs/mesh/security.mdx - Class-Level: `onBeforeCall()`
 */

import { LumenizeDO, mesh } from '../../../src/index.js';

export class UserProfileDO extends LumenizeDO<Env> {
  onBeforeCall() {
    super.onBeforeCall();

    const { originAuth } = this.lmz.callContext;
    const isOwner = originAuth?.sub === this.lmz.instanceName;
    const isAdmin = originAuth?.claims?.isAdmin;

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
