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
  // onBeforeCall with state population (Call Context State section)
  // ============================================

  onBeforeCall() {
    super.onBeforeCall();
    // Compute once, use in multiple guards
    const sub = this.lmz.callContext.originAuth!.sub;
    this.lmz.callContext.state.isEditor = this.allowedEditors.has(sub);
  }

  @mesh((instance: TeamDocDO) => {
    if (!instance.lmz.callContext.state.isEditor) {
      throw new Error('Editor access required');
    }
  })
  editWithStateCheck(changes: DocumentChange): { edited: true; byUser: string } {
    const sub = this.lmz.callContext.originAuth!.sub;
    this.ctx.storage.kv.put('content', changes.content);
    return { edited: true, byUser: sub };
  }

  // ============================================
  // Setup methods (for testing)
  // ============================================

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
  // Helper methods
  // ============================================

  @mesh()
  getContent(): string {
    return this.ctx.storage.kv.get('content') ?? '';
  }
}
