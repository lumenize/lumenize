import { DurableObject } from 'cloudflare:workers';
import { ProxyFetchDO as _ProxyFetchDO } from '../../src/ProxyFetchDurableObject';
import { proxyFetch, proxyFetchQueue } from '../../src/proxyFetch';
import type { ProxyFetchHandlerItem } from '../../src/types';
import { createTestEndpoints } from '@lumenize/test-endpoints';
import { instrumentDOProject } from '@lumenize/testing';
import { sendDownstream } from '@lumenize/rpc';

// Re-export the base DO classes for typing in tests
export { _ProxyFetchDO };

/**
 * _TestDO - Test DO for integration testing
 * 
 * This follows the pedagogical pattern from the docs - uses proxyFetch() 
 * which auto-detects DO vs Queue variant based on environment bindings.
 */
export class _TestDO extends DurableObject {
  #results: Map<string, any> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /**
   * Business logic that needs to call external API - uses proxyFetch() auto-detect
   */
  async myBusinessProcess(url: string, handler?: keyof this & string, options?: any, proxyInstanceNameOrId?: string): Promise<string> {
    // Uses proxyFetch() which auto-detects DO vs Queue variant
    const reqId = await proxyFetch(
      this,                                      // DO instance
      url,                                       // URL or Request object
      'TEST_DO',                                 // DO binding name
      handler,                                   // Handler method name (optional for fire-and-forget)
      options,                                   // Options (optional)
      proxyInstanceNameOrId || 'proxy-fetch-global'  // ProxyFetch DO instance name or 64-char hex ID (defaults to global)
    );
    return reqId;
  }

  /**
   * Response handler - called when response arrives
   */
  async handleSuccess({ response, error, reqId, retryCount, duration }: ProxyFetchHandlerItem): Promise<void> {
    console.log('_TestDO.handleSuccess:', reqId);
    if (error) {
      console.error('Unexpected error in handleSuccess:', error);
      this.#results.set(reqId, { success: false, item: { reqId, error, retryCount, duration } });
      await this.#broadcastToAllClients({ reqId, success: false, error, retryCount, duration });
      return;
    }
    
    // Store successful result
    this.#results.set(reqId, { 
      success: true, 
      item: { reqId, response, retryCount, duration } 
    });
    
    // Also send downstream to connected RPC clients
    await this.#broadcastToAllClients({ reqId, success: true, response, retryCount, duration });
  }

  /**
   * Broadcast a message to all connected RPC clients
   */
  async #broadcastToAllClients(payload: any): Promise<void> {
    // Get all WebSocket connections (no tag = all connections)
    const allConnections = this.ctx.getWebSockets();
    
    if (allConnections.length === 0) {
      return;
    }
    
    // Get all unique client IDs from connection tags
    const clientIds = new Set<string>();
    for (const ws of allConnections) {
      const tags = this.ctx.getTags(ws);
      for (const tag of tags) {
        clientIds.add(tag);
      }
    }
    
    // Send to each client ID
    if (clientIds.size > 0) {
      await sendDownstream(Array.from(clientIds), this, payload);
    }
  }

  /**
   * Error handler - called when fetch fails or returns error status
   */
  async handleError({ response, error, reqId, retryCount, duration }: ProxyFetchHandlerItem): Promise<void> {
    console.log('_TestDO.handleError:', reqId);
    this.#results.set(reqId, { 
      success: false, 
      item: { reqId, response, error, retryCount, duration } 
    });
    
    // Also send downstream to connected RPC clients
    await this.#broadcastToAllClients({ reqId, success: false, response, error, retryCount, duration });
  }

  /**
   * Test helper: Get stored result
   */
  async getResult(reqId: string): Promise<any> {
    return this.#results.get(reqId);
  }

  /**
   * Test helper: Trigger proxyFetch with invalid handler to test validation
   */
  async triggerInvalidHandler(): Promise<void> {
    const TEST_ENDPOINTS = createTestEndpoints(this.env.TEST_TOKEN, this.env.TEST_ENDPOINTS_URL, 'test-worker');
    await proxyFetch(
      this,
      TEST_ENDPOINTS.buildUrl('/uuid'),
      'TEST_DO',
      'nonExistentHandler' as any // Intentionally invalid for testing runtime error handling
    );
  }

  /**
   * Test helper: Trigger proxyFetchQueue with invalid handler to test validation
   * Note: Directly calls proxyFetchQueue() to test Queue variant validation
   */
  async triggerInvalidHandlerQueue(): Promise<void> {
    // Directly call proxyFetchQueue to test Queue variant handler validation
    const TEST_ENDPOINTS = createTestEndpoints(this.env.TEST_TOKEN, this.env.TEST_ENDPOINTS_URL, 'test-worker');
    await proxyFetchQueue(
      this,
      TEST_ENDPOINTS.buildUrl('/uuid'),
      'TEST_DO',
      'anotherNonExistentHandler' as any // Intentionally invalid for testing runtime error handling
    );
  }

  /**
   * Test helper: Reset state
   */
  async reset(): Promise<void> {
    this.#results.clear();
  }
}

// Use instrumentDOProject to wrap both DOs with RPC and create worker
const instrumented = instrumentDOProject({
  sourceModule: { ProxyFetchDO: _ProxyFetchDO, TestDO: _TestDO },
  doClassNames: ['ProxyFetchDO', 'TestDO']
});

export const { ProxyFetchDO, TestDO } = instrumented.dos;
export default instrumented.worker;
