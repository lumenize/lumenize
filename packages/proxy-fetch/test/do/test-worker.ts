import { DurableObject } from 'cloudflare:workers';
import { ProxyFetchDO as _ProxyFetchDO } from '../../src/ProxyFetchDurableObject';
import { proxyFetch, proxyFetchQueue } from '../../src/proxyFetch';
import type { ProxyFetchHandlerItem } from '../../src/types';
import { instrumentDOProject } from '@lumenize/testing';

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
  async myBusinessProcess(url: string, handler?: string, options?: any): Promise<string> {
    // Uses proxyFetch() which auto-detects DO vs Queue variant
    const reqId = await proxyFetch(
      this,         // DO instance
      url,          // URL or Request object
      'TEST_DO',    // DO binding name
      handler,      // Handler method name (optional for fire-and-forget)
      options       // Options (optional)
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
      return;
    }
    
    // Store successful result
    this.#results.set(reqId, { 
      success: true, 
      item: { reqId, response, retryCount, duration } 
    });
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
    await proxyFetch(
      this,
      'https://test-endpoints.transformation.workers.dev/uuid?token=1f52af06-7f0b-4822-8eb3-e5859a9c0226',
      'TEST_DO',
      'nonExistentHandler' // This handler doesn't exist
    );
  }

  /**
   * Test helper: Trigger proxyFetchQueue with invalid handler to test validation
   * Note: Directly calls proxyFetchQueue() to test Queue variant validation
   */
  async triggerInvalidHandlerQueue(): Promise<void> {
    // Directly call proxyFetchQueue to test Queue variant handler validation
    await proxyFetchQueue(
      this,
      'https://test-endpoints.transformation.workers.dev/uuid?token=1f52af06-7f0b-4822-8eb3-e5859a9c0226',
      'TEST_DO',
      'anotherNonExistentHandler' // This handler doesn't exist
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
