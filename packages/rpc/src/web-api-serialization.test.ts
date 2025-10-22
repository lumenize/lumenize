import { describe, it, expect } from 'vitest';
import { serializeWebApiObject, deserializeWebApiObject } from './web-api-serialization';

describe('web-api-serialization', () => {
  describe('Request serialization', () => {
    it('serializes Request without body', async () => {
      const request = new Request('https://example.com/api', {
        method: 'GET',
        headers: { 'X-Custom': 'value' },
      });

      const serialized = await serializeWebApiObject(request);

      expect(serialized.__isSerializedRequest).toBe(true);
      expect(serialized.method).toBe('GET');
      expect(serialized.url).toBe('https://example.com/api');
      expect(serialized.headers.__isSerializedHeaders).toBe(true);
    });

    it('serializes Request with body', async () => {
      const request = new Request('https://example.com/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' }),
      });

      const serialized = await serializeWebApiObject(request);

      expect(serialized.__isSerializedRequest).toBe(true);
      expect(serialized.method).toBe('POST');
      expect(serialized.body).toBe('{"test":"data"}');
      expect(serialized.bodyType).toBe('text');
    });

    it('deserializes Request without body', () => {
      const serialized = {
        __isSerializedRequest: true,
        method: 'GET',
        url: 'https://example.com/api',
        headers: {
          __isSerializedHeaders: true,
          entries: [['X-Custom', 'value']],
        },
        redirect: 'follow',
        integrity: '',
        keepalive: false,
        signal: null,
      };

      const request = deserializeWebApiObject(serialized);

      expect(request).toBeInstanceOf(Request);
      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://example.com/api');
      expect(request.headers.get('X-Custom')).toBe('value');
    });

    it('deserializes Request with body', () => {
      const serialized = {
        __isSerializedRequest: true,
        method: 'POST',
        url: 'https://example.com/api',
        headers: {
          __isSerializedHeaders: true,
          entries: [['Content-Type', 'application/json']],
        },
        body: '{"test":"data"}',
        bodyType: 'text',
        redirect: 'follow',
        integrity: '',
        keepalive: false,
        signal: null,
      };

      const request = deserializeWebApiObject(serialized);

      expect(request).toBeInstanceOf(Request);
      expect(request.method).toBe('POST');
      expect(request.headers.get('Content-Type')).toBe('application/json');
    });

    it('round-trips Request without body', async () => {
      const original = new Request('https://example.com/test', {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer token' },
      });

      const serialized = await serializeWebApiObject(original);
      const deserialized = deserializeWebApiObject(serialized);

      expect(deserialized).toBeInstanceOf(Request);
      expect(deserialized.method).toBe('DELETE');
      expect(deserialized.url).toBe('https://example.com/test');
      expect(deserialized.headers.get('Authorization')).toBe('Bearer token');
    });

    it('round-trips Request with body', async () => {
      const original = new Request('https://example.com/test', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'test body content',
      });

      const serialized = await serializeWebApiObject(original);
      const deserialized = deserializeWebApiObject(serialized);

      expect(deserialized).toBeInstanceOf(Request);
      expect(deserialized.method).toBe('POST');
      expect(await deserialized.text()).toBe('test body content');
    });
  });

  describe('Response serialization', () => {
    it('serializes Response without body', async () => {
      const response = new Response(null, {
        status: 204,
        statusText: 'No Content',
        headers: { 'X-Response': 'header' },
      });

      const serialized = await serializeWebApiObject(response);

      expect(serialized.__isSerializedResponse).toBe(true);
      expect(serialized.status).toBe(204);
      expect(serialized.statusText).toBe('No Content');
      expect(serialized.ok).toBe(true);
      expect(serialized.headers.__isSerializedHeaders).toBe(true);
    });

    it('serializes Response with body', async () => {
      const response = new Response('{"result":"success"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      const serialized = await serializeWebApiObject(response);

      expect(serialized.__isSerializedResponse).toBe(true);
      expect(serialized.status).toBe(200);
      expect(serialized.body).toBe('{"result":"success"}');
      expect(serialized.bodyType).toBe('text');
    });

    it('deserializes Response without body', () => {
      const serialized = {
        __isSerializedResponse: true,
        status: 404,
        statusText: 'Not Found',
        headers: {
          __isSerializedHeaders: true,
          entries: [['X-Error', 'not-found']],
        },
        ok: false,
        redirected: false,
        type: 'default',
        url: '',
      };

      const response = deserializeWebApiObject(serialized);

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(404);
      expect(response.statusText).toBe('Not Found');
      expect(response.ok).toBe(false);
      expect(response.headers.get('X-Error')).toBe('not-found');
    });

    it('deserializes Response with body', async () => {
      const serialized = {
        __isSerializedResponse: true,
        status: 200,
        statusText: 'OK',
        headers: {
          __isSerializedHeaders: true,
          entries: [['Content-Type', 'text/plain']],
        },
        body: 'response body',
        bodyType: 'text',
        ok: true,
        redirected: false,
        type: 'default',
        url: '',
      };

      const response = deserializeWebApiObject(serialized);

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('response body');
    });

    it('round-trips Response without body', async () => {
      const original = new Response(null, {
        status: 304,
        statusText: 'Not Modified',
        headers: { 'Cache-Control': 'max-age=3600' },
      });

      const serialized = await serializeWebApiObject(original);
      const deserialized = deserializeWebApiObject(serialized);

      expect(deserialized).toBeInstanceOf(Response);
      expect(deserialized.status).toBe(304);
      expect(deserialized.statusText).toBe('Not Modified');
      expect(deserialized.headers.get('Cache-Control')).toBe('max-age=3600');
    });

    it('round-trips Response with body', async () => {
      const original = new Response('test content', {
        status: 201,
        statusText: 'Created',
        headers: { 'Location': '/resource/123' },
      });

      const serialized = await serializeWebApiObject(original);
      const deserialized = deserializeWebApiObject(serialized);

      expect(deserialized).toBeInstanceOf(Response);
      expect(deserialized.status).toBe(201);
      expect(await deserialized.text()).toBe('test content');
    });
  });

  describe('Headers serialization', () => {
    it('serializes empty Headers', async () => {
      const headers = new Headers();

      const serialized = await serializeWebApiObject(headers);

      expect(serialized.__isSerializedHeaders).toBe(true);
      expect(serialized.entries).toEqual([]);
    });

    it('serializes Headers with entries', async () => {
      const headers = new Headers({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token',
      });

      const serialized = await serializeWebApiObject(headers);

      expect(serialized.__isSerializedHeaders).toBe(true);
      expect(serialized.entries.length).toBe(2);
      expect(serialized.entries).toContainEqual(['content-type', 'application/json']);
      expect(serialized.entries).toContainEqual(['authorization', 'Bearer token']);
    });

    it('deserializes Headers', () => {
      const serialized = {
        __isSerializedHeaders: true,
        entries: [
          ['content-type', 'text/html'],
          ['x-custom', 'value'],
        ],
      };

      const headers = deserializeWebApiObject(serialized);

      expect(headers).toBeInstanceOf(Headers);
      expect(headers.get('content-type')).toBe('text/html');
      expect(headers.get('x-custom')).toBe('value');
    });

    it('round-trips Headers', async () => {
      const original = new Headers({
        'Accept': 'application/json',
        'Accept-Language': 'en-US',
        'X-Request-ID': '12345',
      });

      const serialized = await serializeWebApiObject(original);
      const deserialized = deserializeWebApiObject(serialized);

      expect(deserialized).toBeInstanceOf(Headers);
      expect(deserialized.get('Accept')).toBe('application/json');
      expect(deserialized.get('Accept-Language')).toBe('en-US');
      expect(deserialized.get('X-Request-ID')).toBe('12345');
    });
  });

  describe('URL serialization', () => {
    it('serializes URL', async () => {
      const url = new URL('https://example.com/path?query=value#hash');

      const serialized = await serializeWebApiObject(url);

      expect(serialized.__isSerializedURL).toBe(true);
      expect(serialized.href).toBe('https://example.com/path?query=value#hash');
    });

    it('deserializes URL', () => {
      const serialized = {
        __isSerializedURL: true,
        href: 'https://example.com/test?foo=bar',
      };

      const url = deserializeWebApiObject(serialized);

      expect(url).toBeInstanceOf(URL);
      expect(url.href).toBe('https://example.com/test?foo=bar');
      expect(url.pathname).toBe('/test');
      expect(url.search).toBe('?foo=bar');
    });

    it('round-trips URL', async () => {
      const original = new URL('https://user:pass@example.com:8080/path?q=1#section');

      const serialized = await serializeWebApiObject(original);
      const deserialized = deserializeWebApiObject(serialized);

      expect(deserialized).toBeInstanceOf(URL);
      expect(deserialized.href).toBe(original.href);
      expect(deserialized.protocol).toBe(original.protocol);
      expect(deserialized.hostname).toBe(original.hostname);
      expect(deserialized.port).toBe(original.port);
      expect(deserialized.pathname).toBe(original.pathname);
      expect(deserialized.search).toBe(original.search);
      expect(deserialized.hash).toBe(original.hash);
    });
  });

  describe('non-Web API objects', () => {
    it('returns primitives as-is', async () => {
      expect(await serializeWebApiObject(null)).toBe(null);
      expect(await serializeWebApiObject(undefined)).toBe(undefined);
      expect(await serializeWebApiObject(42)).toBe(42);
      expect(await serializeWebApiObject('string')).toBe('string');
      expect(await serializeWebApiObject(true)).toBe(true);
    });

    it('returns plain objects as-is', async () => {
      const obj = { foo: 'bar', nested: { value: 123 } };
      expect(await serializeWebApiObject(obj)).toEqual(obj);
    });

    it('returns arrays as-is', async () => {
      const arr = [1, 2, { key: 'value' }];
      expect(await serializeWebApiObject(arr)).toEqual(arr);
    });

    it('deserializes primitives as-is', () => {
      expect(deserializeWebApiObject(null)).toBe(null);
      expect(deserializeWebApiObject(undefined)).toBe(undefined);
      expect(deserializeWebApiObject(42)).toBe(42);
      expect(deserializeWebApiObject('string')).toBe('string');
      expect(deserializeWebApiObject(true)).toBe(true);
    });

    it('deserializes plain objects as-is', () => {
      const obj = { foo: 'bar', nested: { value: 123 } };
      expect(deserializeWebApiObject(obj)).toEqual(obj);
    });
  });
});
