import { describe, it, expect } from 'vitest';
// Test the re-exported functions from @lumenize/utils for backwards compatibility
import {
  serializeWebApiObject,
  deserializeWebApiObject,
  isSerializedWebApiObject,
  isWebApiObject,
} from '../../src/index';

describe('Web API Serialization', () => {
  describe('isWebApiObject', () => {
    it('identifies Request objects', () => {
      const req = new Request('https://example.com');
      expect(isWebApiObject(req)).toBe(true);
    });

    it('identifies Response objects', () => {
      const res = new Response('test');
      expect(isWebApiObject(res)).toBe(true);
    });

    it('identifies Headers objects', () => {
      const headers = new Headers({ 'content-type': 'application/json' });
      expect(isWebApiObject(headers)).toBe(true);
    });

    it('identifies URL objects', () => {
      const url = new URL('https://example.com');
      expect(isWebApiObject(url)).toBe(true);
    });

    it('returns false for plain objects', () => {
      expect(isWebApiObject({})).toBe(false);
      expect(isWebApiObject({ url: 'https://example.com' })).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(isWebApiObject('string')).toBe(false);
      expect(isWebApiObject(123)).toBe(false);
      expect(isWebApiObject(null)).toBe(false);
      expect(isWebApiObject(undefined)).toBe(false);
    });
  });

  describe('isSerializedWebApiObject', () => {
    it('identifies serialized Request', () => {
      const obj = { __isSerializedRequest: true };
      expect(isSerializedWebApiObject(obj)).toBe(true);
    });

    it('identifies serialized Response', () => {
      const obj = { __isSerializedResponse: true };
      expect(isSerializedWebApiObject(obj)).toBe(true);
    });

    it('identifies serialized Headers', () => {
      const obj = { __isSerializedHeaders: true };
      expect(isSerializedWebApiObject(obj)).toBe(true);
    });

    it('identifies serialized URL', () => {
      const obj = { __isSerializedURL: true };
      expect(isSerializedWebApiObject(obj)).toBe(true);
    });

    it('returns false for plain objects', () => {
      expect(isSerializedWebApiObject({})).toBeFalsy();
      expect(isSerializedWebApiObject({ url: 'https://example.com' })).toBeFalsy();
    });

    it('returns false for primitives', () => {
      expect(isSerializedWebApiObject('string')).toBeFalsy();
      expect(isSerializedWebApiObject(123)).toBeFalsy();
      expect(isSerializedWebApiObject(null)).toBeFalsy();
      expect(isSerializedWebApiObject(undefined)).toBeFalsy();
    });
  });

  describe('Request serialization', () => {
    it('serializes and deserializes a simple GET request', async () => {
      const original = new Request('https://example.com/api/test');
      const serialized = await serializeWebApiObject(original);
      
      expect(serialized.__isSerializedRequest).toBe(true);
      expect(serialized.url).toBe('https://example.com/api/test');
      expect(serialized.method).toBe('GET');
      
      const deserialized = deserializeWebApiObject(serialized);
      expect(deserialized).toBeInstanceOf(Request);
      expect(deserialized.url).toBe('https://example.com/api/test');
      expect(deserialized.method).toBe('GET');
    });

    it('serializes and deserializes POST request with body', async () => {
      const original = new Request('https://example.com/api/test', {
        method: 'POST',
        body: JSON.stringify({ foo: 'bar' }),
        headers: { 'content-type': 'application/json' },
      });
      
      const serialized = await serializeWebApiObject(original);
      expect(serialized.__isSerializedRequest).toBe(true);
      expect(serialized.method).toBe('POST');
      expect(serialized.body).toBe('{"foo":"bar"}');
      expect(serialized.headers.__isSerializedHeaders).toBe(true);
      
      const deserialized = deserializeWebApiObject(serialized);
      expect(deserialized).toBeInstanceOf(Request);
      expect(deserialized.method).toBe('POST');
      expect(await deserialized.text()).toBe('{"foo":"bar"}');
    });

    it('serializes and deserializes request with custom headers', async () => {
      const original = new Request('https://example.com', {
        headers: {
          'x-custom-header': 'custom-value',
          'authorization': 'Bearer token123',
        },
      });
      
      const serialized = await serializeWebApiObject(original);
      const deserialized = deserializeWebApiObject(serialized);
      
      expect(deserialized.headers.get('x-custom-header')).toBe('custom-value');
      expect(deserialized.headers.get('authorization')).toBe('Bearer token123');
    });
  });

  describe('Response serialization', () => {
    it('serializes and deserializes a simple response', async () => {
      const original = new Response('Hello World', {
        status: 200,
        statusText: 'OK',
      });
      
      const serialized = await serializeWebApiObject(original);
      expect(serialized.__isSerializedResponse).toBe(true);
      expect(serialized.status).toBe(200);
      expect(serialized.statusText).toBe('OK');
      expect(serialized.body).toBe('Hello World');
      
      const deserialized = deserializeWebApiObject(serialized);
      expect(deserialized).toBeInstanceOf(Response);
      expect(deserialized.status).toBe(200);
      expect(deserialized.statusText).toBe('OK');
      expect(await deserialized.text()).toBe('Hello World');
    });

    it('serializes and deserializes JSON response', async () => {
      const original = new Response(JSON.stringify({ success: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
      
      const serialized = await serializeWebApiObject(original);
      const deserialized = deserializeWebApiObject(serialized);
      
      expect(deserialized.status).toBe(201);
      expect(deserialized.headers.get('content-type')).toBe('application/json');
      const json = await deserialized.json();
      expect(json).toEqual({ success: true });
    });

    it('serializes and deserializes error responses', async () => {
      const original = new Response('Not Found', {
        status: 404,
        statusText: 'Not Found',
      });
      
      const serialized = await serializeWebApiObject(original);
      const deserialized = deserializeWebApiObject(serialized);
      
      expect(deserialized.status).toBe(404);
      expect(deserialized.statusText).toBe('Not Found');
      expect(deserialized.ok).toBe(false);
    });

    it('handles empty response body', async () => {
      const original = new Response(null, { status: 204 });
      
      const serialized = await serializeWebApiObject(original);
      const deserialized = deserializeWebApiObject(serialized);
      
      expect(deserialized.status).toBe(204);
      const text = await deserialized.text();
      expect(text).toBe('');
    });
  });

  describe('Headers serialization', () => {
    it('serializes and deserializes Headers object', async () => {
      const original = new Headers({
        'content-type': 'application/json',
        'x-custom': 'value',
      });
      
      const serialized = await serializeWebApiObject(original);
      expect(serialized.__isSerializedHeaders).toBe(true);
      expect(serialized.entries).toBeInstanceOf(Array);
      expect(serialized.entries.length).toBe(2);
      
      const deserialized = deserializeWebApiObject(serialized);
      expect(deserialized).toBeInstanceOf(Headers);
      expect(deserialized.get('content-type')).toBe('application/json');
      expect(deserialized.get('x-custom')).toBe('value');
    });

    it('handles empty Headers', async () => {
      const original = new Headers();
      const serialized = await serializeWebApiObject(original);
      const deserialized = deserializeWebApiObject(serialized);
      
      expect(deserialized).toBeInstanceOf(Headers);
      expect([...deserialized.entries()]).toHaveLength(0);
    });

    it('preserves header case', async () => {
      const original = new Headers({
        'X-Custom-Header': 'value',
      });
      
      const serialized = await serializeWebApiObject(original);
      const deserialized = deserializeWebApiObject(serialized);
      
      // Headers normalize to lowercase
      expect(deserialized.get('x-custom-header')).toBe('value');
      expect(deserialized.get('X-Custom-Header')).toBe('value');
    });
  });

  describe('URL serialization', () => {
    it('serializes and deserializes URL object', async () => {
      const original = new URL('https://example.com/path?query=value#hash');
      
      const serialized = await serializeWebApiObject(original);
      expect(serialized.__isSerializedURL).toBe(true);
      expect(serialized.href).toBe('https://example.com/path?query=value#hash');
      
      const deserialized = deserializeWebApiObject(serialized);
      expect(deserialized).toBeInstanceOf(URL);
      expect(deserialized.href).toBe('https://example.com/path?query=value#hash');
      expect(deserialized.pathname).toBe('/path');
      expect(deserialized.search).toBe('?query=value');
      expect(deserialized.hash).toBe('#hash');
    });
  });

  describe('Pass-through for non-Web API objects', () => {
    it('returns primitives unchanged', async () => {
      expect(await serializeWebApiObject('string')).toBe('string');
      expect(await serializeWebApiObject(123)).toBe(123);
      expect(await serializeWebApiObject(true)).toBe(true);
      expect(await serializeWebApiObject(null)).toBe(null);
      expect(await serializeWebApiObject(undefined)).toBe(undefined);
    });

    it('returns plain objects unchanged', async () => {
      const obj = { foo: 'bar', baz: 123 };
      expect(await serializeWebApiObject(obj)).toBe(obj);
    });

    it('deserializes primitives unchanged', () => {
      expect(deserializeWebApiObject('string')).toBe('string');
      expect(deserializeWebApiObject(123)).toBe(123);
      expect(deserializeWebApiObject(true)).toBe(true);
      expect(deserializeWebApiObject(null)).toBe(null);
      expect(deserializeWebApiObject(undefined)).toBe(undefined);
    });

    it('deserializes plain objects unchanged', () => {
      const obj = { foo: 'bar', baz: 123 };
      expect(deserializeWebApiObject(obj)).toBe(obj);
    });
  });
});
