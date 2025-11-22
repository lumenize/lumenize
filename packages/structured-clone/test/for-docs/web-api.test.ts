/**
 * Pedagogical examples for Web API objects documentation
 * Demonstrates serialization of Request, Response, Headers, and URL
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse } from '../../src/index.js';

describe('Request Serialization', () => {
  it('serializes HTTP requests', async () => {
    const request = new Request('https://api.example.com/users', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer token123' }
    });
    
    const restored = parse(await stringify(request));
    
    expect(restored).toBeInstanceOf(Request);
    expect(restored.url).toBe('https://api.example.com/users');
    expect(restored.method).toBe('GET');
    expect(restored.headers.get('authorization')).toBe('Bearer token123');
  });

  it('preserves request bodies', async () => {
    const userData = JSON.stringify({ name: 'Alice', email: 'alice@example.com' });
    const request = new Request('https://api.example.com/users', {
      method: 'POST',
      body: userData,
      headers: { 'content-type': 'application/json' }
    });
    
    const restored = parse(await stringify(request));
    
    expect(restored.method).toBe('POST');
    const bodyText = await restored.text();
    const body = JSON.parse(bodyText);
    expect(body.name).toBe('Alice');
  });
});

describe('Response Serialization', () => {
  it('serializes HTTP responses', async () => {
    const response = new Response('User created successfully', {
      status: 201,
      headers: { 'content-type': 'text/plain' }
    });
    
    const restored = parse(await stringify(response));
    
    expect(restored).toBeInstanceOf(Response);
    expect(restored.status).toBe(201);
    expect(await restored.text()).toBe('User created successfully');
  });

  it('preserves JSON responses', async () => {
    const data = { id: 123, name: 'Alice', active: true };
    const response = new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
    
    const restored = parse(await stringify(response));
    
    const responseData = JSON.parse(await restored.text());
    expect(responseData.id).toBe(123);
    expect(responseData.name).toBe('Alice');
  });
});

describe('Headers and URL', () => {
  it('serializes Headers objects', async () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'cache-control': 'max-age=3600'
    });
    
    const restored = parse(await stringify(headers));
    
    expect(restored).toBeInstanceOf(Headers);
    expect(restored.get('content-type')).toBe('application/json');
    expect(restored.get('cache-control')).toBe('max-age=3600');
  });

  it('serializes URL objects', async () => {
    const url = new URL('https://api.example.com/search?q=test&limit=10');
    
    const restored = parse(await stringify(url));
    
    expect(restored).toBeInstanceOf(URL);
    expect(restored.hostname).toBe('api.example.com');
    expect(restored.pathname).toBe('/search');
    expect(restored.searchParams.get('q')).toBe('test');
    expect(restored.searchParams.get('limit')).toBe('10');
  });
});

describe('Web API Use Cases', () => {
  it('handles request/response pairs', async () => {
    const apiData = {
      incomingRequest: new Request('https://api.example.com/endpoint', {
        method: 'POST',
        body: 'request data'
      }),
      outgoingResponse: new Response('response data', {
        status: 200
      }),
      timestamp: Date.now()
    };
    
    const restored = parse(await stringify(apiData));
    
    expect(restored.incomingRequest).toBeInstanceOf(Request);
    expect(await restored.incomingRequest.text()).toBe('request data');
    expect(restored.outgoingResponse).toBeInstanceOf(Response);
    expect(await restored.outgoingResponse.text()).toBe('response data');
  });
});

