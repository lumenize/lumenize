import { LumenizeBase } from '@lumenize/lumenize-base';
import '@lumenize/call';  // Required for __executeOperation
import '@lumenize/proxy-fetch';
import { FetchOrchestrator as _FetchOrchestrator, FetchExecutorEntrypoint } from '@lumenize/proxy-fetch';
import { ResponseSync, stringify } from '@lumenize/structured-clone';

// Export FetchExecutorEntrypoint for service binding
export { FetchExecutorEntrypoint };

export class _TestDO extends LumenizeBase {
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    this.__lmzInit({ doBindingName: 'TEST_DO' });
  }

  async fetchData(url: string, reqId?: string): Promise<string> {
    const finalReqId = await this.svc.proxyFetch(
      url,
      this.ctn().handleFetchResult(this.ctn().$result, url),
      {},
      reqId
    );
    return finalReqId;
  }

  async fetchDataWithRequest(request: Request, reqId?: string): Promise<string> {
    const finalReqId = await this.svc.proxyFetch(
      request,
      this.ctn().handleFetchResult(this.ctn().$result, request.url),
      {},
      reqId
    );
    return finalReqId;
  }

  async fetchDataWithOptions(url: string, options: { timeout?: number; testMode?: { simulateDeliveryFailure?: boolean } }, reqId?: string): Promise<string> {
    const finalReqId = await this.svc.proxyFetch(
      url,
      this.ctn().handleFetchResult(this.ctn().$result, url),
      options,
      reqId
    );
    return finalReqId;
  }

  async handleFetchResult(result: ResponseSync | Error, url: string): Promise<void> {
    const resultKey = `__test_result:${url}`;
    const serialized = await stringify(result);
    this.ctx.storage.kv.put(resultKey, serialized);
    
    // Increment call counter for testing
    const counterKey = `__test_call_count:${url}`;
    const currentCount: number = this.ctx.storage.kv.get(counterKey) || 0;
    this.ctx.storage.kv.put(counterKey, currentCount + 1);
  }

  getResult(url: string): string | undefined {
    return this.ctx.storage.kv.get(`__test_result:${url}`);
  }

  getCallCount(url: string): number {
    return this.ctx.storage.kv.get(`__test_call_count:${url}`) || 0;
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

