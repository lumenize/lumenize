/**
 * Test HTTP endpoints for Lumenize integration tests.
 * 
 * Provides httpbin.org-like endpoints for testing HTTP operations.
 * Protected with TEST_TOKEN secret to prevent unauthorized usage.
 * 
 * Available endpoints:
 * - GET /uuid - Returns JSON with a random UUID
 * - GET /json - Returns sample JSON data
 * - GET /status/{code} - Returns specified HTTP status code
 * - GET /delay/{seconds} - Delays response by N seconds (max 30)
 * - POST /post - Echoes back request body and headers
 * 
 * All requests must include: X-Test-Token: <token from env.TEST_TOKEN>
 */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Token check for all requests
    const token = request.headers.get('X-Test-Token');
    if (!env.TEST_TOKEN || token !== env.TEST_TOKEN) {
      return new Response('Unauthorized - X-Test-Token header required', { 
        status: 401,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /uuid - return a random UUID
      if (path === '/uuid' && request.method === 'GET') {
        return Response.json({ 
          uuid: crypto.randomUUID() 
        });
      }

      // GET /json - return sample JSON (mimics httpbin.org/json)
      if (path === '/json' && request.method === 'GET') {
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
      if (path.startsWith('/status/') && request.method === 'GET') {
        const code = parseInt(path.split('/')[2]);
        if (isNaN(code) || code < 100 || code > 599) {
          return new Response('Invalid status code', { status: 400 });
        }
        return new Response('', { status: code });
      }

      // GET /delay/{seconds} - delay response (max 30 seconds)
      if (path.startsWith('/delay/') && request.method === 'GET') {
        const seconds = parseInt(path.split('/')[2]);
        if (isNaN(seconds) || seconds < 0) {
          return new Response('Invalid delay value', { status: 400 });
        }
        if (seconds > 30) {
          return new Response('Delay too long (max 30 seconds)', { status: 400 });
        }
        
        // Delay the response
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        
        return Response.json({ 
          delay: seconds,
          timestamp: new Date().toISOString()
        });
      }

      // POST /post - echo back request body and headers
      if (path === '/post' && request.method === 'POST') {
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

    } catch (error) {
      console.error('Error processing request:', error);
      return new Response('Internal Server Error', { 
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }
};

interface Env {
  TEST_TOKEN: string;
}
