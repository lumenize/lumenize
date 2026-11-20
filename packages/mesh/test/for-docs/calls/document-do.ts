/**
 * DocumentDO - Collaborative document storage
 *
 * Example of an unscoped node from getting-started.mdx, calls.mdx and broadcast.mdx. A document is
 * named by an id, never by a scope, so it is its own gatekeeper: its owner shares it by `sub`, and
 * it checks that list when someone subscribes and again before each push.
 */

import { debug } from '@lumenize/debug';
import { UnscopedMeshDO, mesh, getOperationChain, executeOperationChain, type OperationChain, type Continuation, type CallContext } from '../../../src/index.js';
import type { SpellCheckWorker } from './spell-check-worker.js';
import type { EditorClient } from './editor-client.js';
import type { AnalyticsWorker, AnalyticsResult } from './analytics-worker.js';

/** A subscribed Client: its address, as its host stamped it, and whose it is. */
export interface Subscriber {
  bindingName: string;
  instanceName: string;
  sub: string;
}

/**
 * Stored task structure for manual persistence pattern
 */
export interface PendingTask {
  chain: OperationChain;
  context: CallContext;
}

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
  @mesh()
  forceReset(): { reset: true; previousContent: string } {
    const previousContent = this.#do.getContent();
    this.#do.clearAll();
    return { reset: true, previousContent };
  }

  /**
   * Get document stats - admin-only view
   */
  @mesh()
  getStats(): { subscriberCount: number; contentLength: number } {
    return {
      subscriberCount: this.#do.getSubscriberCount(),
      contentLength: this.#do.getContent().length,
    };
  }
}

export class DocumentDO extends UnscopedMeshDO<Env> {
  // Require authentication for all mesh calls
  onBeforeCall(): void {
    super.onBeforeCall();
    if (!this.lmz.callContext.originAuth?.sub) {
      throw new Error('Authentication required');
    }
  }

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
    if (this.ctx.storage.kv.get('owner')) throw new Error('Document already exists');
    this.ctx.storage.kv.put('owner', this.lmz.callContext.originAuth!.sub);
  }

  @mesh((doc: DocumentDO) => doc.requireOwner())
  share(sub: string): void {
    const sharedWith: Set<string> = this.ctx.storage.kv.get('sharedWith') ?? new Set();
    sharedWith.add(sub);
    this.ctx.storage.kv.put('sharedWith', sharedWith);
  }

  @mesh((doc: DocumentDO) => doc.requireShared())
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
    if (origin?.instanceName) {
      const subscribers = this.#subscribers();
      if (!subscribers.some((s) => s.bindingName === origin.bindingName && s.instanceName === origin.instanceName)) {
        subscribers.push({ bindingName: origin.bindingName!, instanceName: origin.instanceName, sub: this.lmz.callContext.originAuth!.sub });
        this.ctx.storage.kv.put('subscribers', subscribers);
      }
    }
    return this.ctx.storage.kv.get('content') ?? '';
  }

  /** A one-shot read of the current content — no side effects (unlike `subscribe`, which also
   *  registers the caller). A natural `callAsync` target: the client awaits the returned value. */
  @mesh((doc: DocumentDO) => doc.requireShared())
  readContent(): string {
    return this.ctx.storage.kv.get('content') ?? '';
  }

  // unsubscribe() left as exercise for reader

  /**
   * Request analytics computation - two one-way calls pattern
   *
   * Demonstrates DO→Worker→DO to avoid wall-clock billing:
   * 1. DO makes a one-way call to the Worker (returns immediately)
   * 2. Worker computes analytics (CPU-only billing)
   * 3. Worker makes a one-way call back to handleAnalyticsResult
   */
  @mesh()
  requestAnalytics(): void {
    const content = this.ctx.storage.kv.get('content') ?? '';
    const documentId = this.lmz.instanceName!;

    // A one-way call to the Worker - DO returns immediately, no wall-clock charges
    this.lmz.call(
      'ANALYTICS_WORKER',
      undefined,
      // @ts-expect-error — content is untyped from kv.get; runtime type is string
      this.ctn<AnalyticsWorker>().computeAnalytics(content, documentId),
      this.ctn().handleCallFailed('analytics'),
      { onErrorOnly: true }
    );
    // DO returns immediately — no wall-clock charges while waiting
  }

  /**
   * Handle analytics result from Worker
   *
   * Called by AnalyticsWorker after computation completes.
   * This is the second leg of the two one-way calls pattern.
   */
  @mesh()
  handleAnalyticsResult(result: AnalyticsResult): void {
    this.ctx.storage.kv.put('analytics', result);
  }

  // For testing - retrieve stored analytics
  @mesh()
  getAnalytics(): AnalyticsResult | undefined {
    return this.ctx.storage.kv.get('analytics');
  }

  /**
   * Get admin interface - capability-based access control
   *
   * Only admins can get the admin interface; once granted, its methods are trusted.
   * Demonstrates operation chaining: admin().forceReset() executes in a single round trip.
   */
  @mesh()
  admin(): AdminInterface {
    // Check if caller has admin role (simplified - in production, check JWT claims or database)
    const userId = this.lmz.callContext.originAuth?.sub;
    const isAdmin = this.ctx.storage.kv.get(`admin:${userId}`) === true;
    if (!isAdmin) {
      throw new AdminAccessError('Admin access required', userId);
    }
    return new AdminInterface(this);
  }

  /**
   * Grant admin access to a user (for testing)
   */
  @mesh()
  grantAdmin(userId: string): void {
    this.ctx.storage.kv.put(`admin:${userId}`, true);
  }

  // Helper methods for AdminInterface
  getContent(): string {
    return this.ctx.storage.kv.get('content') ?? '';
  }

  getSubscriberCount(): number {
    return this.#subscribers().length;
  }

  clearAll(): void {
    this.ctx.storage.kv.put('content', '');
    this.ctx.storage.kv.put('subscribers', []);
  }

  #sharedWith(sub: string | undefined): boolean {
    if (!sub) return false;
    if (this.ctx.storage.kv.get('owner') === sub) return true;
    const sharedWith: Set<string> = this.ctx.storage.kv.get('sharedWith') ?? new Set();
    return sharedWith.has(sub);
  }

  #subscribers(): Subscriber[] {
    return this.ctx.storage.kv.get('subscribers') ?? [];
  }

  /**
   * The subscribers the share list still covers, before a push. One unshared since it subscribed
   * is dropped, and gets nothing more.
   */
  #stillShared(): Subscriber[] {
    const subscribers = this.#subscribers();
    const stillShared = subscribers.filter((s) => {
      if (this.#sharedWith(s.sub)) return true;
      debug('docs.DocumentDO.push').warn('push withheld', { instanceName: s.instanceName, refusal: `Not shared with ${s.sub}` });
      return false;
    });
    if (stillShared.length !== subscribers.length) this.ctx.storage.kv.put('subscribers', stillShared);
    return stillShared;
  }

  /**
   * Schedule a local task for later execution.
   *
   * Demonstrates manual persistence pattern from managing-context.mdx:
   * - Use getOperationChain() to extract the chain from a continuation
   * - Save callContext separately (it's a plain object)
   * - KV handles Maps, Sets, Dates, cycles natively
   *
   * The continuation is created within this method using this.ctn(),
   * capturing the message to log. This is the pattern described in
   * the "Manual Persistence" section of managing-context.mdx.
   */
  @mesh()
  scheduleLocalTask(taskId: string, message: string): { scheduled: true; taskId: string } {
    // Create a continuation to our own logMessage method
    const continuation = this.ctn<DocumentDO>().logMessage(message);

    // Extract the operation chain from the continuation proxy
    const chain = getOperationChain(continuation);
    if (!chain) {
      throw new Error('Failed to extract operation chain');
    }

    // Capture the current call context
    const context = this.lmz.callContext;

    // Store both for later execution (KV handles complex types natively)
    this.ctx.storage.kv.put(`task:${taskId}`, { chain, context } as PendingTask);

    return { scheduled: true, taskId };
  }

  /**
   * Execute a previously stored task.
   *
   * Demonstrates restoration and execution of persisted continuations.
   * The context is available but must be used manually (e.g., for logging or access control).
   */
  @mesh()
  async executePendingTask(taskId: string): Promise<{ executed: boolean; originalUserId?: string }> {
    const pending = this.ctx.storage.kv.get(`task:${taskId}`) as PendingTask | undefined;
    if (!pending) {
      return { executed: false };
    }

    const { chain, context } = pending;

    // Execute the chain - context is available for manual use
    // requireMeshDecorator: false allows calling methods without @mesh decorator.
    // This is safe here because we're executing a chain we created and stored ourselves.
    await executeOperationChain(chain, this, { requireMeshDecorator: false });

    // Clean up
    this.ctx.storage.kv.delete(`task:${taskId}`);

    return {
      executed: true,
      originalUserId: context.originAuth?.sub
    };
  }

  /**
   * Simple method that can be called via persisted continuation
   */
  logMessage(message: string): void {
    const messages: string[] = this.ctx.storage.kv.get('messages') ?? [];
    messages.push(message);
    this.ctx.storage.kv.put('messages', messages);
  }

  /**
   * Retrieve logged messages (for testing)
   */
  @mesh()
  getMessages(): string[] {
    return this.ctx.storage.kv.get('messages') ?? [];
  }

  // Reusable broadcast helper that accepts any continuation
  #broadcast(continuation: Continuation<any>) {
    for (const { bindingName, instanceName } of this.#stillShared()) {
      this.lmz.call(bindingName, instanceName, continuation,
        this.ctn().handleCallFailed('content update'), { newChain: true, onErrorOnly: true });
    }
  }

  /**
   * Like `update`, but fans out to subscribers WITHOUT `{ newChain: true }`, so the pushed
   * `handleContentUpdate` preserves the WRITER's origin: the receiver sees
   * `callChain = [writerClient, DocumentDO]` (`callChain.at(-1)` = this DO). It is what
   * `lmz.broadcast` sends with `{ newChain: false }`, and the fixture for the `MeshClient`
   * default peer-guard: a DO-mediated
   * cross-client push must be ACCEPTED by the receiver's default `onBeforeCall` (caller = the DO),
   * even though its ORIGIN is another client. (Contrast `#broadcast`, whose `newChain` makes the DO
   * the origin — a shape the origin-based guard bug never rejected, so it can't prove the fix.)
   */
  @mesh((doc: DocumentDO) => doc.requireShared())
  updatePreservingOrigin(content: string): void {
    this.ctx.storage.kv.put('content', content);
    const documentId = this.lmz.instanceName!;
    for (const { bindingName, instanceName } of this.#stillShared()) {
      // NO newChain → callChain stays [writerClient, this DO]; the receiver's at(-1) is this DO.
      this.lmz.call(bindingName, instanceName,
        this.ctn<EditorClient>().handleContentUpdate(documentId, content),
        this.ctn().handleCallFailed('content update'), { onErrorOnly: true });
    }
  }

  /**
   * Push new content to every subscriber with one `lmz.broadcast` — broadcast.mdx § Basic Usage.
   * Driven by `broadcast.test.ts`, which also shows what this leaves behind: a subscriber whose tab
   * is gone stays listed, since the handler here only logs that its push failed.
   */
  @mesh((doc: DocumentDO) => doc.requireShared())
  publish(content: string) {
    this.ctx.storage.kv.put('content', content);
    const documentId = this.lmz.instanceName!;

    // Every subscriber's host gets the same `handleContentUpdate` call, for its Client
    const targets = this.#stillShared().map(({ bindingName, instanceName }) => ({ bindingName, instanceName }));
    this.lmz.broadcast(targets, this.ctn<EditorClient>().handleContentUpdate(documentId, content), {
      onResult: this.ctn().handleCallFailed('content update'),
    });
  }

  /**
   * The same push, with drop-on-failed-fanout cleanup — broadcast.mdx § Result Handling. Driven by
   * `broadcast.test.ts`: the dead subscriber `publish` leaves listed is dropped by this one.
   */
  @mesh((doc: DocumentDO) => doc.requireShared())
  publishAndPrune(content: string) {
    this.ctx.storage.kv.put('content', content);
    const documentId = this.lmz.instanceName!;
    const targets = this.#stillShared().map(({ bindingName, instanceName }) => ({ bindingName, instanceName }));

    this.lmz.broadcast(targets, this.ctn<EditorClient>().handleContentUpdate(documentId, content), {
      onResult: this.ctn().onContentDelivered(),
    });
  }

  // No `@mesh()` — a Client's host fires a failed push back to this node's fire-back door, where
  // the member-level check is off. Adding one would make this reaper callable as an ordinary request,
  // with caller-chosen arguments; only the framework-supplied callee makes that harmless.
  onContentDelivered(result?: unknown): void {
    if (result instanceof Error && result.name === 'ClientDisconnectedError') {
      const callee = this.lmz.callContext.callee;
      if (callee?.instanceName) {
        const subscribers = this.#subscribers()
          .filter((s) => !(s.bindingName === callee.bindingName && s.instanceName === callee.instanceName));
        this.ctx.storage.kv.put('subscribers', subscribers);
      }
    }
  }

  // Usage: pass different continuations to the same broadcast helper
  #broadcastContent(content: string) {
    const documentId = this.lmz.instanceName!;
    this.#broadcast(this.ctn<EditorClient>().handleContentUpdate(documentId, content));
  }

  // The handler for a call whose answer nobody needs. It is sent with { onErrorOnly: true },
  // so it runs only when the call fails, with the Error appended as its last argument.
  handleCallFailed(what: string, error?: Error) {
    console.error(`${what} failed:`, error);
  }
}
