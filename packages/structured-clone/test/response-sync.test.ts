import { describe, it, expect } from 'vitest';
import { ResponseSync } from '../src/response-sync';
import { stringify, parse } from '../src/index';

describe('ResponseSync', () => {
  describe('constructor', () => {
    it('creates with no body', () => {
      const res = new ResponseSync();
      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });

    it('creates with object body', () => {
      const body = { message: 'Success', data: [1, 2, 3] };
      const res = new ResponseSync(body);
      expect(res.body).toEqual(body);
    });

    it('creates with string body', () => {
      const body = 'Hello World';
      const res = new ResponseSync(body);
      expect(res.body).toBe(body);
    });

    it('creates with ArrayBuffer body', () => {
      const buffer = new TextEncoder().encode('Hello').buffer;
      const res = new ResponseSync(buffer);
      expect(res.body).toBe(buffer);
    });

    it('creates with status and statusText', () => {
      const res = new ResponseSync(null, {
        status: 404,
        statusText: 'Not Found'
      });
      expect(res.status).toBe(404);
      expect(res.statusText).toBe('Not Found');
      expect(res.ok).toBe(false);
    });

    it('creates with headers', () => {
      const res = new ResponseSync(null, {
        headers: { 'Content-Type': 'application/json' }
      });
      expect(res.headers.get('Content-Type')).toBe('application/json');
    });
  });

  describe('json()', () => {
    it('parses string body as JSON', () => {
      const res = new ResponseSync('{"message":"Success"}');
      expect(res.json()).toEqual({ message: 'Success' });
    });

    it('returns object body as-is', () => {
      const body = { status: 'ok', count: 42 };
      const res = new ResponseSync(body);
      expect(res.json()).toEqual(body);
    });

    it('parses ArrayBuffer body as JSON', () => {
      const buffer = new TextEncoder().encode('{"test":"data"}').buffer;
      const res = new ResponseSync(buffer);
      expect(res.json()).toEqual({ test: 'data' });
    });

    it('returns null for no body', () => {
      const res = new ResponseSync();
      expect(res.json()).toBeNull();
    });
  });

  describe('text()', () => {
    it('returns string body as-is', () => {
      const body = '<h1>Hello</h1>';
      const res = new ResponseSync(body);
      expect(res.text()).toBe('<h1>Hello</h1>');
    });

    it('stringifies object body', () => {
      const body = { test: 'data' };
      const res = new ResponseSync(body);
      expect(res.text()).toBe('{"test":"data"}');
    });

    it('decodes ArrayBuffer body', () => {
      const buffer = new TextEncoder().encode('Hello').buffer;
      const res = new ResponseSync(buffer);
      expect(res.text()).toBe('Hello');
    });

    it('returns empty string for no body', () => {
      const res = new ResponseSync();
      expect(res.text()).toBe('');
    });
  });

  describe('arrayBuffer()', () => {
    it('returns ArrayBuffer body as-is', () => {
      const buffer = new TextEncoder().encode('Hello').buffer;
      const res = new ResponseSync(buffer);
      expect(res.arrayBuffer()).toBe(buffer);
    });

    it('encodes string body', () => {
      const res = new ResponseSync('Hello');
      const buffer = res.arrayBuffer();
      const text = new TextDecoder().decode(buffer);
      expect(text).toBe('Hello');
    });

    it('encodes object body', () => {
      const res = new ResponseSync({ test: 'data' });
      const buffer = res.arrayBuffer();
      const text = new TextDecoder().decode(buffer);
      expect(text).toBe('{"test":"data"}');
    });

    it('returns empty ArrayBuffer for no body', () => {
      const res = new ResponseSync();
      const buffer = res.arrayBuffer();
      expect(buffer.byteLength).toBe(0);
    });
  });

  describe('blob()', () => {
    it('returns Blob from body', () => {
      const res = new ResponseSync('Hello');
      const blob = res.blob();
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });
  });

  describe('formData()', () => {
    it('throws error (not supported)', () => {
      const res = new ResponseSync();
      expect(() => res.formData()).toThrow('FormData not supported');
    });
  });

  describe('metadata forwarders', () => {
    it('forwards status', () => {
      const res = new ResponseSync(null, { status: 201 });
      expect(res.status).toBe(201);
    });

    it('forwards statusText', () => {
      const res = new ResponseSync(null, { statusText: 'Created' });
      expect(res.statusText).toBe('Created');
    });

    it('forwards headers', () => {
      const res = new ResponseSync(null, {
        headers: { 'X-Custom': 'value' }
      });
      expect(res.headers.get('X-Custom')).toBe('value');
    });

    it('computes ok based on status', () => {
      const res200 = new ResponseSync(null, { status: 200 });
      expect(res200.ok).toBe(true);
      
      const res404 = new ResponseSync(null, { status: 404 });
      expect(res404.ok).toBe(false);
      
      const res500 = new ResponseSync(null, { status: 500 });
      expect(res500.ok).toBe(false);
    });

    it('forwards type', () => {
      const res = new ResponseSync();
      expect(res.type).toBeDefined();
    });

    it('forwards url', () => {
      const res = new ResponseSync();
      expect(res.url).toBeDefined();
    });

    it('forwards redirected', () => {
      const res = new ResponseSync();
      expect(typeof res.redirected).toBe('boolean');
    });
  });

  describe('clone()', () => {
    it('creates a copy with same properties', () => {
      const res = new ResponseSync(
        { message: 'Success' },
        {
          status: 201,
          statusText: 'Created',
          headers: { 'Content-Type': 'application/json' }
        }
      );
      
      const cloned = res.clone();
      
      expect(cloned.status).toBe(res.status);
      expect(cloned.statusText).toBe(res.statusText);
      expect(cloned.body).toEqual(res.body);
      expect(cloned.headers.get('Content-Type')).toBe('application/json');
    });

    it('creates shallow copy (body is shared reference)', () => {
      const body = { test: 'original' };
      const res = new ResponseSync(body);
      const cloned = res.clone();
      
      // Body is a shallow copy - same reference
      expect(cloned.body).toBe(res.body);
      
      // Modifying shared body affects both
      if (typeof cloned.body === 'object' && cloned.body !== null) {
        cloned.body.test = 'modified';
      }
      expect((res.body as any).test).toBe('modified');
    });
  });

  describe('toResponse()', () => {
    it('converts to real Response', () => {
      const res = new ResponseSync(
        { message: 'Success' },
        {
          status: 201,
          statusText: 'Created',
          headers: { 'Content-Type': 'application/json' }
        }
      );
      
      const realResponse = res.toResponse();
      
      expect(realResponse).toBeInstanceOf(Response);
      expect(realResponse.status).toBe(201);
      expect(realResponse.statusText).toBe('Created');
      expect(realResponse.headers.get('Content-Type')).toBe('application/json');
    });
  });

  describe('fromResponse()', () => {
    it('converts real Response with JSON body', async () => {
      const realResponse = new Response('{"test":"data"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
      const syncResponse = await ResponseSync.fromResponse(realResponse);
      
      expect(syncResponse.status).toBe(200);
      expect(syncResponse.json()).toEqual({ test: 'data' });
    });

    it('converts real Response with text body', async () => {
      const realResponse = new Response('Hello World', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      });
      
      const syncResponse = await ResponseSync.fromResponse(realResponse);
      
      expect(syncResponse.text()).toBe('Hello World');
    });

    it('converts real Response with binary body', async () => {
      const buffer = new TextEncoder().encode('Binary Data').buffer;
      const realResponse = new Response(buffer, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' }
      });
      
      const syncResponse = await ResponseSync.fromResponse(realResponse);
      
      expect(syncResponse.arrayBuffer()).toEqual(buffer);
    });

    it('converts real Response with no body', async () => {
      const realResponse = new Response(null, { status: 204 });
      
      const syncResponse = await ResponseSync.fromResponse(realResponse);
      
      expect(syncResponse.status).toBe(204);
      expect(syncResponse.body).toBeNull();
    });

    it('preserves headers', async () => {
      const realResponse = new Response('test', {
        headers: {
          'X-Custom': 'value',
          'Content-Type': 'text/plain'
        }
      });
      
      const syncResponse = await ResponseSync.fromResponse(realResponse);
      
      expect(syncResponse.headers.get('X-Custom')).toBe('value');
      expect(syncResponse.headers.get('Content-Type')).toBe('text/plain');
    });
  });

  describe('edge cases', () => {
    it('handles null body explicitly', () => {
      const res = new ResponseSync(null);
      expect(res.body).toBeNull();
      expect(res.text()).toBe('');
      expect(res.json()).toBeNull();
    });

    it('handles empty string body', () => {
      const res = new ResponseSync('');
      expect(res.text()).toBe('');
    });

    it('handles empty object body', () => {
      const res = new ResponseSync({});
      expect(res.json()).toEqual({});
      expect(res.text()).toBe('{}');
    });

    it('handles special characters in body', () => {
      const body = { message: 'Hello "World" \n\t' };
      const res = new ResponseSync(body);
      expect(res.json()).toEqual(body);
    });

    it('handles large body', () => {
      const largeBody = { data: 'x'.repeat(10000) };
      const res = new ResponseSync(largeBody);
      expect(res.json()).toEqual(largeBody);
    });

    it('handles various status codes', () => {
      // Only test valid Response status codes (200-599)
      const statuses = [200, 201, 204, 301, 400, 404, 500, 503];
      for (const status of statuses) {
        const res = new ResponseSync(null, { status });
        expect(res.status).toBe(status);
        expect(res.ok).toBe(status >= 200 && status < 300);
      }
    });
  });

  describe('round-trip conversion', () => {
    it('can convert to Response and back', async () => {
      // Use string body for round-trip to avoid Response body serialization
      const original = new ResponseSync(
        '{"message":"Test"}',
        {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'application/json' }
        }
      );
      
      const realResponse = original.toResponse();
      const converted = await ResponseSync.fromResponse(realResponse);
      
      expect(converted.status).toBe(original.status);
      expect(converted.statusText).toBe(original.statusText);
      expect(converted.json()).toEqual({ message: 'Test' });
    });
  });

  describe('Round-trip Serialization', () => {
    it('handles simple ResponseSync round-trip', async () => {
      const responseSync = new ResponseSync('Hello World');
      const result = await parse(await stringify(responseSync));
      
      expect(result).toBeInstanceOf(ResponseSync);
      expect(result.text()).toBe('Hello World');
      expect(result.status).toBe(200);
    });

    it('handles ResponseSync with status round-trip', async () => {
      const responseSync = new ResponseSync('Not Found', { 
        status: 404, 
        statusText: 'Not Found' 
      });
      const result = await parse(await stringify(responseSync));
      
      expect(result).toBeInstanceOf(ResponseSync);
      expect(result.status).toBe(404);
      expect(result.statusText).toBe('Not Found');
      expect(result.text()).toBe('Not Found');
    });

    it('handles ResponseSync with JSON body round-trip', async () => {
      const body = { message: 'Success', data: [1, 2, 3] };
      const responseSync = new ResponseSync(body, {
        status: 201,
        statusText: 'Created'
      });
      const result = await parse(await stringify(responseSync));
      
      expect(result).toBeInstanceOf(ResponseSync);
      expect(result.status).toBe(201);
      expect(result.statusText).toBe('Created');
      expect(result.json()).toEqual(body);
    });

    it('handles ResponseSync with headers round-trip', async () => {
      const responseSync = new ResponseSync('test', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'max-age=3600',
          'X-Custom-Header': 'custom-value'
        }
      });
      const result = await parse(await stringify(responseSync));
      
      expect(result).toBeInstanceOf(ResponseSync);
      expect(result.headers.get('Content-Type')).toBe('application/json');
      expect(result.headers.get('Cache-Control')).toBe('max-age=3600');
      expect(result.headers.get('X-Custom-Header')).toBe('custom-value');
    });

    it('handles ResponseSync with ArrayBuffer body round-trip', async () => {
      const buffer = new TextEncoder().encode('Binary data').buffer;
      const responseSync = new ResponseSync(buffer);
      const result = await parse(await stringify(responseSync));
      
      expect(result).toBeInstanceOf(ResponseSync);
      expect(result.arrayBuffer()).toEqual(buffer);
    });

    it('handles ResponseSync in arrays round-trip', async () => {
      const responses = [
        new ResponseSync('First', { status: 200 }),
        new ResponseSync('Second', { status: 201 })
      ];
      const result = await parse(await stringify(responses));
      
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(ResponseSync);
      expect(result[0].text()).toBe('First');
      expect(result[1]).toBeInstanceOf(ResponseSync);
      expect(result[1].text()).toBe('Second');
    });

    it('handles ResponseSync in nested objects round-trip', async () => {
      const obj = {
        response: new ResponseSync({ success: true }),
        metadata: { timestamp: Date.now() }
      };
      const result = await parse(await stringify(obj));
      
      expect(result.response).toBeInstanceOf(ResponseSync);
      expect(result.response.json()).toEqual({ success: true });
    });
  });
});

