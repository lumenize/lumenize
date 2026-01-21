/**
 * SpellCheckWorker - Stateless spelling checker
 *
 * Example of a LumenizeWorker from getting-started.mdx
 */

import { LumenizeWorker, mesh } from '../../../src/index.js';

export interface SpellFinding {
  word: string;
  position: number;
  suggestions: string[];
}

export class SpellCheckWorker extends LumenizeWorker<Env> {
  @mesh
  check(content: string): SpellFinding[] {
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
          suggestions: [word.replaceAll(/teh/gi, 'the')]
        });
      }
      position += word.length + 1; // +1 for space
    }

    return findings;
  }
}
