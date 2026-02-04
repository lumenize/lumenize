/**
 * TeamDocDO - Demonstrates @mesh(guard) patterns
 *
 * From website/docs/mesh/security.mdx:
 * - Method-Level: `@mesh(guard)` with claims and instance state
 * - Reusable Guards
 * - State-Based Access
 */

import { LumenizeDO, mesh } from '../../../src/index.js';

// ============================================
// Types
// ============================================

export interface DocumentChange {
  content: string;
}

export interface Session {
  userId: string;
  email: string;
}

export interface Permissions {
  canEdit: boolean;
  canDelete: boolean;
}

// ============================================
// Reusable Guards (from security.mdx)
// ============================================

function requireSubscriber(instance: TeamDocDO) {
  const sub = instance.lmz.callContext.originAuth?.sub;
  if (!sub || !instance.subscribers.has(sub)) {
    throw new Error('Subscriber access required');
  }
}

// ============================================
// TeamDocDO
// ============================================

export class TeamDocDO extends LumenizeDO<Env> {
  /**
   * Get allowed editors from storage
   */
  get allowedEditors(): Set<string> {
    return this.ctx.storage.kv.get('allowedEditors') ?? new Set<string>();
  }

  /**
   * Get subscribers from storage
   */
  get subscribers(): Set<string> {
    return this.ctx.storage.kv.get('subscribers') ?? new Set<string>();
  }

  // ============================================
  // onBeforeCall with state population (block 5)
  // ============================================

  onBeforeCall() {
    super.onBeforeCall();
    const callContext = this.lmz.callContext;
    if (!callContext.originAuth?.sub) throw new Error('Auth required');

    // Populate state for use by method guards
    const session = this.loadSession(callContext.originAuth.sub);
    callContext.state.session = session;
    callContext.state.permissions = this.computePermissions(session);
  }

  /**
   * Load session from storage (simplified for testing)
   */
  loadSession(userId: string): Session {
    // In a real app, this would load from storage
    const email = this.ctx.storage.kv.get(`user:${userId}:email`) ?? `${userId}@example.com`;
    return { userId, email: email as string };
  }

  /**
   * Compute permissions based on session
   */
  computePermissions(session: Session): Permissions {
    // Check if user has edit/delete permissions in storage
    const canEdit = this.ctx.storage.kv.get(`user:${session.userId}:canEdit`) === true;
    const canDelete = this.ctx.storage.kv.get(`user:${session.userId}:canDelete`) === true;
    return { canEdit, canDelete };
  }

  // ============================================
  // Setup methods (for testing)
  // ============================================

  @mesh()
  grantEditPermission(userId: string): void {
    this.ctx.storage.kv.put(`user:${userId}:canEdit`, true);
  }

  @mesh()
  grantDeletePermission(userId: string): void {
    this.ctx.storage.kv.put(`user:${userId}:canDelete`, true);
  }

  @mesh()
  addEditor(userId: string): void {
    const editors = this.allowedEditors;
    editors.add(userId);
    this.ctx.storage.kv.put('allowedEditors', editors);
  }

  @mesh()
  addSubscriber(userId: string): void {
    const subs = this.subscribers;
    subs.add(userId);
    this.ctx.storage.kv.put('subscribers', subs);
  }

  // ============================================
  // Guards checking claims (block 3, first example)
  // ============================================

  // Check `callContext.originAuth.claims` to determine access
  @mesh((instance: TeamDocDO) => {
    if (!instance.lmz.callContext.originAuth?.claims?.isAdmin) {
      throw new Error('Admin only');
    }
  })
  adminMethod(): string {
    // Only admins reach here
    return 'admin-only-result';
  }

  // ============================================
  // Guards checking instance state (block 3, second example)
  // ============================================

  // Check instance state to determine access
  @mesh((instance: TeamDocDO) => {
    const userId = instance.lmz.callContext.originAuth?.sub;
    if (!instance.allowedEditors.has(userId!)) {
      throw new Error('Not an allowed editor');
    }
  })
  updateDocument(changes: DocumentChange): { updated: true; content: string } {
    // Only allowed editors reach here
    this.ctx.storage.kv.put('content', changes.content);
    return { updated: true, content: changes.content };
  }

  // ============================================
  // Reusable guards (block 4)
  // Keep editDocument and addComment contiguous — check-examples
  // does substring matching, so they must be adjacent.
  // ============================================

  @mesh(requireSubscriber)
  editDocument(changes: DocumentChange): { edited: true; content: string } {
    this.ctx.storage.kv.put('content', changes.content);
    return { edited: true, content: changes.content };
  }

  @mesh(requireSubscriber)
  addComment(comment: string): { commented: true } {
    const comments: string[] = this.ctx.storage.kv.get('comments') ?? [];
    comments.push(comment);
    this.ctx.storage.kv.put('comments', comments);
    return { commented: true };
  }

  // ============================================
  // State-based access (block 5)
  // ============================================

  @mesh((instance: TeamDocDO) => {
    const permissions = instance.lmz.callContext.state.permissions as Permissions | undefined;
    if (!permissions?.canEdit) {
      throw new Error('Edit permission required');
    }
  })
  editWithStateCheck(changes: DocumentChange): { edited: true; byUser: string } {
    const session = this.lmz.callContext.state.session as Session;
    this.ctx.storage.kv.put('content', changes.content);
    return { edited: true, byUser: session.userId };
  }

  // ============================================
  // Helper methods
  // ============================================

  @mesh()
  getContent(): string {
    return this.ctx.storage.kv.get('content') ?? '';
  }
}
