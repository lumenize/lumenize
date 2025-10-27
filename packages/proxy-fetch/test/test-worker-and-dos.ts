import { DurableObject } from 'cloudflare:workers';
// @ts-expect-error For some reason this import is not always recognized
import { Env } from 'cloudflare:test';
import { proxyFetchHandler } from '../src/proxyFetchHandler';
import { proxyFetch } from '../src/proxyFetch';
import { proxyFetchQueueConsumer } from '../src/proxyFetchQueueConsumer';
import type { ProxyFetchHandlerItem } from '../src/types';

/**
 * Test Durable Object for proxy-fetch
 * 
 * This is the pedagogical example from the docs!
 */
export class MyDO extends DurableObject<Env> {
  /**
   * Your business logic that needs to call external API
   */
  async myBusinessProcess(): Promise<void> {
    // Send to queue - returns immediately, DO can hibernate
    await proxyFetch(
      this,                    // DO instance
      'https://api.example.com/data',  // URL or Request object
      'myResponseHandler',         // Handler method name
      'MY_DO'                  // DO binding name
    );
    
    // Function returns immediately!
    // Response will arrive later via myResponseHandler()
  }

  /**
   * Your response handler - called when response arrives
   */
  async myResponseHandler({ response, error }: ProxyFetchHandlerItem): Promise<void> {
    if (error) {
      console.error('Fetch failed:', error);
      this.ctx.storage.kv.put('last-error', error.message);
      return;
    }
    
    // Process the response
    const data = await response!.json();
    // Store it, process it, whatever your business logic needs
    this.ctx.storage.kv.put('api-data', JSON.stringify(data));
    
    // Also store for test verification
    this.ctx.storage.kv.put('last-response', JSON.stringify(data));
  }

  /**
   * Required: Receive responses from queue worker
   */
  async proxyFetchHandler(item: ProxyFetchHandlerItem): Promise<void> {
    return proxyFetchHandler(this, item);
  }
  
  // ========== Test helper methods below ==========
  
  /**
   * Handler for successful responses (for tests)
   */
  async handleSuccess({ response, error, reqId }: ProxyFetchHandlerItem): Promise<void> {
    if (error) {
      console.error('Fetch failed:', error);
      this.ctx.storage.kv.put('last-error', error.message);
      return;
    }
    
    // Process the response
    const data = await response!.json();
    // Store for test verification
    this.ctx.storage.kv.put('last-response', JSON.stringify(data));
    this.ctx.storage.kv.put('last-req-id', reqId);
  }
  
  /**
   * Handler for error cases (for tests)
   */
  async handleError({ response, error }: ProxyFetchHandlerItem): Promise<void> {
    if (error) {
      console.error('Fetch failed:', error);
      this.ctx.storage.kv.put('last-error', error.message);
      return;
    }
    
    // Check HTTP status for non-OK responses
    if (response && !response.ok) {
      console.error('HTTP error:', response.status, response.statusText);
      this.ctx.storage.kv.put('last-response-status', response.status);
    }
  }

  /**
   * Trigger a proxy fetch (for HTTP endpoint testing)
   */
  async triggerProxyFetch(urlOrRequest: string | Request, handlerName: string): Promise<void> {
    await proxyFetch(this, urlOrRequest, handlerName, 'MY_DO');
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
 * Worker with queue consumer
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
      
      const stub = env.MY_DO.getByName(body.doName);
      
      // Create Request object
      const fetchRequest = new Request(body.url, {
        method: body.method || 'GET',
        headers: body.headers,
        body: body.body,
      });
      
      // Trigger proxy fetch
      await stub.triggerProxyFetch(fetchRequest, body.handlerName);
      
      // Get the reqId that was stored
      const metadata = await stub.getMetadata();
      const reqId = metadata?.reqId ?? null;
      
      return new Response(JSON.stringify({ reqId }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // Check result
    if (url.pathname === '/check-result' && request.method === 'POST') {
      const body = await request.json() as { doName: string };
      const stub = env.MY_DO.getByName(body.doName);
      const response = await stub.getLastResponse();
      
      return new Response(JSON.stringify({ response }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // Check error
    if (url.pathname === '/check-error' && request.method === 'POST') {
      const body = await request.json() as { doName: string };
      const stub = env.MY_DO.getByName(body.doName);
      const error = await stub.getLastError();
      
      return new Response(JSON.stringify({ error }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    return new Response('Not Found', { status: 404 });
  },
  
  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    await proxyFetchQueueConsumer(batch, env);
  }
} satisfies ExportedHandler<Env>;
