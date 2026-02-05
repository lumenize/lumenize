/**
 * DocumentDO - Collaborative document storage
 *
 * Example of a LumenizeDO from getting-started.mdx
 */

import { LumenizeDO, mesh } from '../../../src/index.js';
import type { SpellCheckWorker } from './spell-check-worker.js';
import type { EditorClient } from './editor-client.js';

export class DocumentDO extends LumenizeDO<Env> {
  // Only subscribers can update — auth is already guaranteed by auth hooks
  @mesh((instance: DocumentDO) => {
    const sub = instance.lmz.callContext.originAuth!.sub;
    const subscribers: Set<string> = instance.ctx.storage.kv.get('subscribers') ?? new Set();
    if (!subscribers.has(sub)) {
      throw new Error('Must be subscribed to edit');
    }
  })
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

  @mesh()
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
