/**
 * FetchExampleDO - Demonstrates fetch service patterns
 *
 * Example DO for fetch/index.mdx documentation
 */

import '@lumenize/fetch';  // Side-effect registers this.svc.fetch
import { FetchTimeoutError } from '@lumenize/fetch';
import { LumenizeDO, mesh } from '@lumenize/mesh';
import type { ResponseSync } from '@lumenize/structured-clone';

export class FetchExampleDO extends LumenizeDO<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // For tests: manually init identity (normally set via routeDORequest)
    this.lmz.__init({ bindingName: 'FETCH_EXAMPLE_DO' });
  }

  // ============================================
  // Quick Start pattern: Basic fetch with error handling
  // ============================================

  fetchUserData(userId: string) {
    this.svc.fetch.proxy(
      `https://api.example.com/users/${userId}`,
      this.ctn().handleResult(userId, this.ctn().$result)  // Context + $result placeholder
    );
  }

  @mesh()  // Required decorator for continuation handlers
  handleResult(userId: string, result: ResponseSync | Error) {
    if (result instanceof FetchTimeoutError) {
      // Timeout is ambiguous - external API may have processed request
      // For non-idempotent operations, check external state before retrying
      return;
    }
    if (result instanceof Error) {
      // Definite failure (network error, abort) - safe to retry
      console.error(`Failed for ${userId}:`, result);
      return;
    }
    // ResponseSync received - has sync body methods (.json(), .text(), .arrayBuffer())
    // Check result.ok, read status codes, use body like any HTTP Response
    const data = result.json();
    console.log(`User ${userId}:`, data);
  }

  // ============================================
  // Test helpers (not shown in docs)
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

  // Method to test with real URLs - stores results for test assertions
  fetchUrl(url: string) {
    this.svc.fetch.proxy(
      url,
      this.ctn().handleUrlResult(url, this.ctn().$result)
    );
  }

  @mesh()
  handleUrlResult(url: string, result: ResponseSync | Error) {
    if (result instanceof FetchTimeoutError) {
      this.ctx.storage.kv.put('lastResult', { url, type: 'timeout', message: result.message });
      return;
    }
    if (result instanceof Error) {
      this.ctx.storage.kv.put('lastResult', { url, type: 'error', message: result.message });
      return;
    }
    // Try to parse JSON, but handle non-JSON responses gracefully
    let data = null;
    try {
      data = result.json();
    } catch {
      // Non-JSON response (common for error status codes)
    }
    this.ctx.storage.kv.put('lastResult', {
      url,
      type: 'success',
      status: result.status,
      ok: result.ok,
      data
    });
  }
}
