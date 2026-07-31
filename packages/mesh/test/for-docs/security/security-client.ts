/**
 * SecurityClient - Test client for security.mdx examples
 *
 * From website/docs/mesh/security.mdx
 */

import { LumenizeClient, mesh } from '../../../src/index.js';
import type { UserProfileDO } from './user-profile-do.js';
import type { TeamDocDO } from './team-doc-do.js';

/** Every shape a guarded `TeamDocDO` method can deliver back to the client. */
export type TeamDocResult =
  | { edited: true; content: string }
  | { edited: true; byUser: string }
  | { updated: true; content: string }
  | { commented: true }
  | string;

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

  /**
   * Call an admin-only method, guarded on `originAuth.claims.isAdmin`.
   */
  callAdminMethod(instanceId: string): void {
    this.lmz.call(
      'TEAM_DOC_DO',
      instanceId,
      this.ctn<TeamDocDO>().adminMethod(),
      this.ctn().handleAdminResponse(this.ctn().$result)
    );
  }

  /**
   * Handle response from the admin-only method
   */
  @mesh()
  handleAdminResponse(result: string | Error): void {
    if (result instanceof Error) {
      console.error('Admin call failed:', result.message);
      return;
    }
    console.log('Admin result received:', result);
  }

  // ============================================
  // TeamDocDO initiators
  //
  // Every guarded TeamDocDO method needs one of these: a guard only runs on the
  // mesh ENTRY check, so a call made with `createTestingClient` executes the
  // method body with the guard switched off. Reaching them from a real client
  // is the only way the guards themselves are exercised.
  // ============================================

  /** `updateDocument` — guarded on `instance.allowedEditors`. */
  callUpdateDocument(instanceId: string, content: string): void {
    this.lmz.call(
      'TEAM_DOC_DO',
      instanceId,
      this.ctn<TeamDocDO>().updateDocument({ content }),
      this.ctn().handleTeamDocResponse(this.ctn().$result)
    );
  }

  /** `editDocument` — guarded on the reusable `requireSubscriber`. */
  callEditDocument(instanceId: string, content: string): void {
    this.lmz.call(
      'TEAM_DOC_DO',
      instanceId,
      this.ctn<TeamDocDO>().editDocument({ content }),
      this.ctn().handleTeamDocResponse(this.ctn().$result)
    );
  }

  /** `addComment` — the second method behind the same `requireSubscriber`. */
  callAddComment(instanceId: string, comment: string): void {
    this.lmz.call(
      'TEAM_DOC_DO',
      instanceId,
      this.ctn<TeamDocDO>().addComment(comment),
      this.ctn().handleTeamDocResponse(this.ctn().$result)
    );
  }

  /** `editWithStateCheck` — guarded on `callContext.state.isEditor`. */
  callEditWithStateCheck(instanceId: string, content: string): void {
    this.lmz.call(
      'TEAM_DOC_DO',
      instanceId,
      this.ctn<TeamDocDO>().editWithStateCheck({ content }),
      this.ctn().handleTeamDocResponse(this.ctn().$result)
    );
  }

  /** `getContent` — unguarded read, used to prove a guarded write landed. */
  callGetContent(instanceId: string): void {
    this.lmz.call(
      'TEAM_DOC_DO',
      instanceId,
      this.ctn<TeamDocDO>().getContent(),
      this.ctn().handleTeamDocResponse(this.ctn().$result)
    );
  }

  /**
   * Handle a response from any TeamDocDO method. A refused guard arrives here
   * as the Error it threw, not as a rejected promise — mesh calls are one-way.
   */
  @mesh()
  handleTeamDocResponse(result: TeamDocResult | Error): void {
    if (result instanceof Error) {
      console.error('Team doc call failed:', result.message);
      return;
    }
    console.log('Team doc result received:', result);
  }
}
