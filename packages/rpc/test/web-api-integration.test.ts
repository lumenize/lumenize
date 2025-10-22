import { describe, it, expect, afterEach } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, getWebSocketShim } from '../src/index';

/**
 * Web API Object Serialization Integration Tests
 * 
 * Tests that Web API objects (Request, Response, Headers, URL) survive
 * the full round trip through the RPC system:
 * 1. Created/returned on DO server
 * 2. Serialized for transport
 * 3. Sent over HTTP or WebSocket
 * 4. Deserialized on client
 * 5. Reconstructed as proper instances with working methods
 */

/**
 * Helper to create an RPC client for testing
 */
function createTestClient(transport: 'http' | 'websocket', doBindingName: string) {
  const baseConfig = {
    transport,
    baseUrl: 'https://fake-host.com',
    prefix: '__rpc',
  } as const;

  if (transport === 'websocket') {
    (baseConfig as any).WebSocketClass = getWebSocketShim(SELF.fetch.bind(SELF));
  } else {
    (baseConfig as any).fetch = SELF.fetch.bind(SELF);
  }

  const instanceId = `web-api-test-${Date.now()}-${Math.random()}`;
  
  return createRpcClient(doBindingName, instanceId, baseConfig);
}

describe('Web API Integration - HTTP Transport', () => {
  let client: any;
  
  afterEach(async () => {
    if (client) {
      await client[Symbol.asyncDispose]();
      client = null;
    }
  });
  
  it('should reconstruct Request objects with proper methods', async () => {
    client = createTestClient('http', 'example-do');
    
    const request = await client.getRequest();
    
    // Verify it's a proper Request instance
    expect(request).toBeInstanceOf(Request);
    
    // Verify basic properties
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://example.com/api/test');
    
    // Verify headers are reconstructed
    expect(request.headers).toBeInstanceOf(Headers);
    expect(request.headers.get('Content-Type')).toBe('application/json');
    expect(request.headers.get('X-Custom-Header')).toBe('test-value');
    
    // Verify body can be read
    const body = await request.text();
    expect(body).toBe(JSON.stringify({ test: 'data' }));
  });
  
  it('should reconstruct Response objects with proper methods', async () => {
    client = createTestClient('http', 'example-do');
    
    const response = await client.getResponse();
    
    // Verify it's a proper Response instance
    expect(response).toBeInstanceOf(Response);
    
    // Verify basic properties
    expect(response.status).toBe(200);
    expect(response.statusText).toBe('OK');
    expect(response.ok).toBe(true);
    
    // Verify headers are reconstructed
    expect(response.headers).toBeInstanceOf(Headers);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('X-Response-Id')).toBe('12345');
    
    // Verify body can be read
    const body = await response.text();
    expect(body).toBe(JSON.stringify({ success: true, data: 'test' }));
  });
  
  it('should reconstruct Headers objects with proper methods', async () => {
    client = createTestClient('http', 'example-do');
    
    const headers = await client.getHeaders();
    
    // Verify it's a proper Headers instance
    expect(headers).toBeInstanceOf(Headers);
    
    // Verify headers can be accessed
    expect(headers.get('Authorization')).toBe('Bearer token123');
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('X-API-Key')).toBe('secret-key');
    
    // Verify has() method works
    expect(headers.has('Authorization')).toBe(true);
    expect(headers.has('NonExistent')).toBe(false);
    
    // Verify headers can be iterated
    const headerEntries = Array.from(headers.entries());
    expect(headerEntries.length).toBe(3);
    expect(headerEntries).toContainEqual(['authorization', 'Bearer token123']);
    expect(headerEntries).toContainEqual(['accept', 'application/json']);
    expect(headerEntries).toContainEqual(['x-api-key', 'secret-key']);
  });
  
  it('should reconstruct URL objects with proper methods', async () => {
    client = createTestClient('http', 'example-do');
    
    const url = await client.getURL();
    
    // Verify it's a proper URL instance
    expect(url).toBeInstanceOf(URL);
    
    // Verify basic properties
    expect(url.href).toBe('https://example.com/path?param1=value1&param2=value2#hash');
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('example.com');
    expect(url.pathname).toBe('/path');
    expect(url.search).toBe('?param1=value1&param2=value2');
    expect(url.hash).toBe('#hash');
    
    // Verify searchParams works
    expect(url.searchParams.get('param1')).toBe('value1');
    expect(url.searchParams.get('param2')).toBe('value2');
    
    // Verify toString() method
    expect(url.toString()).toBe('https://example.com/path?param1=value1&param2=value2#hash');
  });
  
  it('should handle nested Web API objects in complex structures', async () => {
    client = createTestClient('http', 'example-do');
    
    const result = await client.getWebApiMix();
    
    // Verify all Web API objects are properly reconstructed
    expect(result.request).toBeInstanceOf(Request);
    expect(result.request.url).toBe('https://example.com/test');
    
    expect(result.response).toBeInstanceOf(Response);
    const body = await result.response.text();
    expect(body).toBe('test body');
    
    expect(result.headers).toBeInstanceOf(Headers);
    expect(result.headers.get('X-Test')).toBe('value');
    
    expect(result.url).toBeInstanceOf(URL);
    expect(result.url.href).toBe('https://example.com/');
    
    // Verify nested Web API objects
    expect(result.nested.deepRequest).toBeInstanceOf(Request);
    expect(result.nested.deepRequest.url).toBe('https://example.com/deep');
  });
  
  it('should preserve Request properties (redirect, integrity, keepalive)', async () => {
    client = createTestClient('http', 'example-do');
    
    const request = await client.getRequest();
    
    // Verify additional Request properties are preserved
    expect(request.redirect).toBeDefined();
    expect(request.integrity).toBeDefined();
    expect(request.keepalive).toBeDefined();
  });
  
  it('should preserve Response properties (ok, redirected, type)', async () => {
    client = createTestClient('http', 'example-do');
    
    const response = await client.getResponse();
    
    // Verify additional Response properties are preserved
    expect(response.ok).toBe(true);
    expect(response.redirected).toBeDefined();
    expect(response.type).toBeDefined();
    expect(response.url).toBeDefined();
  });
});

describe('Web API Integration - WebSocket Transport', () => {
  let client: any;
  
  afterEach(async () => {
    if (client) {
      await client[Symbol.asyncDispose]();
      client = null;
    }
  });
  
  it('should reconstruct Request objects over WebSocket', async () => {
    client = createTestClient('websocket', 'example-do');
    
    const request = await client.getRequest();
    
    // Verify it's a proper Request instance
    expect(request).toBeInstanceOf(Request);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://example.com/api/test');
    
    // Verify headers work
    expect(request.headers.get('Content-Type')).toBe('application/json');
    
    // Verify body can be read
    const body = await request.text();
    expect(body).toBe(JSON.stringify({ test: 'data' }));
  });
  
  it('should reconstruct Response objects over WebSocket', async () => {
    client = createTestClient('websocket', 'example-do');
    
    const response = await client.getResponse();
    
    // Verify it's a proper Response instance
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    
    // Verify body can be read
    const body = await response.text();
    expect(body).toBe(JSON.stringify({ success: true, data: 'test' }));
  });
  
  it('should reconstruct Headers objects over WebSocket', async () => {
    client = createTestClient('websocket', 'example-do');
    
    const headers = await client.getHeaders();
    
    // Verify it's a proper Headers instance
    expect(headers).toBeInstanceOf(Headers);
    expect(headers.get('Authorization')).toBe('Bearer token123');
    expect(headers.has('Accept')).toBe(true);
    
    // Verify iteration works
    const headerEntries = Array.from(headers.entries());
    expect(headerEntries.length).toBe(3);
  });
  
  it('should reconstruct URL objects over WebSocket', async () => {
    client = createTestClient('websocket', 'example-do');
    
    const url = await client.getURL();
    
    // Verify it's a proper URL instance
    expect(url).toBeInstanceOf(URL);
    expect(url.href).toBe('https://example.com/path?param1=value1&param2=value2#hash');
    expect(url.searchParams.get('param1')).toBe('value1');
  });
  
  it('should handle nested Web API objects over WebSocket', async () => {
    client = createTestClient('websocket', 'example-do');
    
    const result = await client.getWebApiMix();
    
    // Verify all Web API objects are properly reconstructed
    expect(result.request).toBeInstanceOf(Request);
    expect(result.response).toBeInstanceOf(Response);
    expect(result.headers).toBeInstanceOf(Headers);
    expect(result.url).toBeInstanceOf(URL);
    expect(result.nested.deepRequest).toBeInstanceOf(Request);
  });
});
