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
    // Mock implementation - in real app this would call external API
    // For testing, we'll flag any word containing "teh" as a typo
    const findings: SpellFinding[] = [];
    const words = content.split(/\s+/);
    let position = 0;

    for (const word of words) {
      if (word.toLowerCase().includes('teh')) {
        findings.push({
          word,
          position,
          suggestions: [word.replaceAll(/teh/gi, 'the')],
        });
      }
      position += word.length + 1; // +1 for space
    }

    // Send results directly to the originating client (fire-and-forget)
    if (findings.length > 0) {
      await this.lmz.callRaw(
        'LUMENIZE_CLIENT_GATEWAY',
        clientId,
        this.ctn<EditorClient>().handleSpellFindings(documentId, findings)
      );
    }
  }
}
