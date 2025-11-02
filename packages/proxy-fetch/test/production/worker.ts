/**
 * Production test Worker for @lumenize/proxy-fetch
 * 
 * This Worker demonstrates real-world usage of proxy-fetch and provides
 * endpoints for testing the deployed package in production.
 */

import { DurableObject } from 'cloudflare:workers';
import { ProxyFetchDO } from '../../src/ProxyFetchDurableObject';
import { proxyFetchDO } from '../../src/proxyFetch';
import { decodeResponse } from '@lumenize/structured-clone';

// Re-export ProxyFetchDO so it's available to wrangler
export { ProxyFetchDO };

/**
 * Test DO that uses ProxyFetchDO to make external requests
 */
export class TestDO extends DurableObject {
  #successResults: Map<string, any> = new Map();
  #errorResults: Map<string, any> = new Map();

  async handleSuccess(item: any): Promise<void> {
    console.log(`TestDO.handleSuccess: ${item.reqId}`, { 
      status: item.response?.status,
      hasResponse: !!item.response 
    });
    
    // Deserialize response and read body
    const response = item.response ? await decodeResponse(item.response) : null;
    const body = response ? await response.json() : null;
    
    this.#successResults.set(item.reqId, { response: item.response, body });
  }

  async handleError(item: any): Promise<void> {
    console.log(`TestDO.handleError: ${item.reqId}`, { 
      status: item.response?.status, 
      error: item.error?.message 
    });
    this.#errorResults.set(item.reqId, { response: item.response, error: item.error });
  }

  async fetchWithCallback(url: string): Promise<string> {
    const reqId = await proxyFetchDO(this, url, 'TEST_DO', 'handleSuccess');
    return reqId;
  }

  async fetchWithCallbackAndRetry(url: string): Promise<string> {
    const reqId = await proxyFetchDO(
      this,
      url,
      'TEST_DO',
      'handleSuccess',
      {
        maxRetries: 2,
        retryDelay: 100,
      }
    );
    return reqId;
  }

  async fetchFireAndForget(url: string): Promise<string> {
    const reqId = await proxyFetchDO(this, url, 'TEST_DO');
    return reqId;
  }

  getResult(reqId: string): any {
    if (this.#successResults.has(reqId)) {
      return { type: 'success', ...this.#successResults.get(reqId) };
    }
    if (this.#errorResults.has(reqId)) {
      return { type: 'error', ...this.#errorResults.get(reqId) };
    }
    return { type: 'pending' };
  }

  clearResults(): void {
    this.#successResults.clear();
    this.#errorResults.clear();
  }
}

/**
 * Worker fetch handler - routes requests to test endpoints
 */
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    
    try {
      // GET /uuid - Fetch a UUID via proxy-fetch with callback
      if (url.pathname === '/uuid') {
        const testDO = env.TEST_DO.get(env.TEST_DO.idFromName('test'));
        const reqId = await testDO.fetchWithCallback(
          `${env.TEST_ENDPOINTS_URL}/uuid?token=${env.TEST_TOKEN || 'test'}`
        );
        
        return new Response(JSON.stringify({ 
          reqId, 
          message: 'Request queued, callback will be invoked' 
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // GET /uuid-retry - Fetch with retry logic
      if (url.pathname === '/uuid-retry') {
        const testDO = env.TEST_DO.get(env.TEST_DO.idFromName('test'));
        const reqId = await testDO.fetchWithCallbackAndRetry(
          `${env.TEST_ENDPOINTS_URL}/uuid?token=${env.TEST_TOKEN || 'test'}`
        );
        
        return new Response(JSON.stringify({ 
          reqId, 
          message: 'Request queued with retry, callback will be invoked' 
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // GET /fire-and-forget - No callback
      if (url.pathname === '/fire-and-forget') {
        const testDO = env.TEST_DO.get(env.TEST_DO.idFromName('test'));
        const reqId = await testDO.fetchFireAndForget(
          `${env.TEST_ENDPOINTS_URL}/uuid?token=${env.TEST_TOKEN || 'test'}`
        );
        
        return new Response(JSON.stringify({ 
          reqId, 
          message: 'Fire-and-forget request queued' 
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // GET /result/:reqId - Get callback result
      if (url.pathname.startsWith('/result/')) {
        const reqId = url.pathname.split('/')[2];
        const testDO = env.TEST_DO.get(env.TEST_DO.idFromName('test'));
        const result = await testDO.getResult(reqId);
        
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // POST /clear - Clear all results
      if (url.pathname === '/clear' && request.method === 'POST') {
        const testDO = env.TEST_DO.get(env.TEST_DO.idFromName('test'));
        await testDO.clearResults();
        
        return new Response(JSON.stringify({ message: 'Results cleared' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // GET / - Health check
      if (url.pathname === '/') {
        return new Response(JSON.stringify({ 
        status: 'ok',
        service: 'proxy-fetch-live-test',
        endpoints: [
            'GET /uuid - Fetch UUID with callback',
            'GET /uuid-retry - Fetch UUID with retry',
            'GET /fire-and-forget - Fire-and-forget fetch',
            'GET /result/:reqId - Get callback result',
            'POST /clear - Clear all results'
          ]
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (error: any) {
      return new Response(JSON.stringify({ 
        error: error.message,
        stack: error.stack 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
