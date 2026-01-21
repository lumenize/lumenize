/**
 * DocumentDO - Collaborative document storage
 *
 * Example of a LumenizeDO from getting-started.mdx
 */

import { LumenizeDO, mesh } from '../../../src/index.js';
import type { SpellCheckWorker, SpellFinding } from './spell-check-worker.js';
import type { EditorClient } from './editor-client.js';

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

    // Trigger spell check (fire-and-forget with callback)
    const remote = this.ctn<SpellCheckWorker>().check(content);
    this.lmz.call(
      'SPELLCHECK_WORKER',
      undefined,
      remote,
      this.ctn().handleSpellCheckResult(remote)
    );
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

  @mesh
  unsubscribe() {
    const { callChain } = this.lmz.callContext;
    const clientId = callChain.at(-1)?.instanceName;
    if (clientId) {
      const subscribers: Set<string> = this.ctx.storage.kv.get('subscribers') ?? new Set();
      subscribers.delete(clientId);
      this.ctx.storage.kv.put('subscribers', subscribers);
    }
  }

  // Response handler - no @mesh needed (framework trusts own continuations)
  handleSpellCheckResult(findings: SpellFinding[] | Error) {
    if (findings instanceof Error) {
      console.error('Spell check failed:', findings);
      return;
    }
    this.#broadcastSpellFindings(findings);
  }

  #broadcastContent(content: string) {
    const subscribers: Set<string> = this.ctx.storage.kv.get('subscribers') ?? new Set();
    for (const clientId of subscribers) {
      const remote = this.ctn<EditorClient>().handleContentUpdate(content);
      this.lmz.call(
        'LUMENIZE_CLIENT_GATEWAY',
        clientId,
        remote
      );
    }
  }

  #broadcastSpellFindings(findings: SpellFinding[]) {
    const subscribers: Set<string> = this.ctx.storage.kv.get('subscribers') ?? new Set();
    for (const clientId of subscribers) {
      const remote = this.ctn<EditorClient>().handleSpellFindings(findings);
      this.lmz.call(
        'LUMENIZE_CLIENT_GATEWAY',
        clientId,
        remote
      );
    }
  }

  // Test helpers
  @mesh
  getSubscribers(): string[] {
    const subscribers: Set<string> = this.ctx.storage.kv.get('subscribers') ?? new Set();
    return Array.from(subscribers);
  }

  @mesh
  getContent(): string {
    return this.ctx.storage.kv.get('content') ?? '';
  }
}
