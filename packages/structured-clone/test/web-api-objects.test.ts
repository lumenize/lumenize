/**
 * Web API object tests (Headers, URL)
 * Request and Response tests have been removed - use RequestSync/ResponseSync instead
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse } from '../src/index.js';

describe('Headers Serialization', () => {
  it('handles empty Headers', () => {
    const headers = new Headers();
    const result = parse(stringify(headers));
    
    expect(result).toBeInstanceOf(Headers);
    expect(Array.from(result.entries())).toEqual([]);
  });

  it('handles Headers with values', () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'x-custom-header': 'value'
    });
    
    const result = parse(stringify(headers));
    
    expect(result).toBeInstanceOf(Headers);
    expect(result.get('content-type')).toBe('application/json');
    expect(result.get('x-custom-header')).toBe('value');
  });

  it('handles Headers in objects', () => {
    const obj = {
      headers: new Headers({ 'content-type': 'text/html' }),
      data: 'test'
    };
    
    const result = parse(stringify(obj));
    
    expect(result.headers).toBeInstanceOf(Headers);
    expect(result.headers.get('content-type')).toBe('text/html');
    expect(result.data).toBe('test');
  });
});

describe('URL Serialization', () => {
  it('handles simple URL', () => {
    const url = new URL('https://example.com/path');
    const result = parse(stringify(url));
    
    expect(result).toBeInstanceOf(URL);
    expect(result.href).toBe('https://example.com/path');
    expect(result.hostname).toBe('example.com');
    expect(result.pathname).toBe('/path');
  });

  it('handles URL with query params', () => {
    const url = new URL('https://api.example.com/search?q=test&limit=10');
    const result = parse(stringify(url));
    
    expect(result).toBeInstanceOf(URL);
    expect(result.searchParams.get('q')).toBe('test');
    expect(result.searchParams.get('limit')).toBe('10');
  });

  it('handles URL with hash', () => {
    const url = new URL('https://example.com/page#section');
    const result = parse(stringify(url));
    
    expect(result).toBeInstanceOf(URL);
    expect(result.hash).toBe('#section');
  });

  it('handles URL in arrays', () => {
    const urls = [
      new URL('https://example.com'),
      new URL('https://test.com')
    ];
    
    const result = parse(stringify(urls));
    
    expect(result[0]).toBeInstanceOf(URL);
    expect(result[0].href).toBe('https://example.com/');
    expect(result[1].href).toBe('https://test.com/');
  });
});

describe('Mixed Web API Objects', () => {
  it('handles objects with URLs and Headers', () => {
    const obj = {
      url: new URL('https://example.com/path'),
      headers: new Headers({ 'x-custom': 'value' }),
      data: 'test'
    };
    
    const result = parse(stringify(obj));
    
    expect(result.url).toBeInstanceOf(URL);
    expect(result.url.href).toBe('https://example.com/path');
    
    expect(result.headers).toBeInstanceOf(Headers);
    expect(result.headers.get('x-custom')).toBe('value');
    expect(result.data).toBe('test');
  });

  it('handles nested structures with Web API objects', () => {
    const nested = {
      api: {
        endpoints: [
          { url: new URL('https://api.example.com/users'), method: 'GET' },
          { url: new URL('https://api.example.com/posts'), method: 'POST' }
        ]
      },
      metadata: { success: true }
    };
    
    const result = parse(stringify(nested));
    
    expect(result.api.endpoints[0].url).toBeInstanceOf(URL);
    expect(result.api.endpoints[0].url.pathname).toBe('/users');
    expect(result.metadata.success).toBe(true);
  });

  it('handles Web API objects in Maps', () => {
    const map = new Map<string, URL | Headers>([
      ['url', new URL('https://test.com')],
      ['headers', new Headers({ 'x-test': 'value' })]
    ]);
    
    const result = parse(stringify(map));
    
    expect(result).toBeInstanceOf(Map);
    expect(result.get('url')).toBeInstanceOf(URL);
    expect(result.get('headers')).toBeInstanceOf(Headers);
  });

  it('handles Web API objects in Sets', () => {
    const set = new Set([
      new URL('https://example1.com'),
      new URL('https://example2.com')
    ]);
    
    const result = parse(stringify(set));
    
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(2);
    
    const urls = Array.from(result);
    expect(urls[0]).toBeInstanceOf(URL);
    expect(urls[1]).toBeInstanceOf(URL);
  });
});

describe('Edge Cases', () => {
  it('handles Headers with duplicate keys (last wins)', () => {
    const headers = new Headers();
    headers.append('x-custom', 'value1');
    headers.append('x-custom', 'value2');
    
    const result = parse(stringify(headers));
    
    // Headers with duplicate keys are concatenated with comma
    expect(result.get('x-custom')).toContain('value1');
    expect(result.get('x-custom')).toContain('value2');
  });

  it('handles URL with all components', () => {
    const url = new URL('https://user:pass@example.com:8080/path?query=1#hash');
    const result = parse(stringify(url));
    
    expect(result.protocol).toBe('https:');
    expect(result.username).toBe('user');
    expect(result.password).toBe('pass');
    expect(result.hostname).toBe('example.com');
    expect(result.port).toBe('8080');
    expect(result.pathname).toBe('/path');
    expect(result.search).toBe('?query=1');
    expect(result.hash).toBe('#hash');
  });

  it('handles circular references with Web API objects', () => {
    const obj: any = {
      url: new URL('https://example.com'),
      data: 'test'
    };
    obj.self = obj;
    
    const result = parse(stringify(obj));
    
    expect(result.url).toBeInstanceOf(URL);
    expect(result.self).toBe(result);
  });
});

