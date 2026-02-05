/**
 * SecurityClient - Test client for security.mdx examples
 *
 * From website/docs/mesh/security.mdx
 */

import { LumenizeClient, mesh } from '../../../src/index.js';
import type { UserProfileDO } from './user-profile-do.js';

export class SecurityClient extends LumenizeClient {
  /**
   * Call a user profile DO method
   */
  callUserProfile(instanceId: string): void {
    this.lmz.call(
      'USER_PROFILE_DO',
      instanceId,
      this.ctn<UserProfileDO>().getProfile(),
      this.ctn().handleProfileResponse(this.ctn().$result)
    );
  }

  /**
   * Handle response from user profile DO
   */
  @mesh()
  handleProfileResponse(result: { message: string; sub: string } | Error): void {
    if (result instanceof Error) {
      console.error('Profile call failed:', result.message);
      return;
    }
    console.log('Profile data received:', result.message);
  }
}
