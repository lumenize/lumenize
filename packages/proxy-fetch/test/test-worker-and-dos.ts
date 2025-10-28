import { DurableObject } from 'cloudflare:workers';
// @ts-expect-error For some reason this import is not always recognized
import { Env } from 'cloudflare:test';
import { proxyFetch } from '@lumenize/proxy-fetch';
import { proxyFetchQueueConsumer } from '@lumenize/proxy-fetch';
import type { ProxyFetchHandlerItem } from '@lumenize/proxy-fetch';

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
    // Send to queue - returns reqId, DO wall clock billing stops
    const reqId = await proxyFetch(
      this,                    // DO instance
      'https://api.example.com/data',  // URL or Request object
      'MY_DO',                 // DO binding name
      'myResponseHandler'      // Handler method name (optional for fire-and-forget)
    );
    
    // Response will arrive later via myResponseHandler()
  }

  /**
   * Your response handler - called when response arrives
   */
  async myResponseHandler({ response, error, reqId }: ProxyFetchHandlerItem): Promise<void> {
    if (error) {
      console.error('Fetch failed:', error);
      return;
    }
    
    // Process the response
    const data = await response!.json();
    // Store it, process it, whatever your business logic needs
    this.ctx.storage.kv.put('api-data', data);
  }
  
  // No proxyFetchHandler method needed! Handlers called directly via RPC.
  
  // ========== Test helper methods below ==========
  
  /**
   * Example: Using reqId to correlate with stored context
   */
  async fetchUserWithContext(userId: string): Promise<void> {
    const reqId = await proxyFetch(
      this,
      `https://api.example.com/users/${userId}`,
      'MY_DO',
      'handleUserWithContext'
    );
    
    // Store context associated with this specific request
    this.ctx.storage.kv.put(`context:${reqId}`, {
      userId,
      requestedAt: Date.now(),
      source: 'user-sync'
    });
  }
  
  /**
   * Handler that retrieves context using reqId
   */
  async handleUserWithContext({ response, error, reqId }: ProxyFetchHandlerItem): Promise<void> {
    // Retrieve the context we stored using reqId
    const context = this.ctx.storage.kv.get(`context:${reqId}`) as { userId: string; requestedAt: number; source: string } | null;
    if (!context) {
      console.error(`No context found for reqId: ${reqId}`);
      return;
    }
    
    if (error) {
      console.error(`[${reqId}] Fetch failed for user ${context.userId}:`, error);
      // Store error with context
      this.ctx.storage.kv.put(`error:${context.userId}`, {
        error: error.message,
        reqId,
        context
      });
      // Clean up context
      this.ctx.storage.kv.delete(`context:${reqId}`);
      return;
    }
    
    const userData = await response!.json();
    console.log(`[${reqId}] Processed user ${context.userId} in ${Date.now() - context.requestedAt}ms`);
    
    // Store result with both API data and our context
    this.ctx.storage.kv.put(`user:${context.userId}`, {
      userData,
      fetchedFrom: context.source,
      reqId
    });
    
    // Clean up context now that we're done
    this.ctx.storage.kv.delete(`context:${reqId}`);
  }
  
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
    this.ctx.storage.kv.put('last-response', data);
    this.ctx.storage.kv.put('last-req-id', reqId);
  }
  
  /**
   * Handler for error cases (for tests)
   */
  async handleError({ response, error, reqId }: ProxyFetchHandlerItem): Promise<void> {
    if (error) {
      console.error('Fetch failed:', error);
      this.ctx.storage.kv.put('last-error', error.message);
      return;
    }
    
    // Check HTTP status for non-OK responses
    if (response && !response.ok) {
      console.error('HTTP error:', response.status, response.statusText);
      this.ctx.storage.kv.put('last-response-status', response.status);
      return;
    }
    
    // Store successful responses too (for test verification)
    if (response && response.ok) {
      const data = await response.json();
      this.ctx.storage.kv.put('last-response', data);
      this.ctx.storage.kv.put('last-req-id', reqId);
    }
  }

  /**
   * Trigger a proxy fetch (for HTTP endpoint testing)
   */
  async triggerProxyFetch(urlOrRequest: string | Request, handlerName: string): Promise<string> {
    const reqId = await proxyFetch(this, urlOrRequest, 'MY_DO', handlerName);
    // Store reqId for live tests
    this.ctx.storage.kv.put('last-req-id', reqId);
    return reqId;
  }

  /**
   * Get stored response data for test verification
   */
  async getLastResponse(): Promise<any> {
    return this.ctx.storage.kv.get('last-response');
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
      const reqId = await stub.triggerProxyFetch(fetchRequest, body.handlerName);
      
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
  
  // Required boilerplate
  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    await proxyFetchQueueConsumer(batch, env);
  }
} satisfies ExportedHandler<Env>;
