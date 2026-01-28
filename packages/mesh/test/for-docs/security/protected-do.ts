/**
 * ProtectedDO - Demonstrates onBeforeCall() authentication pattern
 *
 * From website/docs/mesh/security.mdx - Class-Level: `onBeforeCall()`
 */

import { LumenizeDO, mesh } from '../../../src/index.js';

export class ProtectedDO extends LumenizeDO<Env> {
  onBeforeCall() {
    super.onBeforeCall();

    // Require authentication
    if (!this.lmz.callContext.originAuth?.userId) {
      throw new Error('Authentication required');
    }
  }

  /**
   * A simple method that requires authentication (enforced by onBeforeCall)
   */
  @mesh()
  getData(): { message: string; userId: string } {
    return {
      message: 'Protected data',
      userId: this.lmz.callContext.originAuth!.userId,
    };
  }
}
