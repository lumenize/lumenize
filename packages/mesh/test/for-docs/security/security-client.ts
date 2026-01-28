/**
 * SecurityClient - Demonstrates onLoginRequired callback
 *
 * From website/docs/mesh/security.mdx - Handling Login Required
 *
 * This is a minimal client that demonstrates the onLoginRequired callback
 * pattern. In a real application, this would trigger a redirect to login.
 */

import { LumenizeClient, mesh, type LoginRequiredError } from '../../../src/index.js';
import type { ProtectedDO } from './protected-do.js';

export class SecurityClient extends LumenizeClient {
  /**
   * Call a protected DO method
   */
  callProtectedDO(instanceId: string): void {
    this.lmz.call(
      'PROTECTED_DO',
      instanceId,
      this.ctn<ProtectedDO>().getData(),
      this.ctn().handleProtectedResponse(this.ctn().$result)
    );
  }

  /**
   * Handle response from protected DO
   */
  @mesh()
  handleProtectedResponse(result: { message: string; userId: string } | Error): void {
    if (result instanceof Error) {
      console.error('Protected call failed:', result.message);
      return;
    }
    console.log('Protected data received:', result.message);
  }
}
