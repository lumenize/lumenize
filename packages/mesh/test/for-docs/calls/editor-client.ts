/**
 * EditorClient - Browser client implementation
 *
 * Example of a LumenizeClient from getting-started.mdx.
 * Manages multiple open documents over a single WebSocket connection.
 * Uses event callbacks for UI integration - the same pattern works
 * in production (React state updates, DOM manipulation, etc.).
 */

import { LumenizeClient, mesh, type CallContext } from '../../../src/index.js';
import { AdminAccessError, type DocumentDO, type AdminInterface } from './document-do.js';
import type { SpellCheckWorker, SpellFinding } from './spell-check-worker.js';

// Register on globalThis so deserializer can reconstruct the type on client side
(globalThis as any).AdminAccessError = AdminAccessError;

// Callbacks for a single document
export interface DocumentCallbacks {
  // Called when document content is updated (initial load or broadcast)
  onContentUpdate?: (content: string) => void;
  // Called when spell check findings are received
  onSpellFindings?: (findings: SpellFinding[]) => void;
  // Called with callContext when content update is received (for testing { newChain: true })
  onContentUpdateContext?: (context: CallContext) => void;
}

// Handle for an open document - allows saving content and closing
export interface DocumentHandle {
  // Save new content to the document
  saveContent(content: string): void;
  // Close this document (unsubscribe and remove from registry)
  close(): void;
}

export class EditorClient extends LumenizeClient {
  // Registry of open documents by documentId
  readonly #documents = new Map<string, DocumentCallbacks>();

  /**
   * Open a document for editing
   *
   * Subscribes to the document and registers callbacks for updates.
   * Returns a handle for saving content and closing the document.
   */
  openDocument(documentId: string, callbacks: DocumentCallbacks): DocumentHandle {
    // Register callbacks
    this.#documents.set(documentId, callbacks);

    // Subscribe to document updates
    this.#subscribe(documentId, callbacks);

    // Return handle for interacting with this document
    return {
      saveContent: (content: string) => {
        this.lmz.call(
          'DOCUMENT_DO',
          documentId,
          this.ctn<DocumentDO>().update(content)
        );
      },
      close: () => {
        this.#documents.delete(documentId);
        // Should create and use DocumentDO.unsubscribe
      },
    };
  }

  #subscribe(documentId: string, callbacks: DocumentCallbacks) {
    this.lmz.call(
      'DOCUMENT_DO',
      documentId,
      this.ctn<DocumentDO>().subscribe(),
      this.ctn().handleSubscribeResult(documentId, this.ctn().$result, 'open-document')  // $result can go anywhere
    );
  }

  // Called on every connection (except reconnects within 5s grace period)
  onSubscriptionRequired = () => {
    // (Re)subscribe to all open documents
    for (const [documentId, callbacks] of this.#documents) {
      this.#subscribe(documentId, callbacks);
    }
  };

  // Response handler for subscribe - receives initial content or Error
  handleSubscribeResult(documentId: string, result: string | Error, source: string) {
    console.log(`Subscribe from ${source}:`, result);
    const callbacks = this.#documents.get(documentId);
    if (!callbacks) return; // Document was closed

    if (result instanceof Error) {
      console.error(`Failed to subscribe to ${documentId}:`, result);
      return;
    }
    callbacks.onContentUpdate?.(result);
  }

  // Called by DocumentDO when content changes (broadcast)
  // Note: DocumentDO broadcasts with { newChain: true }, so callContext.origin
  // is DocumentDO (not the client who triggered the update)
  @mesh()
  handleContentUpdate(documentId: string, content: string) {
    const callbacks = this.#documents.get(documentId);
    callbacks?.onContentUpdate?.(content);
    // Expose callContext for testing { newChain: true } behavior
    callbacks?.onContentUpdateContext?.(this.lmz.callContext);
  }

  // Called directly by SpellCheckWorker — not routed back through DocumentDO.
  // This "direct delivery" pattern is a key benefit of the mesh architecture:
  // any node can send results to any other node without intermediate hops.
  @mesh()
  handleSpellFindings(documentId: string, findings: SpellFinding[]) {
    this.#documents.get(documentId)?.onSpellFindings?.(findings);
  }

  /**
   * Request spell check directly from Worker (bypassing DO)
   *
   * Demonstrates client calling Worker directly. The Worker responds
   * back to this client via handleSpellFindings.
   */
  requestSpellCheck(documentId: string, content: string) {
    // Client passes its own instanceName so Worker knows where to respond
    this.lmz.call(
      'SPELLCHECK_WORKER',
      undefined,
      this.ctn<SpellCheckWorker>().check(content, this.lmz.instanceName, documentId)
    );
  }

  /**
   * Fetch document stats on demand — a one-shot read that RETURNS a Promise via `callAsync`, the
   * client's resilient awaitable. It keeps its settler in-heap keyed by callId, so the Promise
   * survives a WebSocket reconnect / tab freeze (delivery re-resolves to the current socket) and is
   * bounded by a built-in default timeout — it never strands the way the removed awaited `callRaw`
   * did. The optional `AbortSignal` cancels the WAIT, not the server op — e.g. when the user
   * navigates away mid-request. `callAsync` is client-only and the one sanctioned awaitable on
   * `client.lmz`; prefer a subscription for live data and higher-level SDK methods where they exist.
   */
  async fetchContent(documentId: string, signal?: AbortSignal): Promise<string> {
    return this.lmz.callAsync(
      'DOCUMENT_DO',
      documentId,
      this.ctn<DocumentDO>().readContent(),
      { signal },
    );
  }

  // Store results from admin operations
  readonly adminResults: Array<{ reset: true; previousContent: string } | Error> = [];

  // Store generic results from operations that use handleResult
  readonly results: any[] = [];

  // Generic result handler for testing operations
  handleResult(result: any) {
    this.results.push(result);
  }

  /**
   * Admin force reset - demonstrates operation chaining
   *
   * Uses the Capability Trust pattern: admin().forceReset()
   * - admin() checks permissions and returns AdminInterface
   * - forceReset() is called on the returned interface
   * - All operations execute in a single round trip
   */
  adminForceReset(documentId: string) {
    // Only admins can get the admin interface; once granted, its methods are trusted
    this.lmz.call(
      'DOCUMENT_DO',
      documentId,
      this.ctn<DocumentDO>().admin().forceReset(),
      this.ctn().handleAdminResult(this.ctn().$result)
    );
  }

  handleAdminResult(result: { reset: true; previousContent: string } | Error) {
    if (result instanceof AdminAccessError) {
      // Custom error type preserved! Can check specific error type
      console.error(`Admin access denied for user: ${result.userId}`);
    } else if (result instanceof Error) {
      // Other errors - message, name, stack still preserved
      console.error('Admin operation failed:', result.message);
    }
    this.adminResults.push(result);
  }
}
