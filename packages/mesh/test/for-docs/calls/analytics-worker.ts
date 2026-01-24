/**
 * AnalyticsWorker - Expensive computation offloaded from DO
 *
 * Demonstrates the two one-way calls pattern (DO→Worker→DO):
 * 1. DO fires-and-forgets to Worker to avoid wall-clock billing
 * 2. Worker does expensive async work (CPU-only billing)
 * 3. Worker fires-and-forgets back to DO with results
 */

import { LumenizeWorker, mesh } from '../../../src/index.js';
import type { DocumentDO } from './document-do.js';

export interface AnalyticsResult {
  wordCount: number;
  characterCount: number;
  readingTimeMinutes: number;
}

export class AnalyticsWorker extends LumenizeWorker<Env> {
  @mesh
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

    // Fire-and-forget back to the DO with results
    await this.lmz.callRaw(
      'DOCUMENT_DO',
      documentId,
      this.ctn<DocumentDO>().handleAnalyticsResult(result)
    );
  }
}
