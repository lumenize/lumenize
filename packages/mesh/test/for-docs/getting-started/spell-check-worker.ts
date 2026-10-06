/**
 * SpellCheckWorker - Stateless spelling checker
 *
 * Example of a LumenizeWorker from getting-started.mdx.
 * Sends results directly to the originating client.
 */

import { LumenizeWorker, mesh } from '../../../src/index.js';
import type { EditorClient } from './editor-client.js';

export interface SpellFinding {
  word: string;
  position: number;
  suggestions: string[];
}

export class SpellCheckWorker extends LumenizeWorker<Env> {
  @mesh()
  async check(content: string, clientId: string, documentId: string): Promise<void> {
    // Mock spell checker - flags "teh" as misspelled
    const findings: SpellFinding[] = [];
    const words = content.split(' ');
    let position = 0;

    for (const word of words) {
      if (word.toLowerCase() === 'teh') {
        findings.push({ word, position, suggestions: ['the'] });
      }
      position += word.length + 1;
    }

    // Send results directly to the originating client (one-way)
    if (findings.length > 0) {
      this.lmz.call(
        'LUMENIZE_CLIENT_GATEWAY',
        clientId,
        this.ctn<EditorClient>().handleSpellFindings(documentId, findings),
        this.ctn().handleCallFailed('spell findings'),
        { onErrorOnly: true }
      );
    }
  }

  // The handler for a call whose answer nobody needs. It is sent with { onErrorOnly: true },
  // so it runs only when the call fails, with the Error appended as its last argument.
  handleCallFailed(what: string, error?: Error) {
    console.error(`${what} failed:`, error);
  }
}
