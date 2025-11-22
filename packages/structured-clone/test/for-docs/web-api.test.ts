/**
 * Pedagogical examples for Web API objects documentation
 * Demonstrates serialization of Headers and URL (RequestSync/ResponseSync covered in separate test file)
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse } from '../../src/index.js';

describe('Headers Serialization', () => {
  it('serializes HTTP headers', () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'authorization': 'Bearer token123'
    });
    
    const restored = parse(stringify(headers));
    
    expect(restored).toBeInstanceOf(Headers);
    expect(restored.get('content-type')).toBe('application/json');
    expect(restored.get('authorization')).toBe('Bearer token123');
  });

  it('preserves header modifications', () => {
    const headers = new Headers();
    headers.set('x-custom-header', 'value1');
    headers.append('x-custom-header', 'value2');
    
    const restored = parse(stringify(headers));
    
    expect(restored).toBeInstanceOf(Headers);
    // Multiple values are concatenated with comma
    const headerValue = restored.get('x-custom-header');
    expect(headerValue).toContain('value1');
    expect(headerValue).toContain('value2');
  });
});

describe('URL Serialization', () => {
  it('serializes URLs', () => {
    const url = new URL('https://api.example.com/users?limit=10#results');
    
    const restored = parse(stringify(url));
    
    expect(restored).toBeInstanceOf(URL);
    expect(restored.hostname).toBe('api.example.com');
    expect(restored.pathname).toBe('/users');
    expect(restored.searchParams.get('limit')).toBe('10');
    expect(restored.hash).toBe('#results');
  });

  it('preserves URL manipulations', () => {
    const url = new URL('https://api.example.com/search');
    url.searchParams.set('query', 'test');
    url.searchParams.set('page', '2');
    
    const restored = parse(stringify(url));
    
    expect(restored.searchParams.get('query')).toBe('test');
    expect(restored.searchParams.get('page')).toBe('2');
  });
});

describe('Web API Use Cases', () => {
  it('handles headers and URLs together', () => {
    const apiCall = {
      endpoint: new URL('https://api.example.com/users'),
      headers: new Headers({
        'accept': 'application/json',
        'user-agent': 'MyApp/1.0'
      }),
      method: 'GET'
    };
    
    const restored = parse(stringify(apiCall));
    
    expect(restored.endpoint).toBeInstanceOf(URL);
    expect(restored.endpoint.pathname).toBe('/users');
    expect(restored.headers).toBeInstanceOf(Headers);
    expect(restored.headers.get('accept')).toBe('application/json');
    expect(restored.method).toBe('GET');
  });
});

