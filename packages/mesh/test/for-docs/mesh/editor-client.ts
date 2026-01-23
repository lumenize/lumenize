/**
 * EditorClient - Browser client implementation
 *
 * Example of a LumenizeClient from getting-started.mdx.
 * Manages multiple open documents over a single WebSocket connection.
 * Uses event callbacks for UI integration - the same pattern works
 * in production (React state updates, DOM manipulation, etc.).
 */

import { LumenizeClient, mesh } from '../../../src/index.js';
import type { DocumentDO } from './document-do.js';
import type { SpellFinding } from './spell-check-worker.js';

// Callbacks for a single document
export interface DocumentCallbacks {
  // Called when document content is updated (initial load or broadcast)
  onContentUpdate?: (content: string) => void;
  // Called when spell check findings are received
  onSpellFindings?: (findings: SpellFinding[]) => void;
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
      this.ctn().handleSubscribeResult(documentId, this.ctn().$result)
    );
  }

  // Called when reconnecting after grace period expired
  onSubscriptionsLost = () => {
    // Re-subscribe to all open documents
    for (const [documentId, callbacks] of this.#documents) {
      this.#subscribe(documentId, callbacks);
    }
  };

  // Response handler for subscribe - receives initial content or Error
  handleSubscribeResult(documentId: string, result: string | Error) {
    const callbacks = this.#documents.get(documentId);
    if (!callbacks) return; // Document was closed

    if (result instanceof Error) {
      console.error(`Failed to subscribe to ${documentId}:`, result);
      return;
    }
    callbacks.onContentUpdate?.(result);
  }

  // Called by DocumentDO when content changes (broadcast)
  @mesh
  handleContentUpdate(documentId: string, content: string) {
    this.#documents.get(documentId)?.onContentUpdate?.(content);
  }

  // Called directly by SpellCheckWorker — not routed back through DocumentDO.
  // This "direct delivery" pattern is a key benefit of the mesh architecture:
  // any node can send results to any other node without intermediate hops.
  @mesh
  handleSpellFindings(documentId: string, findings: SpellFinding[]) {
    this.#documents.get(documentId)?.onSpellFindings?.(findings);
  }
}
