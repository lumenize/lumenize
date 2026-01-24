/**
 * DocumentDO - Collaborative document storage
 *
 * Example of a LumenizeDO from getting-started.mdx and calls.mdx
 */

import { LumenizeDO, mesh } from '../../../src/index.js';
import type { SpellCheckWorker } from './spell-check-worker.js';
import type { EditorClient } from './editor-client.js';

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
    const documentId = this.lmz.instanceNameOrId!;

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
      throw new Error('Admin access required');
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
    const documentId = this.lmz.instanceNameOrId!;
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
