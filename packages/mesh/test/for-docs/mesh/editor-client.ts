/**
 * EditorClient - Browser client implementation
 *
 * Example of a LumenizeClient from getting-started.mdx.
 * Uses event callbacks for UI integration - the same pattern works
 * in production (React state updates, DOM manipulation, etc.).
 */

import { LumenizeClient, mesh, type LumenizeClientConfig } from '../../../src/index.js';
import type { DocumentDO } from './document-do.js';
import type { SpellFinding } from './spell-check-worker.js';

/**
 * Configuration for EditorClient
 */
export interface EditorClientConfig extends LumenizeClientConfig {
  /** Called when document content is updated (initial load or broadcast) */
  onContentUpdate?: (content: string) => void;
  /** Called when spell check findings are received */
  onSpellFindings?: (findings: SpellFinding[]) => void;
}

export class EditorClient extends LumenizeClient {
  #documentId: string;
  #onContentUpdate?: (content: string) => void;
  #onSpellFindings?: (findings: SpellFinding[]) => void;

  constructor(config: EditorClientConfig, documentId: string) {
    super(config);
    this.#documentId = documentId;
    this.#onContentUpdate = config.onContentUpdate;
    this.#onSpellFindings = config.onSpellFindings;
  }

  // Called by DocumentDO when content changes
  @mesh
  handleContentUpdate(content: string) {
    this.#onContentUpdate?.(content);
  }

  // Called by DocumentDO with spell check results
  @mesh
  handleSpellFindings(findings: SpellFinding[]) {
    this.#onSpellFindings?.(findings);
  }

  // Called when reconnecting after grace period expired
  onSubscriptionsLost = () => {
    this.#subscribe();
  };

  // Save content to the document
  saveContent(content: string) {
    const remote = this.ctn<DocumentDO>().update(content);
    this.lmz.call(
      'DOCUMENT_DO',
      this.#documentId,
      remote
    );
  }

  // Subscribe to document updates
  subscribe() {
    this.#subscribe();
  }

  #subscribe() {
    this.lmz.call(
      'DOCUMENT_DO',
      this.#documentId,
      this.ctn<DocumentDO>().subscribe(),
      this.ctn<EditorClient>().handleSubscribeResult(this.ctn().$result)
    );
  }

  // Response handler for subscribe - receives initial content or Error
  @mesh
  handleSubscribeResult(result: string | Error) {
    if (result instanceof Error) {
      console.error('Failed to subscribe:', result);
      return;
    }
    // Initial content from subscription
    this.#onContentUpdate?.(result);
  }
}
