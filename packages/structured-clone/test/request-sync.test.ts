import { describe, it, expect } from 'vitest';
import { RequestSync } from '../src/request-sync';
import { stringify, parse } from '../src/index';

describe('RequestSync', () => {
  describe('constructor', () => {
    it('creates with URL string and no body', () => {
      const req = new RequestSync('https://example.com');
      expect(req.url).toBe('https://example.com/');
      expect(req.method).toBe('GET');
      expect(req.body).toBeNull();
    });

    it('creates with URL and method', () => {
      const req = new RequestSync('https://example.com', { method: 'POST' });
      expect(req.method).toBe('POST');
    });

    it('creates with object body', () => {
      const body = { name: 'Alice', age: 30 };
      const req = new RequestSync('https://api.example.com/users', {
        method: 'POST',
        body
      });
      expect(req.body).toEqual(body);
    });

    it('creates with string body', () => {
      const body = '{"test":"data"}';
      const req = new RequestSync('https://example.com', {
        method: 'POST',
        body
      });
      expect(req.body).toBe(body);
    });

    it('creates with ArrayBuffer body', () => {
      const buffer = new TextEncoder().encode('Hello').buffer;
      const req = new RequestSync('https://example.com', {
        method: 'POST',
        body: buffer
      });
      expect(req.body).toBe(buffer);
    });

    it('creates with headers', () => {
      const req = new RequestSync('https://example.com', {
        headers: { 'Content-Type': 'application/json' }
      });
      expect(req.headers.get('Content-Type')).toBe('application/json');
    });
  });

  describe('json()', () => {
    it('parses string body as JSON', () => {
      const req = new RequestSync('https://example.com', {
        body: '{"name":"Alice","age":30}'
      });
      expect(req.json()).toEqual({ name: 'Alice', age: 30 });
    });

    it('returns object body as-is', () => {
      const body = { name: 'Bob', age: 25 };
      const req = new RequestSync('https://example.com', {
        body
      });
      expect(req.json()).toEqual(body);
    });

    it('parses ArrayBuffer body as JSON', () => {
      const buffer = new TextEncoder().encode('{"test":"data"}').buffer;
      const req = new RequestSync('https://example.com', {
        body: buffer
      });
      expect(req.json()).toEqual({ test: 'data' });
    });

    it('returns null for no body', () => {
      const req = new RequestSync('https://example.com');
      expect(req.json()).toBeNull();
    });
  });

  describe('text()', () => {
    it('returns string body as-is', () => {
      const body = 'Hello World';
      const req = new RequestSync('https://example.com', {
        body
      });
      expect(req.text()).toBe('Hello World');
    });

    it('stringifies object body', () => {
      const body = { test: 'data' };
      const req = new RequestSync('https://example.com', {
        body
      });
      expect(req.text()).toBe('{"test":"data"}');
    });

    it('decodes ArrayBuffer body', () => {
      const buffer = new TextEncoder().encode('Hello').buffer;
      const req = new RequestSync('https://example.com', {
        body: buffer
      });
      expect(req.text()).toBe('Hello');
    });

    it('returns empty string for no body', () => {
      const req = new RequestSync('https://example.com');
      expect(req.text()).toBe('');
    });
  });

  describe('arrayBuffer()', () => {
    it('returns ArrayBuffer body as-is', () => {
      const buffer = new TextEncoder().encode('Hello').buffer;
      const req = new RequestSync('https://example.com', {
        body: buffer
      });
      expect(req.arrayBuffer()).toBe(buffer);
    });

    it('encodes string body', () => {
      const req = new RequestSync('https://example.com', {
        body: 'Hello'
      });
      const buffer = req.arrayBuffer();
      const text = new TextDecoder().decode(buffer);
      expect(text).toBe('Hello');
    });

    it('encodes object body', () => {
      const req = new RequestSync('https://example.com', {
        body: { test: 'data' }
      });
      const buffer = req.arrayBuffer();
      const text = new TextDecoder().decode(buffer);
      expect(text).toBe('{"test":"data"}');
    });

    it('returns empty ArrayBuffer for no body', () => {
      const req = new RequestSync('https://example.com');
      const buffer = req.arrayBuffer();
      expect(buffer.byteLength).toBe(0);
    });
  });

  describe('blob()', () => {
    it('returns Blob from body', () => {
      const req = new RequestSync('https://example.com', {
        body: 'Hello'
      });
      const blob = req.blob();
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });
  });

  describe('formData()', () => {
    it('throws error (not supported)', () => {
      const req = new RequestSync('https://example.com');
      expect(() => req.formData()).toThrow('FormData not supported');
    });
  });

  describe('metadata forwarders', () => {
    it('forwards url', () => {
      const req = new RequestSync('https://example.com/path');
      expect(req.url).toBe('https://example.com/path');
    });

    it('forwards method', () => {
      const req = new RequestSync('https://example.com', { method: 'POST' });
      expect(req.method).toBe('POST');
    });

    it('forwards headers', () => {
      const req = new RequestSync('https://example.com', {
        headers: { 'X-Custom': 'value' }
      });
      expect(req.headers.get('X-Custom')).toBe('value');
    });

    // Note: credentials, mode, referrer, integrity, keepalive tests moved to
    // request-sync-browser.test.ts - these properties are not preserved in
    // Cloudflare Workers but work correctly in browser environments.

    it('forwards cache', () => {
      const req = new RequestSync('https://example.com', {
        cache: 'no-cache'
      });
      expect(req.cache).toBe('no-cache');
    });

    it('forwards redirect', () => {
      const req = new RequestSync('https://example.com', {
        redirect: 'follow'
      });
      expect(req.redirect).toBe('follow');
    });
  });

  describe('clone()', () => {
    it('creates a copy with same properties', () => {
      const req = new RequestSync('https://example.com', {
        method: 'POST',
        body: { test: 'data' },
        headers: { 'Content-Type': 'application/json' }
      });
      
      const cloned = req.clone();
      
      expect(cloned.url).toBe(req.url);
      expect(cloned.method).toBe(req.method);
      expect(cloned.body).toEqual(req.body);
      expect(cloned.headers.get('Content-Type')).toBe('application/json');
    });

    it('creates shallow copy (body is shared reference)', () => {
      const body = { test: 'original' };
      const req = new RequestSync('https://example.com', { body });
      
      const cloned = req.clone();
      
      // Body is a shallow copy - same reference
      expect(cloned.body).toBe(req.body);
      
      // Modifying shared body affects both
      if (typeof cloned.body === 'object' && cloned.body !== null) {
        (cloned.body as any).test = 'modified';
      }
      expect((req.body as any).test).toBe('modified');
    });
  });

  describe('toRequest()', () => {
    it('converts to real Request', () => {
      const req = new RequestSync('https://example.com', {
        method: 'POST',
        body: { test: 'data' },
        headers: { 'Content-Type': 'application/json' }
      });
      
      const realRequest = req.toRequest();
      
      expect(realRequest).toBeInstanceOf(Request);
      expect(realRequest.url).toBe(req.url);
      expect(realRequest.method).toBe('POST');
      expect(realRequest.headers.get('Content-Type')).toBe('application/json');
    });
  });

  describe('edge cases', () => {
    it('handles null body explicitly', () => {
      const req = new RequestSync('https://example.com', {
        body: null
      });
      expect(req.body).toBeNull();
      expect(req.text()).toBe('');
      expect(req.json()).toBeNull();
    });

    it('handles empty string body', () => {
      const req = new RequestSync('https://example.com', {
        body: ''
      });
      expect(req.text()).toBe('');
    });

    it('handles empty object body', () => {
      const req = new RequestSync('https://example.com', {
        body: {}
      });
      expect(req.json()).toEqual({});
      expect(req.text()).toBe('{}');
    });

    it('handles special characters in body', () => {
      const body = { message: 'Hello "World" \n\t' };
      const req = new RequestSync('https://example.com', {
        body
      });
      expect(req.json()).toEqual(body);
    });

    it('handles large body', () => {
      const largeBody = { data: 'x'.repeat(10000) };
      const req = new RequestSync('https://example.com', {
        body: largeBody
      });
      expect(req.json()).toEqual(largeBody);
    });
  });

  describe('Round-trip Serialization', () => {
    it('handles simple RequestSync round-trip', async () => {
      const requestSync = new RequestSync('https://example.com');
      const result = parse(await stringify(requestSync));
      
      expect(result).toBeInstanceOf(RequestSync);
      expect(result.url).toBe('https://example.com/');
      expect(result.method).toBe('GET');
    });

    it('handles RequestSync with method round-trip', async () => {
      const requestSync = new RequestSync('https://api.example.com/users', {
        method: 'POST'
      });
      const result = parse(await stringify(requestSync));
      
      expect(result).toBeInstanceOf(RequestSync);
      expect(result.url).toBe('https://api.example.com/users');
      expect(result.method).toBe('POST');
    });

    it('handles RequestSync with JSON body round-trip', async () => {
      const body = { username: 'alice', email: 'alice@example.com' };
      const requestSync = new RequestSync('https://api.example.com/users', {
        method: 'POST',
        body: body
      });
      const result = parse(await stringify(requestSync));
      
      expect(result).toBeInstanceOf(RequestSync);
      expect(result.method).toBe('POST');
      expect(result.json()).toEqual(body);
    });

    it('handles RequestSync with headers round-trip', async () => {
      const requestSync = new RequestSync('https://api.example.com', {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer token123',
          'X-Custom-Header': 'custom-value'
        }
      });
      const result = parse(await stringify(requestSync));
      
      expect(result).toBeInstanceOf(RequestSync);
      expect(result.headers.get('Content-Type')).toBe('application/json');
      expect(result.headers.get('Authorization')).toBe('Bearer token123');
      expect(result.headers.get('X-Custom-Header')).toBe('custom-value');
    });

    it('handles RequestSync with string body round-trip', async () => {
      const requestSync = new RequestSync('https://api.example.com/data', {
        method: 'POST',
        body: 'plain text data'
      });
      const result = parse(await stringify(requestSync));
      
      expect(result).toBeInstanceOf(RequestSync);
      expect(result.text()).toBe('plain text data');
    });

    it('handles RequestSync with ArrayBuffer body round-trip', async () => {
      const buffer = new TextEncoder().encode('Binary data').buffer;
      const requestSync = new RequestSync('https://api.example.com/upload', {
        method: 'POST',
        body: buffer
      });
      const result = parse(await stringify(requestSync));
      
      expect(result).toBeInstanceOf(RequestSync);
      expect(result.arrayBuffer()).toEqual(buffer);
    });

    it('handles RequestSync in arrays round-trip', async () => {
      const requests = [
        new RequestSync('https://api.example.com/users'),
        new RequestSync('https://api.example.com/posts', { method: 'POST' })
      ];
      const result = parse(await stringify(requests));
      
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(RequestSync);
      expect(result[0].url).toBe('https://api.example.com/users');
      expect(result[1]).toBeInstanceOf(RequestSync);
      expect(result[1].method).toBe('POST');
    });

    it('handles RequestSync in nested objects round-trip', async () => {
      const obj = {
        request: new RequestSync('https://api.example.com', {
          method: 'POST',
          body: { data: 'test' }
        }),
        metadata: { timestamp: Date.now() }
      };
      const result = parse(await stringify(obj));
      
      expect(result.request).toBeInstanceOf(RequestSync);
      expect(result.request.method).toBe('POST');
      expect(result.request.json()).toEqual({ data: 'test' });
    });
  });
});

