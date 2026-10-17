/**
 * TeamDocDO - Demonstrates @mesh(guard) patterns
 *
 * Named by an id, so it is an unscoped node: it has no scope of its own, so it records the
 * workspace it belongs to when it is created, and an admin is whoever holds dominion over that.
 *
 * From website/docs/mesh/security.mdx:
 * - Method-Level: `@mesh(guard)` with claims and instance state
 * - Reusable Guards
 * - A guard that computes its own decision
 */

import { UnscopedMeshDO, mesh, hasDominionOver, type AuthClaims } from '../../../src/index.js';

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

export class TeamDocDO extends UnscopedMeshDO<Env> {
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

  /** The workspace this document belongs to, recorded by {@link create}. */
  get workspace(): string | undefined {
    return this.ctx.storage.kv.get('workspace');
  }

  /**
   * Create the document in the workspace whose page the caller is on, its token's `aud`. The first
   * call decides, so a later caller cannot move the document to a workspace of their own.
   */
  @mesh()
  create(): void {
    if (this.workspace) return;
    const aud = (this.lmz.callContext.originAuth?.claims as AuthClaims | undefined)?.aud;
    if (!aud) throw new Error('Create the document from a workspace page');
    this.ctx.storage.kv.put('workspace', aud);
  }

  // ============================================
  // A guard that computes its own decision (Computing Access in the Guard section)
  // ============================================

  @mesh((instance: TeamDocDO) => {
    const sub = instance.lmz.callContext.originAuth?.sub;
    if (!sub || !instance.allowedEditors.has(sub)) {
      throw new Error('Editor access required');
    }
  })
  editAsEditor(changes: DocumentChange): { edited: true; byUser: string } {
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

  // Check `callContext.originAuth.claims` to determine access: here, whether the caller holds
  // dominion over the workspace this document belongs to. The `scopeAdmin` bit alone is not
  // enough: anyone who claims a workspace of their own holds it, there.
  @mesh((instance: TeamDocDO) => {
    const claims = instance.lmz.callContext.originAuth?.claims as AuthClaims | undefined;
    const workspace = instance.workspace;
    if (!workspace || !hasDominionOver(claims, workspace)) {
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
