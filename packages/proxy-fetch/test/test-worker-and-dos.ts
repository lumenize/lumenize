import { DurableObject } from 'cloudflare:workers';
// @ts-expect-error For some reason this import is not always recognized
import { Env } from 'cloudflare:test';
import { proxyFetchHandler } from '../src/proxyFetchHandler';
import { proxyFetch } from '../src/proxyFetch';
import { proxyFetchQueueConsumer } from '../src/proxyFetchQueueConsumer';
import type { ProxyFetchHandlerItem } from '../src/types';

/**
 * Test Durable Object for proxy-fetch experiments
 */
export class ProxyFetchTestDO extends DurableObject<Env> {
  /**
   * Handler for successful proxy fetch responses
   */
  async handleSuccess({ reqId, response, error }: ProxyFetchHandlerItem): Promise<void> {
    if (error) {
      throw error;
    }
    if (!response) {
      throw new Error('Expected response but got none');
    }
    
    // Store response data for test verification
    const data = await response.json();
    this.ctx.storage.kv.put('last-response', JSON.stringify(data));
    this.ctx.storage.kv.put('last-req-id', reqId);
  }

  /**
   * Handler for error cases
   */
  async handleError({ reqId, response, error }: ProxyFetchHandlerItem): Promise<void> {
    // Store error for test verification
    if (error) {
      this.ctx.storage.kv.put('last-error', error.message);
    } else if (response) {
      this.ctx.storage.kv.put('last-response-status', response.status);
    }
    this.ctx.storage.kv.put('last-req-id', reqId);
  }

  /**
   * Trigger a proxy fetch
   */
  async triggerProxyFetch(urlOrRequest: string | Request, handlerName: string): Promise<void> {
    await proxyFetch(this, urlOrRequest, handlerName, 'PROXY_FETCH_TEST_DO');
  }

  /**
   * Get metadata for the most recent proxy fetch request
   */
  async getMetadata(): Promise<{ reqId: string } | null> {
    const keys = this.ctx.storage.kv.list({ prefix: 'proxy-fetch:' });
    for (const [key, value] of keys) {
      const reqId = key.replace('proxy-fetch:', '');
      return { reqId };
    }
    return null;
  }

  /**
   * RPC endpoint for queue consumer to deliver responses
   */
  async proxyFetchHandler(item: ProxyFetchHandlerItem): Promise<void> {
    return proxyFetchHandler(this, item);
  }

  /**
   * Get stored response data for test verification
   */
  async getLastResponse(): Promise<any> {
    const data = this.ctx.storage.kv.get('last-response') as string | null;
    return data ? JSON.parse(data) : null;
  }

  /**
   * Get stored error for test verification
   */
  async getLastError(): Promise<string | null> {
    return this.ctx.storage.kv.get('last-error') as string | null;
  }

  /**
   * Get last request ID for test verification
   */
  async getLastReqId(): Promise<string | null> {
    return this.ctx.storage.kv.get('last-req-id') as string | null;
  }
}

/**
 * Queue consumer for proxy-fetch
 */
export default {
  /**
   * HTTP fetch handler for live testing
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response('OK');
    }
    
    // Trigger a proxy fetch
    if (url.pathname === '/trigger-proxy-fetch' && request.method === 'POST') {
      const body = await request.json() as {
        doName: string;
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        handlerName: string;
      };
      
      const stub = env.PROXY_FETCH_TEST_DO.getByName(body.doName);
      
      // Create Request object
      const fetchRequest = new Request(body.url, {
        method: body.method || 'GET',
        headers: body.headers,
        body: body.body,
      });
      
      // Trigger proxy fetch
      await stub.triggerProxyFetch(fetchRequest, body.handlerName);
      
      // Get the reqId that was stored
      let reqId: string | null = null;
      const id = await stub.id;
      
      // Use runInDurableObject equivalent by calling a method
      const metadata = await stub.getMetadata();
      if (metadata) {
        reqId = metadata.reqId;
      }
      
      return new Response(JSON.stringify({ reqId }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // Check result
    if (url.pathname === '/check-result' && request.method === 'POST') {
      const body = await request.json() as { doName: string };
      const stub = env.PROXY_FETCH_TEST_DO.getByName(body.doName);
      const response = await stub.getLastResponse();
      
      return new Response(JSON.stringify({ response }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // Check error
    if (url.pathname === '/check-error' && request.method === 'POST') {
      const body = await request.json() as { doName: string };
      const stub = env.PROXY_FETCH_TEST_DO.getByName(body.doName);
      const error = await stub.getLastError();
      
      return new Response(JSON.stringify({ error }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    return new Response('Not Found', { status: 404 });
  },
  
  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    console.log('=== Queue Consumer Received ===');
    console.log('Batch size:', batch.messages.length);
    await proxyFetchQueueConsumer(batch, env);
    console.log('=== Queue Consumer Complete ===\n');
  }
};
