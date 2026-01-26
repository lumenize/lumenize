/**
 * DocumentDO - Collaborative document storage
 *
 * Example of a LumenizeDO from getting-started.mdx and calls.mdx
 */

import { LumenizeDO, mesh } from '../../../src/index.js';
import type { SpellCheckWorker } from './spell-check-worker.js';
import type { EditorClient } from './editor-client.js';
import type { AnalyticsWorker, AnalyticsResult } from './analytics-worker.js';

/**
 * Custom error for admin access failures
 *
 * Demonstrates custom Error class preservation across the mesh.
 * The `name` property must match the class name for globalThis lookup.
 */
export class AdminAccessError extends Error {
  name = 'AdminAccessError';
  constructor(
    message: string,
    public userId: string | undefined
  ) {
    super(message);
  }
}

// Register on globalThis so deserializer can reconstruct the type
(globalThis as any).AdminAccessError = AdminAccessError;

/**
 * AdminInterface - Capability-based admin access
 *
 * Demonstrates the Capability Trust pattern from calls.mdx:
 * - admin() checks permissions and returns this interface
 * - Once granted, methods on this interface are trusted
 * - All chained operations execute in a single round trip
 */
export class AdminInterface {
  #do: DocumentDO;

  constructor(documentDO: DocumentDO) {
    this.#do = documentDO;
  }

  /**
   * Force reset the document - clears content and subscribers
   * Only accessible via admin().forceReset() chain
   */
  @mesh
  forceReset(): { reset: true; previousContent: string } {
    const previousContent = this.#do.getContent();
    this.#do.clearAll();
    return { reset: true, previousContent };
  }

  /**
   * Get document stats - admin-only view
   */
  @mesh
  getStats(): { subscriberCount: number; contentLength: number } {
    return {
      subscriberCount: this.#do.getSubscriberCount(),
      contentLength: this.#do.getContent().length,
    };
  }
}

export class DocumentDO extends LumenizeDO<Env> {
  // Require authentication for all mesh calls
  onBeforeCall(): void {
    super.onBeforeCall();
    if (!this.lmz.callContext.originAuth?.userId) {
      throw new Error('Authentication required');
    }
  }

  @mesh
  update(content: string) {
    this.ctx.storage.kv.put('content', content);

    // Notify all subscribers with new content
    this.#broadcastContent(content);

    // Trigger spell check - worker sends results directly to originator
    const { callChain } = this.lmz.callContext;
    const clientId = callChain.at(-1)?.instanceName;
    const documentId = this.lmz.instanceName!;

    if (clientId) {
      this.lmz.call(
        'SPELLCHECK_WORKER',
        undefined,
        this.ctn<SpellCheckWorker>().check(content, clientId, documentId)
      );
    }
  }

  @mesh
  subscribe(): string {
    const { callChain } = this.lmz.callContext;
    const clientId = callChain.at(-1)?.instanceName;
    if (clientId) {
      const subscribers: Set<string> = this.ctx.storage.kv.get('subscribers') ?? new Set();
      subscribers.add(clientId);
      this.ctx.storage.kv.put('subscribers', subscribers);
    }
    return this.ctx.storage.kv.get('content') ?? '';
  }

  // unsubscribe() left as exercise for reader

  /**
   * Request analytics computation - two one-way calls pattern
   *
   * Demonstrates DO→Worker→DO to avoid wall-clock billing:
   * 1. DO fires-and-forgets to Worker (returns immediately)
   * 2. Worker computes analytics (CPU-only billing)
   * 3. Worker fires-and-forgets back to handleAnalyticsResult
   */
  @mesh
  requestAnalytics(): void {
    const content = this.ctx.storage.kv.get('content') ?? '';
    const documentId = this.lmz.instanceName!;

    // Fire-and-forget to Worker - DO returns immediately, no wall-clock charges
    this.lmz.call(
      'ANALYTICS_WORKER',
      undefined,
      this.ctn<AnalyticsWorker>().computeAnalytics(content, documentId)
    );
    // DO returns immediately — no wall-clock charges while waiting
  }

  /**
   * Handle analytics result from Worker
   *
   * Called by AnalyticsWorker after computation completes.
   * This is the second leg of the two one-way calls pattern.
   */
  @mesh
  handleAnalyticsResult(result: AnalyticsResult): void {
    this.ctx.storage.kv.put('analytics', result);
  }

  // For testing - retrieve stored analytics
  @mesh
  getAnalytics(): AnalyticsResult | undefined {
    return this.ctx.storage.kv.get('analytics');
  }

  /**
   * Get admin interface - capability-based access control
   *
   * Only admins can get the admin interface; once granted, its methods are trusted.
   * Demonstrates operation chaining: admin().forceReset() executes in a single round trip.
   */
  @mesh
  admin(): AdminInterface {
    // Check if caller has admin role (simplified - in production, check JWT claims or database)
    const userId = this.lmz.callContext.originAuth?.userId;
    const isAdmin = this.ctx.storage.kv.get(`admin:${userId}`) === true;
    if (!isAdmin) {
      throw new AdminAccessError('Admin access required', userId);
    }
    return new AdminInterface(this);
  }

  /**
   * Grant admin access to a user (for testing)
   */
  @mesh
  grantAdmin(userId: string): void {
    this.ctx.storage.kv.put(`admin:${userId}`, true);
  }

  // Helper methods for AdminInterface
  getContent(): string {
    return this.ctx.storage.kv.get('content') ?? '';
  }

  getSubscriberCount(): number {
    const subscribers: Set<string> = this.ctx.storage.kv.get('subscribers') ?? new Set();
    return subscribers.size;
  }

  clearAll(): void {
    this.ctx.storage.kv.put('content', '');
    this.ctx.storage.kv.put('subscribers', new Set());
  }

  #broadcastContent(content: string) {
    const documentId = this.lmz.instanceName!;
    const subscribers: Set<string> = this.ctx.storage.kv.get('subscribers') ?? new Set();
    // Note: In production, you'd skip the originator to avoid redundant updates
    for (const clientId of subscribers) {
      const remote = this.ctn<EditorClient>().handleContentUpdate(documentId, content);
      // Start new chain - this is a server-initiated push, not a response to client
      this.lmz.call(
        'LUMENIZE_CLIENT_GATEWAY',
        clientId,
        remote,
        undefined,
        { newChain: true }
      );
    }
  }
}
