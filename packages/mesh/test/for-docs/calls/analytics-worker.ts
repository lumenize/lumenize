/**
 * AnalyticsWorker - Expensive computation offloaded from DO
 *
 * Demonstrates the two one-way calls pattern (DO→Worker→DO):
 * 1. DO makes a one-way call to the Worker to avoid wall-clock billing
 * 2. Worker does expensive async work (CPU-only billing)
 * 3. Worker makes a one-way call back to the DO with results
 */

import { LumenizeWorker, mesh } from '../../../src/index.js';
import type { DocumentDO } from './document-do.js';

export interface AnalyticsResult {
  wordCount: number;
  characterCount: number;
  readingTimeMinutes: number;
}

export class AnalyticsWorker extends LumenizeWorker<Env> {
  @mesh()
  async computeAnalytics(
    content: string,
    documentId: string
  ): Promise<void> {
    // Simulate expensive computation (Worker only bills CPU time, not wall-clock)
    const result: AnalyticsResult = {
      wordCount: content.split(/\s+/).filter(Boolean).length,
      characterCount: content.length,
      readingTimeMinutes: Math.ceil(content.split(/\s+/).length / 200),
    };

    // A one-way call back to the DO with results
    this.lmz.call(
      'DOCUMENT_DO',
      documentId,
      this.ctn<DocumentDO>().handleAnalyticsResult(result),
      this.ctn().handleCallFailed('analytics result'),
      { onErrorOnly: true }
    );
  }

  // The handler for a call whose answer nobody needs. It is sent with { onErrorOnly: true },
  // so it runs only when the call fails, with the Error appended as its last argument.
  handleCallFailed(what: string, error?: Error) {
    console.error(`${what} failed:`, error);
  }
}
