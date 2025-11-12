/**
 * Test Worker and DOs for proxyFetchWorker integration testing
 */

import '@lumenize/proxy-fetch'; // Import to register result handler
import { LumenizeBase } from '@lumenize/lumenize-base';
import { FetchOrchestrator as _FetchOrchestrator } from '../../src/FetchOrchestrator';
import { proxyFetchWorker } from '../../src/proxyFetchWorker';
import { executeFetch } from '../../src/workerFetchExecutor';
import { instrumentDOProject } from '@lumenize/testing';
import { sendDownstream } from '@lumenize/rpc';

// Re-export for typing
export { _FetchOrchestrator };

/**
 * TestDO - Origin DO that uses proxyFetchWorker
 * 
 * Uses LumenizeBase and OCAN continuations like modern Lumenize patterns.
 */
export class _TestDO extends LumenizeBase {
  #results: Map<string, any> = new Map();
  #latencyMeasurements: Array<{ reqId: string; startTime: number; endTime: number; duration: number }> = [];

  /**
   * Make a fetch request using proxyFetchWorker
   */
  async fetchData(url: string): Promise<string> {
    const startTime = Date.now();
    
    const reqId = await proxyFetchWorker(
      this,
      url,
      // Pass reqId and startTime as context through the continuation
      this.ctn().handleFetchResult(this.ctn().$result, reqId, startTime),
      { originBinding: 'TEST_DO' }
    );
    
    // Store startTime for latency tracking
    this.ctx.storage.kv.put(`latency:${reqId}`, JSON.stringify({ startTime, reqId }));
    
    return reqId;
  }

  /**
   * Handler that receives Response | Error
   * 
   * Note: reqId parameter will be undefined until we fix the placeholder injection
   * For now, we'll retrieve it from storage
   */
  async handleFetchResult(result: Response | Error, reqId?: string, startTimeParam?: number) {
    const endTime = Date.now();
    
    // If reqId not provided (placeholder injection issue), try to find it
    if (!reqId) {
      // TODO: Improve placeholder injection to pass reqId
      // For now, we'll need to find the pending request
      const keys = [...this.ctx.storage.kv.list({ prefix: 'latency:' })];
      if (keys.length > 0) {
        const latencyKey = keys[keys.length - 1][0]; // Get most recent
        reqId = latencyKey.substring('latency:'.length);
      } else {
        reqId = `unknown-${Date.now()}`;
      }
    }
    
    // Get startTime from storage if not provided
    let startTime = startTimeParam;
    if (!startTime) {
      const latencyData = this.ctx.storage.kv.get(`latency:${reqId}`);
      if (latencyData) {
        const parsed = JSON.parse(latencyData as string);
        startTime = parsed.startTime;
      } else {
        startTime = endTime; // Fallback
      }
    }
    
    const duration = endTime - startTime;
    
    if (result instanceof Error) {
      console.error(`[${reqId}] Fetch failed:`, result.message);
      this.#results.set(reqId, {
        success: false,
        error: result,
        duration
      });
      
      await this.#broadcastToAllClients({ reqId, success: false, error: result.message, duration });
    } else {
      console.log(`[${reqId}] Fetch succeeded:`, result.status);
      
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
 * Worker export - handles fetch execution
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return instrumented.fetch(request, env);
  },

  /**
   * RPC method for executing fetches
   * 
   * Called by FetchOrchestrator to execute fetches with CPU billing.
   */
  async executeFetch(message: any, env: Env): Promise<void> {
    return await executeFetch(message, env);
  }
} satisfies ExportedHandler<Env>;

