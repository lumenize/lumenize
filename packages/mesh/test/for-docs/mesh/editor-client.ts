/**
 * EditorClient - Browser client implementation
 *
 * Example of a LumenizeClient from getting-started.mdx
 */

import { LumenizeClient, mesh } from '../../../src/index.js';
import type { DocumentDO } from './document-do.js';
import type { SpellFinding } from './spell-check-worker.js';

export class EditorClient extends LumenizeClient {
  // Track incoming calls for testing
  contentUpdates: string[] = [];
  spellFindings: SpellFinding[][] = [];
  #documentId: string;

  constructor(
    config: ConstructorParameters<typeof LumenizeClient>[0],
    documentId: string
  ) {
    super(config);
    this.#documentId = documentId;
  }

  // Called by DocumentDO when content changes
  @mesh
  handleContentUpdate(content: string) {
    this.contentUpdates.push(content);
  }

  // Called by DocumentDO with spell check results
  @mesh
  handleSpellFindings(findings: SpellFinding[]) {
    this.spellFindings.push(findings);
  }

  // Called when reconnecting after grace period expired
  onSubscriptionsLost = () => {
    this.#subscribe();
  };

  // Public method for tests to save content
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
    const remote = this.ctn<DocumentDO>().subscribe();
    const callback = this.ctn<EditorClient>().handleSubscribeResult(remote);
    this.lmz.call(
      'DOCUMENT_DO',
      this.#documentId,
      remote,
      callback
    );
  }

  // Response handler for subscribe - receives result or Error
  @mesh
  handleSubscribeResult(result: any) {
    if (result instanceof Error) {
      console.error('Failed to subscribe:', result);
      return;
    }
    this.contentUpdates.push(result);
  }
}
