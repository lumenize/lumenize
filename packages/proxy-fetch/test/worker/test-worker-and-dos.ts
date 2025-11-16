/**
 * Test Worker and DOs for proxyFetch integration testing
 */

import '@lumenize/proxy-fetch'; // Import to register result handler
import { LumenizeBase } from '@lumenize/lumenize-base';
import { FetchOrchestrator as _FetchOrchestrator, FetchExecutorEntrypoint } from '../../src/index';
import { proxyFetch } from '../../src/index';
import { instrumentDOProject } from '@lumenize/testing';
import { sendDownstream } from '@lumenize/rpc';

// Re-export for typing
export { _FetchOrchestrator };
export { FetchExecutorEntrypoint };

/**
 * TestDO - Origin DO that uses proxyFetch
 * 
 * Uses LumenizeBase and OCAN continuations like modern Lumenize patterns.
 */
export class _TestDO extends LumenizeBase {
  #results: Map<string, any> = new Map();
  #latencyMeasurements: Array<{ reqId: string; startTime: number; endTime: number; duration: number }> = [];

  /**
   * Make a fetch request using proxyFetch
   */
  async fetchData(url: string): Promise<string> {
    const startTime = Date.now();
    
    // Store startTime BEFORE making the call (use temp key)
    const tempKey = `temp_start:${Date.now()}`;
    this.ctx.storage.kv.put(tempKey, { startTime });
    
    const reqId = await proxyFetch(
      this,
      url,
      // Continuation receives result as first parameter by convention
      this.ctn().handleFetchResult(),
      { originBinding: 'TEST_DO' }
    );
    
    // Move temp data to reqId key
    const tempData = this.ctx.storage.kv.get(tempKey);
    if (tempData) {
      this.ctx.storage.kv.put(`latency:${reqId}`, { startTime, reqId });
      this.ctx.storage.kv.delete(tempKey);
    }
    
    return reqId;
  }

  /**
   * Handler that receives Response | Error
   * 
   * Retrieves reqId from temporary storage (set by fetchWorkerResultHandler)
   */
  async handleFetchResult(result: Response | Error) {
    const endTime = Date.now();
    
    // Get reqId from temporary storage (set by fetchWorkerResultHandler)
    const reqId = (this.ctx.storage.kv.get('__lmz_proxyfetch_result_reqid') as string) || `unknown-${Date.now()}`;
    
    // Get startTime from stored latency data
    let startTime = endTime; // Fallback
    const latencyData = this.ctx.storage.kv.get(`latency:${reqId}`) as { startTime: number; reqId: string } | undefined;
    if (latencyData) {
      startTime = latencyData.startTime;
    }
    
    const duration = endTime - startTime;
    
    if (result instanceof Error) {
      this.#results.set(reqId, {
        success: false,
        error: result,
        duration
      });
      
      await this.#broadcastToAllClients({ reqId, success: false, error: result.message, duration });
    } else {
      
      // Read response body for storage
      const responseText = await result.text();
      
      this.#results.set(reqId, {
        success: true,
        response: result,
        responseText,
        status: result.status,
        duration
      });
      
      await this.#broadcastToAllClients({ reqId, success: true, status: result.status, duration });
    }
    
    // Track latency
    this.#latencyMeasurements.push({ reqId, startTime, endTime, duration });
    
    // Clean up latency tracking
    this.ctx.storage.kv.delete(`latency:${reqId}`);
  }

  /**
   * Test helper: Fetch with custom options (for testing error cases)
   */
  async fetchDataWithOptions(url: string, options: any): Promise<string> {
    const startTime = Date.now();
    const tempKey = `latency:temp:${startTime}`;
    this.ctx.storage.kv.put(tempKey, { startTime });
    
    const reqId = await proxyFetch(
      this,
      url,
      this.ctn().handleFetchResult(),
      options
    );
    
    // Move temp data to reqId key
    const tempData = this.ctx.storage.kv.get(tempKey);
    if (tempData) {
      this.ctx.storage.kv.put(`latency:${reqId}`, { startTime, reqId });
      this.ctx.storage.kv.delete(tempKey);
    }
    
    return reqId;
  }

  /**
   * Test helper: Get result
   */
  async getResult(reqId: string): Promise<any> {
    return this.#results.get(reqId);
  }

  /**
   * Test helper: Get all latency measurements
   */
  async getLatencyMeasurements(): Promise<Array<{ reqId: string; startTime: number; endTime: number; duration: number }>> {
    return this.#latencyMeasurements;
  }

  /**
   * Test helper: Reset state
   */
  async reset(): Promise<void> {
    this.#results.clear();
    this.#latencyMeasurements = [];
  }

  /**
   * Test helper: Call proxyFetch with invalid continuation
   */
  async callProxyFetchWithInvalidContinuation(url: string): Promise<string> {
    // Pass a non-OCAN continuation (just a string)
    return await proxyFetch(
      this,
      url,
      'not-an-ocan-continuation' as any,
      { originBinding: 'TEST_DO' }
    );
  }

  /**
   * Test helper: Call proxyFetch with broken env (no FETCH_ORCHESTRATOR)
   */
  async callProxyFetchWithBrokenEnv(url: string): Promise<string> {
    // Create a broken DO instance that's missing FETCH_ORCHESTRATOR
    const brokenInstance = {
      ctx: this.ctx,
      env: {}, // Empty env without FETCH_ORCHESTRATOR
      constructor: { name: 'TestDO' }
    };
    
    return await proxyFetch(
      brokenInstance as any,
      url,
      this.ctn().handleFetchResult(),
      { originBinding: 'TEST_DO' }
    );
  }

  /**
   * Test helper: Call proxyFetch with string URL
   */
  async callProxyFetchWithStringUrl(url: string): Promise<string> {
    // Pass string URL instead of Request object
    return await proxyFetch(
      this,
      url, // String, not Request
      this.ctn().handleFetchResult(),
      { originBinding: 'TEST_DO' }
    );
  }

  /**
   * Test helper: Call proxyFetch without originBinding
   */
  async callProxyFetchWithoutOriginBinding(url: string): Promise<string> {
    // Omit originBinding to trigger getOriginBinding
    return await proxyFetch(
      this,
      url,
      this.ctn().handleFetchResult()
      // No options, so originBinding will be inferred
    );
  }

  /**
   * Test helper: Delete pending continuation for a request
   */
  async deletePendingContinuation(reqId: string): Promise<void> {
    const pendingKey = `__lmz_proxyfetch_pending:${reqId}`;
    this.ctx.storage.kv.delete(pendingKey);
  }

  /**
   * Test helper: Simulate result with missing pending continuation
   */
  async simulateMissingContinuation(reqId: string): Promise<void> {
    // Import the result handler
    const { fetchWorkerResultHandler } = await import('../../src/fetchWorkerResultHandler');
    
    // DON'T store a pending continuation - that's the point of this test
    
    // Send a valid result (but there's no pending continuation to execute)
    const fakeResult = {
      reqId,
      response: {}, // Fake Response object
      retryCount: 0,
      duration: 0
    };
    
    const preprocessed = await (await import('@lumenize/structured-clone')).preprocess(fakeResult);
    await fetchWorkerResultHandler(this, reqId, preprocessed);
  }

  /**
   * Test helper: Simulate malformed fetch result
   */
  async simulateMalformedResult(): Promise<string> {
    // Import dependencies
    const { getOperationChain } = await import('@lumenize/lumenize-base');
    const { preprocess } = await import('@lumenize/structured-clone');
    const { fetchWorkerResultHandler } = await import('../../src/fetchWorkerResultHandler');
    
    // Generate a unique reqId
    const reqId = `malformed-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    // Store a pending continuation
    const pendingKey = `__lmz_proxyfetch_pending:${reqId}`;
    const continuation = this.ctn().handleFetchResult();
    const continuationChain = getOperationChain(continuation);
    const preprocessed = await preprocess(continuationChain);
    
    this.ctx.storage.kv.put(pendingKey, {
      reqId,
      continuationChain: preprocessed,
      timestamp: Date.now()
    });
    
    // Send malformed result (missing both response and error)
    const malformedResult = {
      reqId,
      // No response field
      // No error field  
      retryCount: 0,
      duration: 0
    };
    
    const preprocessedResult = await preprocess(malformedResult);
    
    // Call the handler (it will create an Error for malformed result)
    await fetchWorkerResultHandler(this, reqId, preprocessedResult);
    
    return reqId;
  }

  /**
   * Test helper: Make a fetch with a throwing handler
   */
  async fetchDataWithThrowingHandler(url: string): Promise<string> {
    const reqId = await proxyFetch(
      this,
      url,
      this.ctn().throwingHandler(),
      { originBinding: 'TEST_DO' }
    );
    
    return reqId;
  }

  /**
   * Handler that always throws (for testing error handling)
   */
  throwingHandler(_result: Response | Error): void {
    throw new Error('Intentional test error in continuation handler');
  }

  /**
   * Broadcast to all connected RPC clients
   */
  async #broadcastToAllClients(payload: any): Promise<void> {
    const allConnections = this.ctx.getWebSockets();
    
    if (allConnections.length === 0) {
      return;
    }
    
    const clientIds = new Set<string>();
    for (const ws of allConnections) {
      const tags = this.ctx.getTags(ws);
      for (const tag of tags) {
        clientIds.add(tag);
      }
    }
    
    if (clientIds.size > 0) {
      await sendDownstream(Array.from(clientIds), this, payload);
    }
  }
}

// Instrument DOs with RPC
const instrumented = instrumentDOProject({
  sourceModule: { FetchOrchestrator: _FetchOrchestrator, TestDO: _TestDO },
  doClassNames: ['FetchOrchestrator', 'TestDO']
});

export const FetchOrchestrator = instrumented.FetchOrchestrator;
export const TestDO = instrumented.TestDO;

/**
 * Worker export - uses instrumented routing
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return instrumented.fetch(request, env);
  }
}

