/**
 * DocumentDO - Collaborative document storage
 *
 * Example of an unscoped node from getting-started.mdx. A document is named by an id, such as a
 * UUID, never by a scope, so no tenant's passage reaches it: it is its own gatekeeper. Its owner
 * shares it by `sub`, and it checks that list when someone subscribes and again before each push.
 */

import { debug } from '@lumenize/debug';
import { UnscopedMeshDO, mesh } from '../../../src/index.js';
import type { SpellCheckWorker } from './spell-check-worker.js';
import type { EditorClient } from './editor-client.js';

/** A subscribed Client: its address, as its host stamped it, and whose it is. */
interface Subscriber {
  bindingName: string;
  instanceName: string;
  sub: string;
}

export class DocumentDO extends UnscopedMeshDO<Env> {
  /** Guard: the caller owns the document. */
  requireOwner(): void {
    const sub = this.lmz.callContext.originAuth?.sub;
    if (!sub || this.ctx.storage.kv.get('owner') !== sub) {
      throw new Error('Only the owner can do that');
    }
  }

  /** Guard: the caller owns the document or it was shared with them. */
  requireShared(): void {
    const sub = this.lmz.callContext.originAuth?.sub;
    if (!this.#sharedWith(sub)) throw new Error(`Not shared with ${sub}`);
  }

  /** Create the document, owned by its caller. */
  @mesh()
  create(): void {
    const sub = this.lmz.callContext.originAuth?.sub;
    if (!sub) throw new Error('Authentication required');
    if (this.ctx.storage.kv.get('owner')) throw new Error('Document already exists');
    this.ctx.storage.kv.put('owner', sub);
  }

  @mesh((doc: DocumentDO) => doc.requireOwner())
  share(sub: string): void {
    const sharedWith: Set<string> = this.ctx.storage.kv.get('sharedWith') ?? new Set();
    sharedWith.add(sub);
    this.ctx.storage.kv.put('sharedWith', sharedWith);
  }

  @mesh((doc: DocumentDO) => doc.requireOwner())
  unshare(sub: string): void {
    const sharedWith: Set<string> = this.ctx.storage.kv.get('sharedWith') ?? new Set();
    sharedWith.delete(sub);
    this.ctx.storage.kv.put('sharedWith', sharedWith);
  }

  // Only subscribers can update, and only while the document is still shared with them
  @mesh((doc: DocumentDO) => {
    doc.requireShared();
    const origin = doc.lmz.callContext.callChain[0];
    const subscribers: Subscriber[] = doc.ctx.storage.kv.get('subscribers') ?? [];
    if (!subscribers.some((s) => s.bindingName === origin?.bindingName && s.instanceName === origin?.instanceName)) {
      throw new Error('Must be subscribed to edit');
    }
  })
  update(content: string) {
    this.ctx.storage.kv.put('content', content);

    // Notify all subscribers with new content
    this.#broadcastContent(content);

    // Trigger spell check - worker sends results directly to originator, the start of this chain
    this.lmz.call(
      'SPELLCHECK_WORKER',
      undefined,
      this.ctn<SpellCheckWorker>().check(content, this.lmz.instanceName!),
      this.ctn().handleCallFailed('spell check'),
      { onErrorOnly: true }
    );
  }

  @mesh((doc: DocumentDO) => doc.requireShared())
  subscribe(): string {
    // The address comes from the chain the Client's host stamped, never from anything it sent.
    const origin = this.lmz.callContext.callChain[0];
    const sub = this.lmz.callContext.originAuth!.sub;
    if (origin?.instanceName) {
      const subscribers: Subscriber[] = this.ctx.storage.kv.get('subscribers') ?? [];
      if (!subscribers.some((s) => s.instanceName === origin.instanceName && s.bindingName === origin.bindingName)) {
        subscribers.push({ bindingName: origin.bindingName!, instanceName: origin.instanceName, sub });
        this.ctx.storage.kv.put('subscribers', subscribers);
      }
    }
    return this.ctx.storage.kv.get('content') ?? '';
  }

  // unsubscribe() left as exercise for reader

  #sharedWith(sub: string | undefined): boolean {
    if (!sub) return false;
    if (this.ctx.storage.kv.get('owner') === sub) return true;
    const sharedWith: Set<string> = this.ctx.storage.kv.get('sharedWith') ?? new Set();
    return sharedWith.has(sub);
  }

  #broadcastContent(content: string) {
    const documentId = this.lmz.instanceName!;
    const subscribers: Subscriber[] = this.ctx.storage.kv.get('subscribers') ?? [];
    // Before each push, the share list again: a subscriber unshared since it subscribed is dropped
    const stillShared = subscribers.filter((s) => {
      if (this.#sharedWith(s.sub)) return true;
      debug('docs.DocumentDO.push').warn('push withheld', { instanceName: s.instanceName, refusal: `Not shared with ${s.sub}` });
      return false;
    });
    if (stillShared.length !== subscribers.length) this.ctx.storage.kv.put('subscribers', stillShared);
    // Continuation is created once and reused — serialization has no side effects
    const remote = this.ctn<EditorClient>().handleContentUpdate(documentId, content);
    // Note: In production, you'd skip the originator to avoid redundant updates
    for (const { bindingName, instanceName } of stillShared) {
      // Start new chain - this is a server-initiated push, not a response to client
      this.lmz.call(
        bindingName,
        instanceName,
        remote,
        this.ctn().handleCallFailed('content update'),
        { newChain: true, onErrorOnly: true }
      );
    }
  }

  // The handler for a call whose answer nobody needs. It is sent with { onErrorOnly: true },
  // so it runs only when the call fails, with the Error appended as its last argument.
  handleCallFailed(what: string, error?: Error) {
    console.error(`${what} failed:`, error);
  }
}
