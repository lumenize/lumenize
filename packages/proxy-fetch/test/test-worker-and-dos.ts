import '@lumenize/core';        // Registers sql in this.svc
import '@lumenize/alarms';      // Registers alarms in this.svc
import { LumenizeBase } from '@lumenize/lumenize-base';
import { FetchExecutorEntrypoint, proxyFetch } from '@lumenize/proxy-fetch';
import { RequestSync, ResponseSync, stringify, postprocess, preprocess } from '@lumenize/structured-clone';
import { replaceNestedOperationMarkers, getOperationChain } from '@lumenize/lumenize-base';

// Export FetchExecutorEntrypoint for service binding
export { FetchExecutorEntrypoint };

/**
 * Test DO for proxyFetch
 * Uses alarms for timeout handling
 */
export class _TestSimpleDO extends LumenizeBase {
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    this.lmz.init({ bindingName: 'TEST_SIMPLE_DO' });
  }

  // Required: Delegate to alarms
  async alarm() {
    await this.svc.alarms.alarm();
  }

  fetchDataSimple(url: string, reqId?: string): string {
    const finalReqId = proxyFetch(
      this,
      url,
      this.ctn().handleFetchComplete(this.ctn().$result, url),
      {},
      reqId
    );
    return finalReqId;
  }

  fetchDataSimpleWithOptions(
    url: string, 
    options: { timeout?: number; testMode?: { simulateDeliveryFailure?: boolean; alarmTimeoutOverride?: number } },
    reqId?: string
  ): string {
    // User just passes their continuation directly - no handleFetchResult() needed!
    const finalReqId = proxyFetch(
      this,
      url,
      this.ctn().handleFetchComplete(this.ctn().$result, url),
      options,
      reqId
    );
    return finalReqId;
  }

  fetchDataSimpleWithRequestSync(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: any },
    reqId?: string
  ): string {
    const request = new RequestSync(url, options);
    const finalReqId = proxyFetch(
      this,
      request,
      this.ctn().handleFetchComplete(this.ctn().$result, request.url),
      {},
      reqId
    );
    return finalReqId;
  }

  /**
   * User's handler - receives the result directly (either from worker or timeout)
   * This is the only method the user needs to implement
   */
  async handleFetchComplete(result: ResponseSync | Error, url: string): Promise<void> {
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

  wasNoop(reqId: string): boolean {
    return this.ctx.storage.kv.get(`__test_noop:${reqId}`) || false;
  }

  /**
   * Test helper: Trigger alarms manually
   */
  async triggerAlarmsHelper(count?: number): Promise<string[]> {
    return await this.svc.alarms.triggerAlarmsForTesting(count);
  }

  /**
   * Clear all results (for test cleanup)
   */
  clearResults(): void {
    const allKeys = this.ctx.storage.kv.list();
    for (const [key] of allKeys) {
      if (key.startsWith('__test_')) {
        this.ctx.storage.kv.delete(key);
      }
    }
  }

  // ============================================================================
  // Infrastructure Pattern Test Helpers (for Phase 2b)
  // ============================================================================

  /**
   * Pattern 1: Schedule alarm with explicit ID
   */
  scheduleWithExplicitId(reqId: string): string {
    const fireAt = new Date(Date.now() + 10000); // 10 seconds from now
    const continuation = this.ctn().handleTestAlarm(reqId);
    this.svc.alarms.schedule(fireAt, continuation, { id: reqId });
    return reqId;
  }

  /**
   * Pattern 2: Cancel and get schedule data atomically
   */
  cancelAndGetData(reqId: string): any {
    return this.svc.alarms.cancelSchedule(reqId);
  }

  /**
   * Get schedule by ID
   */
  getScheduleById(id: string): any {
    return this.svc.alarms.getSchedule(id);
  }

  /**
   * Pattern 3: Test continuation embedding
   */
  async testContinuationEmbedding(value: string): Promise<string> {
    const reqId = 'embed-' + crypto.randomUUID();
    const fireAt = new Date(Date.now() + 100); // 100ms from now
    
    // Create user continuation that stores the value
    const userContinuation = this.ctn().handleEmbedTest(value);
    
    // Preprocess it (simulate what proxyFetch does)
    const preprocessed = await preprocess(getOperationChain(userContinuation));
    
    // Create alarm handler that embeds the preprocessed continuation
    const alarmHandler = this.ctn().handleEmbedWrapper(preprocessed);
    
    this.svc.alarms.schedule(fireAt, alarmHandler, { id: reqId });
    return reqId;
  }

  /**
   * Wrapper handler that deserializes and executes embedded continuation
   */
  async handleEmbedWrapper(preprocessedContinuation: any): Promise<void> {
    const userContinuation = postprocess(preprocessedContinuation);
    await this.__executeChain(userContinuation);
  }

  /**
   * User handler that receives the value from embedded continuation
   */
  handleEmbedTest(value: string): void {
    this.ctx.storage.kv.put('__test_value:embed-test', value);
  }

  /**
   * Pattern 4: Test direct fetch to in-process endpoints
   */
  async testDirectFetch(url: string): Promise<{ status: number; json: any }> {
    const response = await fetch(url);
    const json = await response.json();
    return { status: response.status, json };
  }

  /**
   * Pattern 5: Test result filling with replaceNestedOperationMarkers
   */
  async testResultFilling(testValue: any): Promise<void> {
    // Create continuation with $result placeholder
    const continuation = this.ctn().handleResultTest(this.ctn().$result);
    
    // Fill $result with actual value (simulates worker pattern)
    const filled = await replaceNestedOperationMarkers(
      getOperationChain(continuation)!,  // Non-null assertion - continuation is always valid
      testValue
    );
    
    // Execute filled continuation
    await this.__executeChain(filled);
  }

  /**
   * Handler that receives the filled result
   */
  handleResultTest(result: any): void {
    this.ctx.storage.kv.put('__test_value:result-fill-test', JSON.stringify(result));
  }

  /**
   * Get stored value by key
   */
  getStoredValue(key: string): string | undefined {
    return this.ctx.storage.kv.get(`__test_value:${key}`);
  }

  /**
   * Get received value (for result filling test)
   */
  getReceivedValue(key: string): any {
    const stored = this.ctx.storage.kv.get<string>(`__test_value:${key}`);
    return stored ? JSON.parse(stored) : undefined;
  }

  /**
   * Handler for test alarms
   */
  handleTestAlarm(reqId: string): void {
    // Do nothing - just for testing scheduling
  }
}

// Export test DO
export { _TestSimpleDO as TestSimpleDO };

/**
 * Worker fetch handler that routes requests to test-endpoints-do
 */
import { routeDORequest } from '@lumenize/utils';

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    // Route test-endpoints requests to TEST_ENDPOINTS_DO
    const response = await routeDORequest(request, env);
    return response ?? new Response('Not Found', { status: 404 });
  }
};
