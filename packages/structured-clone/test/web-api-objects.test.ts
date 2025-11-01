/**
 * Web API object tests (Request, Response, Headers, URL)
 * These objects are essential for Cloudflare Workers
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse, encodeRequest, encodeResponse, decodeRequest, decodeResponse } from '../src/index.js';

describe('Headers Serialization', () => {
  it('handles empty Headers', async () => {
    const headers = new Headers();
    const result = await parse(await stringify(headers));
    
    expect(result).toBeInstanceOf(Headers);
    expect(Array.from(result.entries())).toEqual([]);
  });

  it('handles Headers with values', async () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'x-custom-header': 'value'
    });
    
    const result = await parse(await stringify(headers));
    
    expect(result).toBeInstanceOf(Headers);
    expect(result.get('content-type')).toBe('application/json');
    expect(result.get('x-custom-header')).toBe('value');
  });

  it('handles Headers in objects', async () => {
    const obj = {
      headers: new Headers({ 'content-type': 'text/html' }),
      data: 'test'
    };
    
    const result = await parse(await stringify(obj));
    
    expect(result.headers).toBeInstanceOf(Headers);
    expect(result.headers.get('content-type')).toBe('text/html');
    expect(result.data).toBe('test');
  });
});

describe('URL Serialization', () => {
  it('handles simple URL', async () => {
    const url = new URL('https://example.com/path');
    const result = await parse(await stringify(url));
    
    expect(result).toBeInstanceOf(URL);
    expect(result.href).toBe('https://example.com/path');
    expect(result.hostname).toBe('example.com');
    expect(result.pathname).toBe('/path');
  });

  it('handles URL with query params', async () => {
    const url = new URL('https://api.example.com/search?q=test&limit=10');
    const result = await parse(await stringify(url));
    
    expect(result).toBeInstanceOf(URL);
    expect(result.searchParams.get('q')).toBe('test');
    expect(result.searchParams.get('limit')).toBe('10');
  });

  it('handles URL with hash', async () => {
    const url = new URL('https://example.com/page#section');
    const result = await parse(await stringify(url));
    
    expect(result).toBeInstanceOf(URL);
    expect(result.hash).toBe('#section');
  });

  it('handles URL in arrays', async () => {
    const urls = [
      new URL('https://example.com'),
      new URL('https://test.com')
    ];
    
    const result = await parse(await stringify(urls));
    
    expect(result[0]).toBeInstanceOf(URL);
    expect(result[0].href).toBe('https://example.com/');
    expect(result[1].href).toBe('https://test.com/');
  });
});

describe('Request Serialization', () => {
  it('handles GET request', async () => {
    const request = new Request('https://api.example.com/users');
    const result = await parse(await stringify(request));
    
    expect(result).toBeInstanceOf(Request);
    expect(result.url).toBe('https://api.example.com/users');
    expect(result.method).toBe('GET');
  });

  it('handles POST request with body', async () => {
    const request = new Request('https://api.example.com/users', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test User' }),
      headers: { 'content-type': 'application/json' }
    });
    
    const result = await parse(await stringify(request));
    
    expect(result).toBeInstanceOf(Request);
    expect(result.method).toBe('POST');
    expect(result.headers.get('content-type')).toBe('application/json');
    
    const body = await result.text();
    expect(JSON.parse(body)).toEqual({ name: 'Test User' });
  });

  it('handles PUT request', async () => {
    const request = new Request('https://api.example.com/users/1', {
      method: 'PUT',
      body: 'updated data'
    });
    
    const result = await parse(await stringify(request));
    
    expect(result.method).toBe('PUT');
    expect(await result.text()).toBe('updated data');
  });

  it('handles DELETE request', async () => {
    const request = new Request('https://api.example.com/users/1', {
      method: 'DELETE'
    });
    
    const result = await parse(await stringify(request));
    
    expect(result.method).toBe('DELETE');
    expect(result.url).toBe('https://api.example.com/users/1');
  });

  it('handles Request with custom headers', async () => {
    const request = new Request('https://api.example.com', {
      headers: {
        'Authorization': 'Bearer token123',
        'X-API-Key': 'key456'
      }
    });
    
    const result = await parse(await stringify(request));
    
    expect(result.headers.get('authorization')).toBe('Bearer token123');
    expect(result.headers.get('x-api-key')).toBe('key456');
  });

  it('handles Request in objects', async () => {
    const obj = {
      request: new Request('https://example.com', { method: 'POST', body: 'data' }),
      timestamp: Date.now()
    };
    
    const result = await parse(await stringify(obj));
    
    expect(result.request).toBeInstanceOf(Request);
    expect(result.request.method).toBe('POST');
    expect(await result.request.text()).toBe('data');
  });
});

describe('Response Serialization', () => {
  it('handles simple Response', async () => {
    const response = new Response('Hello World');
    const result = await parse(await stringify(response));
    
    expect(result).toBeInstanceOf(Response);
    expect(await result.text()).toBe('Hello World');
    expect(result.status).toBe(200);
  });

  it('handles Response with status', async () => {
    const response = new Response('Not Found', { status: 404, statusText: 'Not Found' });
    const result = await parse(await stringify(response));
    
    expect(result.status).toBe(404);
    expect(result.statusText).toBe('Not Found');
    expect(await result.text()).toBe('Not Found');
  });

  it('handles Response with JSON body', async () => {
    const body = { message: 'Success', data: [1, 2, 3] };
    const response = new Response(JSON.stringify(body), {
      status: 201,
      headers: { 'content-type': 'application/json' }
    });
    
    const result = await parse(await stringify(response));
    
    expect(result.status).toBe(201);
    expect(result.headers.get('content-type')).toBe('application/json');
    
    const resultBody = JSON.parse(await result.text());
    expect(resultBody).toEqual(body);
  });

  it('handles Response with headers', async () => {
    const response = new Response('test', {
      headers: {
        'Cache-Control': 'max-age=3600',
        'Content-Type': 'text/plain'
      }
    });
    
    const result = await parse(await stringify(response));
    
    expect(result.headers.get('cache-control')).toBe('max-age=3600');
    expect(result.headers.get('content-type')).toBe('text/plain');
  });

  it('handles empty Response', async () => {
    const response = new Response(null, { status: 204 });
    const result = await parse(await stringify(response));
    
    expect(result.status).toBe(204);
    expect(await result.text()).toBe('');
  });

  it('handles Response in arrays', async () => {
    const responses = [
      new Response('First', { status: 200 }),
      new Response('Second', { status: 201 })
    ];
    
    const result = await parse(await stringify(responses));
    
    expect(result[0]).toBeInstanceOf(Response);
    expect(await result[0].text()).toBe('First');
    expect(result[0].status).toBe(200);
    expect(await result[1].text()).toBe('Second');
    expect(result[1].status).toBe(201);
  });
});

describe('Mixed Web API Objects', () => {
  it('handles objects with multiple Web API types', async () => {
    const obj = {
      request: new Request('https://api.example.com', {
        method: 'POST',
        body: 'request data',
        headers: { 'content-type': 'text/plain' }
      }),
      response: new Response('response data', { status: 200 }),
      url: new URL('https://example.com/path'),
      headers: new Headers({ 'x-custom': 'value' })
    };
    
    const result = await parse(await stringify(obj));
    
    expect(result.request).toBeInstanceOf(Request);
    expect(await result.request.text()).toBe('request data');
    
    expect(result.response).toBeInstanceOf(Response);
    expect(await result.response.text()).toBe('response data');
    
    expect(result.url).toBeInstanceOf(URL);
    expect(result.url.href).toBe('https://example.com/path');
    
    expect(result.headers).toBeInstanceOf(Headers);
    expect(result.headers.get('x-custom')).toBe('value');
  });

  it('handles nested structures with Web API objects', async () => {
    const nested = {
      api: {
        endpoints: [
          { url: new URL('https://api.example.com/users'), method: 'GET' },
          { url: new URL('https://api.example.com/posts'), method: 'POST' }
        ]
      },
      response: new Response(JSON.stringify({ success: true }))
    };
    
    const result = await parse(await stringify(nested));
    
    expect(result.api.endpoints[0].url).toBeInstanceOf(URL);
    expect(result.api.endpoints[0].url.pathname).toBe('/users');
    expect(result.response).toBeInstanceOf(Response);
  });

  it('handles Web API objects in Maps', async () => {
    const map = new Map([
      ['req', new Request('https://example.com')],
      ['res', new Response('data')],
      ['url', new URL('https://test.com')]
    ]);
    
    const result = await parse(await stringify(map));
    
    expect(result).toBeInstanceOf(Map);
    expect(result.get('req')).toBeInstanceOf(Request);
    expect(result.get('res')).toBeInstanceOf(Response);
    expect(result.get('url')).toBeInstanceOf(URL);
  });

  it('handles Web API objects in Sets', async () => {
    const set = new Set([
      new URL('https://example1.com'),
      new URL('https://example2.com')
    ]);
    
    const result = await parse(await stringify(set));
    
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(2);
    
    const urls = Array.from(result);
    expect(urls[0]).toBeInstanceOf(URL);
    expect(urls[1]).toBeInstanceOf(URL);
  });
});

describe('Edge Cases', () => {
  it('handles Request with empty body', async () => {
    const request = new Request('https://example.com');
    const result = await parse(await stringify(request));
    
    expect(await result.text()).toBe('');
  });

  it('handles Response with null body', async () => {
    const response = new Response(null);
    const result = await parse(await stringify(response));
    
    expect(await result.text()).toBe('');
  });

  it('handles Headers with duplicate keys (last wins)', async () => {
    const headers = new Headers();
    headers.append('x-custom', 'value1');
    headers.append('x-custom', 'value2');
    
    const result = await parse(await stringify(headers));
    
    // Headers with duplicate keys are concatenated with comma
    expect(result.get('x-custom')).toContain('value1');
    expect(result.get('x-custom')).toContain('value2');
  });

  it('handles URL with all components', async () => {
    const url = new URL('https://user:pass@example.com:8080/path?query=1#hash');
    const result = await parse(await stringify(url));
    
    expect(result.protocol).toBe('https:');
    expect(result.username).toBe('user');
    expect(result.password).toBe('pass');
    expect(result.hostname).toBe('example.com');
    expect(result.port).toBe('8080');
    expect(result.pathname).toBe('/path');
    expect(result.search).toBe('?query=1');
    expect(result.hash).toBe('#hash');
  });

  it('handles circular references with Web API objects', async () => {
    const obj: any = {
      url: new URL('https://example.com'),
      data: 'test'
    };
    obj.self = obj;
    
    const result = await parse(await stringify(obj));
    
    expect(result.url).toBeInstanceOf(URL);
    expect(result.self).toBe(result);
  });
});

describe('Standalone Encode/Decode Functions', () => {
  it('encodeRequest/decodeRequest handles GET request', async () => {
    const request = new Request('https://api.example.com/users', {
      method: 'GET',
      headers: { 'authorization': 'Bearer token123' }
    });
    
    const encoded = await encodeRequest(request);
    const decoded = decodeRequest(encoded);
    
    expect(decoded).toBeInstanceOf(Request);
    expect(decoded.url).toBe('https://api.example.com/users');
    expect(decoded.method).toBe('GET');
    expect(decoded.headers.get('authorization')).toBe('Bearer token123');
  });

  it('encodeRequest/decodeRequest handles POST with text body', async () => {
    const request = new Request('https://api.example.com/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Test Post', content: 'Hello World' })
    });
    
    const encoded = await encodeRequest(request);
    const decoded = decodeRequest(encoded);
    
    expect(decoded).toBeInstanceOf(Request);
    expect(decoded.method).toBe('POST');
    expect(decoded.headers.get('content-type')).toBe('application/json');
    
    const body = await decoded.json();
    expect(body.title).toBe('Test Post');
    expect(body.content).toBe('Hello World');
  });

  it('encodeRequest/decodeRequest handles binary body', async () => {
    const binaryData = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    const request = new Request('https://api.example.com/upload', {
      method: 'PUT',
      body: binaryData
    });
    
    const encoded = await encodeRequest(request);
    const decoded = decodeRequest(encoded);
    
    expect(decoded).toBeInstanceOf(Request);
    const resultBuffer = await decoded.arrayBuffer();
    const resultArray = new Uint8Array(resultBuffer);
    expect(Array.from(resultArray)).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  it('encodeResponse/decodeResponse handles simple response', async () => {
    const response = new Response('Hello World', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/plain' }
    });
    
    const encoded = await encodeResponse(response);
    const decoded = decodeResponse(encoded);
    
    expect(decoded).toBeInstanceOf(Response);
    expect(decoded.status).toBe(200);
    expect(decoded.statusText).toBe('OK');
    expect(decoded.headers.get('content-type')).toBe('text/plain');
    
    const text = await decoded.text();
    expect(text).toBe('Hello World');
  });

  it('encodeResponse/decodeResponse handles JSON response', async () => {
    const data = { users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] };
    const response = new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
    
    const encoded = await encodeResponse(response);
    const decoded = decodeResponse(encoded);
    
    expect(decoded).toBeInstanceOf(Response);
    expect(decoded.headers.get('content-type')).toBe('application/json');
    
    const result = await decoded.json();
    expect(result.users).toHaveLength(2);
    expect(result.users[0].name).toBe('Alice');
  });

  it('encodeResponse/decodeResponse handles error responses', async () => {
    const response = new Response('Not Found', {
      status: 404,
      statusText: 'Not Found'
    });
    
    const encoded = await encodeResponse(response);
    const decoded = decodeResponse(encoded);
    
    expect(decoded).toBeInstanceOf(Response);
    expect(decoded.status).toBe(404);
    expect(decoded.statusText).toBe('Not Found');
    expect(decoded.ok).toBe(false);
  });

  it('encodeResponse/decodeResponse handles binary response', async () => {
    const binaryData = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]); // JPEG header
    const response = new Response(binaryData, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' }
    });
    
    const encoded = await encodeResponse(response);
    const decoded = decodeResponse(encoded);
    
    expect(decoded).toBeInstanceOf(Response);
    expect(decoded.headers.get('content-type')).toBe('image/jpeg');
    
    const resultBuffer = await decoded.arrayBuffer();
    const resultArray = new Uint8Array(resultBuffer);
    expect(Array.from(resultArray)).toEqual([0xFF, 0xD8, 0xFF, 0xE0]);
  });
});

