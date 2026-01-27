/**
 * RetryExampleDO - Demonstrates retry patterns with fetch service
 *
 * Example DO for fetch/index.mdx Retry Pattern documentation
 */

import '@lumenize/fetch';
import { FetchTimeoutError } from '@lumenize/fetch';
import { LumenizeDO, mesh } from '@lumenize/mesh';
import type { ResponseSync } from '@lumenize/structured-clone';

export class RetryExampleDO extends LumenizeDO<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // For tests: manually init identity (normally set via routeDORequest)
    this.lmz.__init({ bindingName: 'RETRY_EXAMPLE_DO' });
  }

  // ============================================
  // Retry Pattern: Fetch with automatic retries
  // ============================================

  fetchWithRetry(url: string, attempt: number = 1) {
    this.svc.fetch.proxy(url, this.ctn().handleRetryResult(url, attempt, this.ctn().$result));
  }

  @mesh
  handleRetryResult(url: string, attempt: number, result: ResponseSync | Error) {
    if (result instanceof FetchTimeoutError) {
      // Timeout is ambiguous - for idempotent GETs, retry is safe
      if (attempt < 3) {
        this.fetchWithRetry(url, attempt + 1);
        return;
      }
    }
    if (result instanceof Error && attempt < 3) {
      // Definite failure - safe to retry
      this.fetchWithRetry(url, attempt + 1);
      return;
    }
    if (result instanceof Error) {
      console.error('All retries failed:', result);
      // For tests: also store result
      this.ctx.storage.kv.put('lastResult', { url, type: 'error', message: result.message, attempts: attempt });
      return;
    }
    if (!result.ok && result.status >= 500 && attempt < 3) {
      this.fetchWithRetry(url, attempt + 1);
      return;
    }
    // For tests: store result (docs would use console.log)
    if (result.ok) {
      console.log('Success:', result.json());
      this.ctx.storage.kv.put('lastResult', { url, type: 'success', status: result.status, attempts: attempt, data: result.json() });
    } else {
      this.ctx.storage.kv.put('lastResult', { url, type: 'http_error', status: result.status, attempts: attempt, data: null });
    }
  }

  // ============================================
  // Test helpers
  // ============================================

  getLastResult(): any {
    return this.ctx.storage.kv.get('lastResult');
  }

  clearResults(): void {
    this.ctx.storage.kv.delete('lastResult');
  }

  async triggerAlarmsForTest(count?: number) {
    return await this.svc.alarms.triggerAlarms(count);
  }
}
