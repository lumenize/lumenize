/**
 * Test Endpoints Durable Object
 * 
 * Provides httpbin.org-like endpoints with built-in request/response tracking.
 * Each test gets its own isolated DO instance via routeDORequest.
 */

import { DurableObject } from 'cloudflare:workers';
import { encodeRequest, encodeResponse } from '@lumenize/structured-clone';

interface Env {
  TEST_TOKEN: string;
}

export class TestEndpointsDO extends DurableObject<Env> {
  /**
   * RPC method: Start tracking requests (default: on)
   */
  startTracking(): void {
    this.ctx.storage.kv.put('tracking:enabled', true);
  }

  /**
   * RPC method: Stop tracking requests
   */
  stopTracking(): void {
    this.ctx.storage.kv.put('tracking:enabled', false);
  }

  /**
   * RPC method: Reset all tracking data
   */
  resetTracking(): void {
    // Delete all KV keys (SyncKvStorage doesn't have deleteAll, so iterate)
    for (const [key] of this.ctx.storage.kv.list()) {
      this.ctx.storage.kv.delete(key);
    }
  }

  /**
   * Main fetch handler - handles all HTTP endpoint requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Token check for all requests - accept via header OR query parameter
    const headerToken = request.headers.get('X-Test-Token');
    const queryToken = url.searchParams.get('token');
    const token = headerToken || queryToken;
    
    if (!this.env.TEST_TOKEN || token !== this.env.TEST_TOKEN) {
      return new Response('Unauthorized - X-Test-Token header or ?token= query parameter required', { 
        status: 401,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    const startTime = new Date();
    let response: Response;
    
    try {
      // Process the endpoint
      response = await this.#handleEndpoint(request, url);
    } catch (error) {
      console.error('Error processing request:', error);
      response = new Response('Internal Server Error', { 
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // Track the request/response (if enabled)
    await this.#trackRequest(request, response, startTime);

    return response;
  }

  /**
   * Handle endpoint routing
   */
  async #handleEndpoint(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;

    // GET /uuid - return a random UUID
    if (path.endsWith('/uuid') && request.method === 'GET') {
      return Response.json({ 
        uuid: crypto.randomUUID() 
      });
    }

    // GET /json - return sample JSON (mimics httpbin.org/json)
    if (path.endsWith('/json') && request.method === 'GET') {
      return Response.json({
        slideshow: {
          author: "Yours Truly",
          date: "date of publication",
          slides: [
            {
              title: "Wake up to WonderWidgets!",
              type: "all"
            },
            {
              items: [
                "Why <em>WonderWidgets</em> are great",
                "Who <em>buys</em> WonderWidgets"
              ],
              title: "Overview",
              type: "all"
            }
          ],
          title: "Sample Slide Show"
        }
      });
    }

    // GET /status/{code} - return specified status code
    if (path.includes('/status/') && request.method === 'GET') {
      const segments = path.split('/');
      const code = parseInt(segments[segments.length - 1]);
      if (isNaN(code) || code < 100 || code > 599) {
        return new Response('Invalid status code', { status: 400 });
      }
      return new Response('', { status: code });
    }

    // GET /delay/{milliseconds} - delay response (max 30000ms / 30 seconds)
    if (path.includes('/delay/') && request.method === 'GET') {
      const segments = path.split('/');
      const ms = parseInt(segments[segments.length - 1]);
      if (isNaN(ms) || ms < 0) {
        return new Response('Invalid delay value', { status: 400 });
      }
      if (ms > 30000) {
        return new Response('Delay too long (max 30000ms)', { status: 400 });
      }

      // Delay the response
      await new Promise(resolve => setTimeout(resolve, ms));

      return Response.json({
        delay: ms,
        timestamp: new Date().toISOString()
      });
    }

    // POST /echo - echo back request body and headers
    if (path.endsWith('/echo') && request.method === 'POST') {
      let jsonBody = null;
      const contentType = request.headers.get('Content-Type') || '';
      
      if (contentType.includes('application/json')) {
        try {
          jsonBody = await request.json();
        } catch (e) {
          return new Response('Invalid JSON', { status: 400 });
        }
      }

      // Convert headers to plain object
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return Response.json({
        args: {},
        data: jsonBody ? JSON.stringify(jsonBody) : '',
        files: {},
        form: {},
        headers,
        json: jsonBody,
        origin: request.headers.get('CF-Connecting-IP') || 'unknown',
        url: request.url
      });
    }

    // Not found
    return new Response('Not Found', { 
      status: 404,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  /**
   * Track request/response in KV storage (if tracking enabled)
   */
  async #trackRequest(request: Request, response: Response, startTime: Date): Promise<void> {
    // Check if tracking is enabled (default: true)
    const enabled = this.ctx.storage.kv.get<boolean>('tracking:enabled');
    if (enabled === false) {
      return; // Tracking disabled
    }

    // Increment count
    const count = this.ctx.storage.kv.get<number>('stats:count') || 0;
    this.ctx.storage.kv.put('stats:count', count + 1);

    // Update timestamps
    if (count === 0) {
      // First request
      this.ctx.storage.kv.put('stats:firstTimestamp', startTime);
    }
    this.ctx.storage.kv.put('stats:lastTimestamp', startTime);

    // Store last request/response (need to clone since Response body can only be read once)
    const responseClone = response.clone();
    
    this.ctx.storage.kv.put('request:last', await encodeRequest(request));
    this.ctx.storage.kv.put('response:last', await encodeResponse(responseClone));
  }
}

