import { LumenizeBase } from '@lumenize/lumenize-base';
import '@lumenize/call';  // Required for __executeOperation
import '@lumenize/proxy-fetch';
import { FetchOrchestrator as _FetchOrchestrator, FetchExecutorEntrypoint } from '@lumenize/proxy-fetch';
import { ResponseSync, stringify } from '@lumenize/structured-clone';

// Export FetchExecutorEntrypoint for service binding
export { FetchExecutorEntrypoint };

export class _TestDO extends LumenizeBase {
  async fetchData(url: string): Promise<string> {
    const reqId = await this.svc.proxyFetch(
      url,
      this.ctn().handleFetchResult(this.ctn().$result, url),
      { originBinding: 'TEST_DO' }
    );
    return reqId;
  }

  async fetchDataWithRequest(request: Request): Promise<string> {
    const reqId = await this.svc.proxyFetch(
      request,
      this.ctn().handleFetchResult(this.ctn().$result, request.url),
      { originBinding: 'TEST_DO' }
    );
    return reqId;
  }

  async fetchDataWithOptions(url: string, options: { timeout?: number }): Promise<string> {
    const reqId = await this.svc.proxyFetch(
      url,
      this.ctn().handleFetchResult(this.ctn().$result, url),
      { ...options, originBinding: 'TEST_DO' }
    );
    return reqId;
  }

  async handleFetchResult(result: ResponseSync | Error, url: string): Promise<void> {
    const resultKey = `__test_result:${url}`;
    const serialized = await stringify(result);
    this.ctx.storage.kv.put(resultKey, serialized);
  }

  getResult(url: string): string | undefined {
    return this.ctx.storage.kv.get(`__test_result:${url}`);
  }

  /**
   * Clear all results (for test cleanup)
   */
  clearResults(): void {
    const results = this.ctx.storage.kv.list({ prefix: '__test_result:' });
    for (const [key] of results) {
      this.ctx.storage.kv.delete(key);
    }
  }
}

// Export raw DOs (not instrumented - that happens in test-harness.ts)
export { _TestDO as TestDO };
export { _FetchOrchestrator as FetchOrchestrator };

