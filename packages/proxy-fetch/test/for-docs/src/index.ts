import { DurableObject } from 'cloudflare:workers';
import { ProxyFetchDO } from '@lumenize/proxy-fetch';
import { proxyFetch } from '@lumenize/proxy-fetch';
import type { ProxyFetchHandlerItem } from '@lumenize/proxy-fetch';

// Re-export ProxyFetchDO - required for the binding to work
export { ProxyFetchDO };

/**
 * Your Durable Object that uses proxy-fetch
 */
export class MyDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /**
   * Your business logic that needs to call external API
   */
  async myBusinessProcess(): Promise<string> {
    // Send to ProxyFetchDO - returns reqId immediately
    const reqId = await proxyFetch(
      this,                    // DO instance
      `${this.env.TEST_ENDPOINTS_URL}/uuid?token=${this.env.TEST_TOKEN}`,
      'MY_DO',                 // DO binding name
      'myResponseHandler'      // Handler method name
    );
    
    // Response will arrive later via myResponseHandler()
    return reqId;
  }

  /**
   * Your response handler - called when response arrives
   */
  async myResponseHandler({
    response,
    error,
    reqId 
  }: ProxyFetchHandlerItem): Promise<void> {
    if (error) {
      console.error('Fetch failed:', error);
      this.ctx.storage.kv.put('last-error', error.message);
      return;
    }
    
    // Store success - response was received
    this.ctx.storage.kv.put('callback-received', reqId);
  }

  /**
   * Test helper to verify callback was received
   */
  async getCallbackReceived(): Promise<string | null> {
    return this.ctx.storage.kv.get('callback-received') as string | null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return new Response('OK');
  }
} satisfies ExportedHandler<Env>;
