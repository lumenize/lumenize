/**
 * Reusable behavior test functions
 * 
 * These test functions can be run against any RPC client configuration
 * (WebSocket/HTTP × lumenizeRpcDO/handleRpcRequest × Base/Subclass)
 */

import { expect } from 'vitest';
import type { RpcAccessible } from '../../src/types';

/**
 * Interface for testable clients that behavior tests can run against
 */
export interface TestableClient<T = any> {
  client: RpcAccessible<T>;
  cleanup?: () => void | Promise<void>;
}

/**
 * Type for behavior test functions
 */
export type BehaviorTest<T = any> = (testable: TestableClient<T>) => Promise<void>;

/**
 * Basic increment test
 */
export async function testIncrement(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).increment();
  expect(typeof result).toBe('number');
  expect(result).toBeGreaterThan(0);
}

/**
 * Multiple increments should increase counter
 */
export async function testMultipleIncrements(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const first = await (client as any).increment();
  const second = await (client as any).increment();
  expect(second).toBe(first + 1);
}

/**
 * Add method with arguments
 */
export async function testAdd(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).add(5, 3);
  expect(result).toBe(8);
}

/**
 * Error throwing - Error object
 */
export async function testThrowError(testable: TestableClient): Promise<void> {
  const { client } = testable;
  await expect((client as any).throwError('Test error')).rejects.toThrow();
}

/**
 * Error throwing - String
 */
export async function testThrowString(testable: TestableClient): Promise<void> {
  const { client } = testable;
  await expect((client as any).throwString('String error')).rejects.toThrow();
}

/**
 * Get object with nested functions
 */
export async function testGetObject(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).getObject();
  expect(result.value).toBe(42);
  expect(result.nested).toBeDefined();
  expect(result.nested.value).toBe(42);
  // Nested function should be accessible
  const nestedResult = await result.nested.getValue();
  expect(nestedResult).toBe(42);
}

/**
 * Get array
 */
export async function testGetArray(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).getArray();
  expect(Array.isArray(result)).toBe(true);
  expect(result).toEqual([1, 2, 3, 4, 5]);
}

/**
 * Get array with functions
 */
export async function testGetArrayWithFunctions(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).getArrayWithFunctions();
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(5);
  expect(result[0]).toBe(1);
  expect(result[1]).toBe(2);
  // Element [2] is a function that should be remotely callable
  expect(typeof result[2]).toBe('function');
  // Element [3] is an object with a function
  expect(result[3].value).toBe(42);
  expect(typeof result[3].getValue).toBe('function');
  expect(result[4]).toBe(5);
}

/**
 * Class instance with prototype methods
 */
export async function testGetClassInstance(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).getClassInstance();
  expect(result.value).toBe(42);
  expect(result.name).toBe('TestModel');
  
  // Prototype methods should be accessible
  expect(typeof result.getValue).toBe('function');
  expect(typeof result.getName).toBe('function');
  expect(typeof result.compute).toBe('function');
  
  // Should be able to call them
  const value = await result.getValue();
  expect(value).toBe(42);
  const name = await result.getName();
  expect(name).toBe('TestModel');
  const computed = await result.compute();
  expect(computed).toBe(84);
}

/**
 * Deeply nested objects
 */
export async function testGetDeeplyNested(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).getDeeplyNested();
  expect(result.level1.level2.level3.value).toBe('deep');
  
  // Nested function should work
  const nestedValue = await result.level1.level2.level3.getValue();
  expect(nestedValue).toBe('deeply nested value');
}

/**
 * Circular reference handling - echo method preserves circular references
 */
export async function testEchoCircularReference(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create an object with a circular reference
  const circular: any = { name: 'circular' };
  circular.self = circular;
  
  // Echo it through RPC
  const echoed = await (client as any).echo(circular);
  
  // Verify the circular reference is preserved
  expect(echoed.name).toBe('circular');
  expect(echoed.self).toBe(echoed);
  expect(echoed).toEqual(circular);
}

/**
 * Object inspection via __asObject()
 */
export async function testAsObject(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const asObject = await (client as any).__asObject();
  
  // Should have DO methods
  expect(asObject.increment).toContain('Function');
  expect(asObject.add).toContain('Function');
  expect(asObject.throwError).toContain('Function');
  
  // Should have ctx
  expect(asObject.ctx).toBeDefined();
  expect(asObject.ctx.storage).toBeDefined();
  expect(asObject.ctx.storage.get).toContain('Function');
  expect(asObject.ctx.storage.put).toContain('Function');
  
  // Should have nested storage objects
  expect(asObject.ctx.storage.kv).toBeDefined();
  expect(asObject.ctx.storage.sql).toBeDefined();
  
  // Getter property test (databaseSize)
  expect(typeof asObject.ctx.storage.sql.databaseSize).toBe('number');
  
  // Should have env
  expect(asObject.env).toBeDefined();
}

/**
 * Slow increment (async operation)
 */
export async function testSlowIncrement(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).slowIncrement(50);
  expect(typeof result).toBe('number');
  expect(result).toBeGreaterThan(0);
}

/**
 * Web API - Echo Request object (client → server → client)
 */
export async function testEchoRequest(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a Request on the client
  const originalRequest = new Request('https://example.com/api/test', {
    method: 'POST',
    headers: new Headers({
      'Content-Type': 'application/json',
      'X-Custom-Header': 'test-value',
    }),
    body: JSON.stringify({ test: 'data' }),
  });
  
  // Send it to the server and get it back
  const echoedRequest = await (client as any).echo(originalRequest);
  
  // Verify it's a proper Request instance
  expect(echoedRequest).toBeInstanceOf(Request);
  
  // Verify basic properties match
  expect(echoedRequest.method).toBe('POST');
  expect(echoedRequest.url).toBe('https://example.com/api/test');
  
  // Verify headers are preserved
  expect(echoedRequest.headers).toBeInstanceOf(Headers);
  expect(echoedRequest.headers.get('Content-Type')).toBe('application/json');
  expect(echoedRequest.headers.get('X-Custom-Header')).toBe('test-value');
  
  // Verify body is preserved
  const body = await echoedRequest.text();
  expect(body).toBe(JSON.stringify({ test: 'data' }));
}

/**
 * Web API - Echo Response object (client → server → client)
 */
export async function testEchoResponse(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a Response on the client
  const originalResponse = new Response(JSON.stringify({ success: true, data: 'test' }), {
    status: 200,
    statusText: 'OK',
    headers: new Headers({
      'Content-Type': 'application/json',
      'X-Response-Id': '12345',
    }),
  });
  
  // Send it to the server and get it back
  const echoedResponse = await (client as any).echo(originalResponse);
  
  // Verify it's a proper Response instance
  expect(echoedResponse).toBeInstanceOf(Response);
  
  // Verify basic properties match
  expect(echoedResponse.status).toBe(200);
  expect(echoedResponse.statusText).toBe('OK');
  expect(echoedResponse.ok).toBe(true);
  
  // Verify headers are preserved
  expect(echoedResponse.headers).toBeInstanceOf(Headers);
  expect(echoedResponse.headers.get('Content-Type')).toBe('application/json');
  expect(echoedResponse.headers.get('X-Response-Id')).toBe('12345');
  
  // Verify body is preserved
  const body = await echoedResponse.text();
  expect(body).toBe(JSON.stringify({ success: true, data: 'test' }));
}

/**
 * Web API - Echo Headers object (client → server → client)
 */
export async function testEchoHeaders(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create Headers on the client
  const originalHeaders = new Headers();
  originalHeaders.set('Authorization', 'Bearer token123');
  originalHeaders.set('Accept', 'application/json');
  originalHeaders.set('X-API-Key', 'secret-key');
  
  // Send it to the server and get it back
  const echoedHeaders = await (client as any).echo(originalHeaders);
  
  // Verify it's a proper Headers instance
  expect(echoedHeaders).toBeInstanceOf(Headers);
  
  // Verify headers are preserved
  expect(echoedHeaders.get('Authorization')).toBe('Bearer token123');
  expect(echoedHeaders.get('Accept')).toBe('application/json');
  expect(echoedHeaders.get('X-API-Key')).toBe('secret-key');
  
  // Verify has() method works
  expect(echoedHeaders.has('Authorization')).toBe(true);
  expect(echoedHeaders.has('NonExistent')).toBe(false);
  
  // Verify headers can be iterated
  const headerEntries = Array.from(echoedHeaders.entries());
  expect(headerEntries.length).toBe(3);
  expect(headerEntries).toContainEqual(['authorization', 'Bearer token123']);
  expect(headerEntries).toContainEqual(['accept', 'application/json']);
  expect(headerEntries).toContainEqual(['x-api-key', 'secret-key']);
}

/**
 * Web API - Echo URL object (client → server → client)
 */
export async function testEchoURL(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a URL on the client
  const originalURL = new URL('https://example.com/path?param1=value1&param2=value2#hash');
  
  // Send it to the server and get it back
  const echoedURL = await (client as any).echo(originalURL);
  
  // Verify it's a proper URL instance
  expect(echoedURL).toBeInstanceOf(URL);
  
  // Verify basic properties match
  expect(echoedURL.href).toBe('https://example.com/path?param1=value1&param2=value2#hash');
  expect(echoedURL.protocol).toBe('https:');
  expect(echoedURL.hostname).toBe('example.com');
  expect(echoedURL.pathname).toBe('/path');
  expect(echoedURL.search).toBe('?param1=value1&param2=value2');
  expect(echoedURL.hash).toBe('#hash');
  
  // Verify searchParams works
  expect(echoedURL.searchParams.get('param1')).toBe('value1');
  expect(echoedURL.searchParams.get('param2')).toBe('value2');
  
  // Verify toString() method
  expect(echoedURL.toString()).toBe('https://example.com/path?param1=value1&param2=value2#hash');
}

/**
 * Web API - Echo nested Web API objects (client → server → client)
 */
export async function testEchoNestedWebApi(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a complex object with nested Web API objects
  const complexObject = {
    request: new Request('https://example.com/test', { method: 'POST' }),
    response: new Response('test body', { status: 200 }),
    headers: new Headers({ 'X-Test': 'value' }),
    url: new URL('https://example.com'),
    nested: {
      deepRequest: new Request('https://example.com/deep', { method: 'GET' }),
      deepHeaders: new Headers({ 'X-Deep': 'nested' }),
    },
    array: [
      new URL('https://url1.com'),
      new URL('https://url2.com'),
    ],
  };
  
  // Send it to the server and get it back
  const echoed = await (client as any).echo(complexObject);
  
  // Verify all Web API objects are properly reconstructed
  expect(echoed.request).toBeInstanceOf(Request);
  expect(echoed.request.url).toBe('https://example.com/test');
  expect(echoed.request.method).toBe('POST');
  
  expect(echoed.response).toBeInstanceOf(Response);
  expect(echoed.response.status).toBe(200);
  const body = await echoed.response.text();
  expect(body).toBe('test body');
  
  expect(echoed.headers).toBeInstanceOf(Headers);
  expect(echoed.headers.get('X-Test')).toBe('value');
  
  expect(echoed.url).toBeInstanceOf(URL);
  expect(echoed.url.href).toBe('https://example.com/');
  
  // Verify nested Web API objects
  expect(echoed.nested.deepRequest).toBeInstanceOf(Request);
  expect(echoed.nested.deepRequest.url).toBe('https://example.com/deep');
  expect(echoed.nested.deepRequest.method).toBe('GET');
  
  expect(echoed.nested.deepHeaders).toBeInstanceOf(Headers);
  expect(echoed.nested.deepHeaders.get('X-Deep')).toBe('nested');
  
  // Verify array of Web API objects
  expect(Array.isArray(echoed.array)).toBe(true);
  expect(echoed.array[0]).toBeInstanceOf(URL);
  expect(echoed.array[0].href).toBe('https://url1.com/');
  expect(echoed.array[1]).toBeInstanceOf(URL);
  expect(echoed.array[1].href).toBe('https://url2.com/');
}

/**
 * Built-in types - Echo Date (client → server → client)
 */
export async function testEchoDate(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a Date object
  const originalDate = new Date('2025-01-01T00:00:00.000Z');
  
  // Send it to the server and get it back
  const echoedDate = await (client as any).echo(originalDate);
  
  // Verify it's a proper Date instance
  expect(echoedDate).toBeInstanceOf(Date);
  
  // Verify the value is preserved
  expect(echoedDate.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  expect(echoedDate.getTime()).toBe(originalDate.getTime());
}

/**
 * Built-in types - Echo RegExp (client → server → client)
 */
export async function testEchoRegExp(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a RegExp object
  const originalRegExp = /[0-9]+/gi;
  
  // Send it to the server and get it back
  const echoedRegExp = await (client as any).echo(originalRegExp);
  
  // Verify it's a proper RegExp instance
  expect(echoedRegExp).toBeInstanceOf(RegExp);
  
  // Verify the pattern and flags are preserved
  expect(echoedRegExp.source).toBe('[0-9]+');
  expect(echoedRegExp.flags).toBe('gi');
  expect(echoedRegExp.global).toBe(true);
  expect(echoedRegExp.ignoreCase).toBe(true);
}

/**
 * Built-in types - Echo Map (client → server → client)
 */
export async function testEchoMap(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a Map object
  const originalMap = new Map<any, any>([
    ['key1', 'value1'],
    ['key2', 'value2'],
    [123, 'numeric key'],
  ]);
  
  // Send it to the server and get it back
  const echoedMap = await (client as any).echo(originalMap);
  
  // Verify it's a proper Map instance
  expect(echoedMap).toBeInstanceOf(Map);
  
  // Verify the contents are preserved
  expect(echoedMap.size).toBe(3);
  expect(echoedMap.get('key1')).toBe('value1');
  expect(echoedMap.get('key2')).toBe('value2');
  expect(echoedMap.get(123)).toBe('numeric key');
}

/**
 * Built-in types - Echo Set (client → server → client)
 */
export async function testEchoSet(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a Set object
  const originalSet = new Set([1, 2, 3, 'four', 'five']);
  
  // Send it to the server and get it back
  const echoedSet = await (client as any).echo(originalSet);
  
  // Verify it's a proper Set instance
  expect(echoedSet).toBeInstanceOf(Set);
  
  // Verify the contents are preserved
  expect(echoedSet.size).toBe(5);
  expect(echoedSet.has(1)).toBe(true);
  expect(echoedSet.has(2)).toBe(true);
  expect(echoedSet.has(3)).toBe(true);
  expect(echoedSet.has('four')).toBe(true);
  expect(echoedSet.has('five')).toBe(true);
}

/**
 * Built-in types - Echo ArrayBuffer (client → server → client)
 */
export async function testEchoArrayBuffer(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create an ArrayBuffer
  const originalBuffer = new ArrayBuffer(8);
  const view = new DataView(originalBuffer);
  view.setUint8(0, 255);
  view.setUint8(7, 128);
  
  // Send it to the server and get it back
  const echoedBuffer = await (client as any).echo(originalBuffer);
  
  // Verify it's a proper ArrayBuffer instance
  expect(echoedBuffer).toBeInstanceOf(ArrayBuffer);
  
  // Verify the contents are preserved
  expect(echoedBuffer.byteLength).toBe(8);
  const echoedView = new DataView(echoedBuffer);
  expect(echoedView.getUint8(0)).toBe(255);
  expect(echoedView.getUint8(7)).toBe(128);
}

/**
 * Built-in types - Echo TypedArray (client → server → client)
 */
export async function testEchoTypedArray(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a Uint8Array (TypedArray)
  const originalArray = new Uint8Array([0, 1, 2, 3, 4, 5]);
  
  // Send it to the server and get it back
  const echoedArray = await (client as any).echo(originalArray);
  
  // Verify it's a proper Uint8Array instance
  expect(echoedArray).toBeInstanceOf(Uint8Array);
  
  // Verify the contents are preserved
  expect(echoedArray.length).toBe(6);
  expect(Array.from(echoedArray)).toEqual([0, 1, 2, 3, 4, 5]);
}

/**
 * Built-in types - Echo Error (client → server → client)
 */
export async function testEchoError(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create an Error object
  const originalError = new Error('Test error message');
  originalError.name = 'CustomError';
  
  // Send it to the server and get it back
  const echoedError = await (client as any).echo(originalError);
  
  // Verify it's a proper Error instance
  expect(echoedError).toBeInstanceOf(Error);
  
  // Verify basic properties are preserved
  expect(echoedError.message).toBe('Test error message');
  expect(echoedError.name).toBe('CustomError');
  
  // Note: stack trace may not be preserved by structured-clone
  // This is a known limitation that we're testing for
}

/**
 * Built-in types - Echo custom Error subclass (client → server → client)
 * 
 * Tests that custom Error subclasses preserve their type (name) through RPC
 * without requiring manual `this.name = 'CustomError'` in constructor.
 */
export async function testEchoCustomErrorClass(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a custom Error subclass WITHOUT manually setting name
  class ValidationError extends Error {
    constructor(message: string, public field?: string) {
      super(message);
      // Note: NOT setting this.name = 'ValidationError' here
    }
  }
  
  // Create an instance with custom properties
  const originalError = new ValidationError('Invalid input', 'email');
  
  // Send it to the server and get it back
  const echoedError = await (client as any).echo(originalError);
  
  // Verify it's a proper Error instance
  expect(echoedError).toBeInstanceOf(Error);
  
  // Verify basic properties are preserved
  expect(echoedError.message).toBe('Invalid input');
  
  // This is the key test: custom Error class name should be preserved
  expect(echoedError.name).toBe('ValidationError');
  
  // Verify custom properties are preserved
  expect(echoedError.field).toBe('email');
}

/**
 * Built-in types - Echo BigInt (client → server → client)
 */
export async function testEchoBigInt(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a BigInt value
  const originalBigInt = 1234567890123456789012345678901234567890n;
  
  // Send it to the server and get it back
  const echoedBigInt = await (client as any).echo(originalBigInt);
  
  // Verify it's preserved as BigInt
  expect(typeof echoedBigInt).toBe('bigint');
  expect(echoedBigInt).toBe(originalBigInt);
  
  // Test negative BigInt
  const negativeBigInt = -9876543210987654321098765432109876543210n;
  const echoedNegative = await (client as any).echo(negativeBigInt);
  expect(typeof echoedNegative).toBe('bigint');
  expect(echoedNegative).toBe(negativeBigInt);
}

/**
 * Special Numbers - Echo Infinity, -Infinity, NaN (client → server → client)
 */
export async function testEchoSpecialNumbers(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Test positive Infinity
  const infinity = Infinity;
  const echoedInfinity = await (client as any).echo(infinity);
  expect(echoedInfinity).toBe(Infinity);
  
  // Test negative Infinity
  const negInfinity = -Infinity;
  const echoedNegInfinity = await (client as any).echo(negInfinity);
  expect(echoedNegInfinity).toBe(-Infinity);
  
  // Test NaN - special handling needed since NaN !== NaN
  const nan = NaN;
  const echoedNaN = await (client as any).echo(nan);
  expect(Number.isNaN(echoedNaN)).toBe(true);
  
  // Test in object context
  const obj = {
    infinity: Infinity,
    negInfinity: -Infinity,
    nan: NaN,
    regularNumber: 42
  };
  const echoedObj = await (client as any).echo(obj);
  expect(echoedObj.infinity).toBe(Infinity);
  expect(echoedObj.negInfinity).toBe(-Infinity);
  expect(Number.isNaN(echoedObj.nan)).toBe(true);
  expect(echoedObj.regularNumber).toBe(42);
}

/**
 * Circular References - echoThroughStorage (client → server → DO storage → server → client)
 */
export async function testEchoThroughStorageCircularReference(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create object with circular reference
  const obj: any = { id: 'root', data: { value: 42 } };
  obj.self = obj; // Points back to root
  
  const echoedObj = await (client as any).echoThroughStorage(obj);
  
  // Verify basic properties
  expect(echoedObj.id).toBe('root');
  expect(echoedObj.data.value).toBe(42);
  
  // Verify circular reference is preserved
  expect(echoedObj.self).toBeDefined();
  expect(echoedObj.self.id).toBe('root');
  expect(echoedObj.self).toBe(echoedObj);
}

/**
 * Request - echoThroughStorage (client → server → DO storage → server → client)
 * 
 * NOTE: Request contains a ReadableStream body, which DO Storage cannot serialize.
 * This test documents the current limitation. If this test fails in the future,
 * it means Cloudflare upgraded DO Storage to support Request objects.
 */
export async function testEchoThroughStorageRequest(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a Request with headers and body
  const originalRequest = new Request('https://example.com/api/test', {
    method: 'POST',
    headers: new Headers({
      'Content-Type': 'application/json',
      'X-Custom-Header': 'test-value',
    }),
    body: JSON.stringify({ test: 'data' }),
  });
  
  // DO Storage cannot serialize Request (contains ReadableStream)
  await expect(async () => {
    await (client as any).echoThroughStorage(originalRequest);
  }).rejects.toThrow(/ReadableStream can only be serialized for RPC/);
}

/**
 * Response - echoThroughStorage (client → server → DO storage → server → client)
 * 
 * NOTE: Response contains a ReadableStream body, which DO Storage cannot serialize.
 * This test documents the current limitation. If this test fails in the future,
 * it means Cloudflare upgraded DO Storage to support Response objects.
 */
export async function testEchoThroughStorageResponse(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a Response with headers and body
  const originalResponse = new Response(JSON.stringify({ success: true, data: 'test' }), {
    status: 200,
    statusText: 'OK',
    headers: new Headers({
      'Content-Type': 'application/json',
      'X-Response-Id': '12345',
    }),
  });
  
  // DO Storage cannot serialize Response (contains ReadableStream)
  await expect(async () => {
    await (client as any).echoThroughStorage(originalResponse);
  }).rejects.toThrow(/ReadableStream can only be serialized for RPC/);
}

/**
 * Headers - echoThroughStorage (client → server → DO storage → server → client)
 */
export async function testEchoThroughStorageHeaders(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create Headers with multiple entries
  const originalHeaders = new Headers();
  originalHeaders.set('Authorization', 'Bearer token123');
  originalHeaders.set('Accept', 'application/json');
  originalHeaders.set('X-API-Key', 'secret-key');
  
  const echoedHeaders = await (client as any).echoThroughStorage(originalHeaders);
  
  // Verify Headers instance and values
  expect(echoedHeaders).toBeInstanceOf(Headers);
  expect(echoedHeaders.get('Authorization')).toBe('Bearer token123');
  expect(echoedHeaders.get('Accept')).toBe('application/json');
  expect(echoedHeaders.get('X-API-Key')).toBe('secret-key');
  
  // Verify we can iterate over headers
  const headerEntries = Array.from(echoedHeaders.entries());
  expect(headerEntries.length).toBe(3);
}

/**
 * URL - echoThroughStorage (client → server → DO storage → server → client)
 * 
 * NOTE: URL objects cannot be serialized by DO Storage.
 * This test documents the current limitation. If this test fails in the future,
 * it means Cloudflare upgraded DO Storage to support URL objects.
 */
export async function testEchoThroughStorageURL(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a URL with query params and hash
  const originalURL = new URL('https://example.com/path?param1=value1&param2=value2#hash');
  
  // DO Storage cannot serialize URL
  await expect(async () => {
    await (client as any).echoThroughStorage(originalURL);
  }).rejects.toThrow(/Could not serialize object of type "URL"/);
}

/**
 * Nested Web API - echoThroughStorage (client → server → DO storage → server → client)
 * 
 * NOTE: Objects containing Request/Response/URL cannot be serialized to DO Storage
 * because they contain ReadableStreams. This test documents the current limitation.
 */
export async function testEchoThroughStorageNestedWebApi(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create nested object with multiple Web API types
  const obj = {
    request: new Request('https://example.com/test'),
    response: new Response('test body'),
    headers: new Headers({ 'X-Test': 'value' }),
    url: new URL('https://example.com'),
    nested: {
      deepRequest: new Request('https://example.com/deep'),
    },
  };
  
  // DO Storage cannot serialize objects containing Request/Response/URL
  await expect(async () => {
    await (client as any).echoThroughStorage(obj);
  }).rejects.toThrow(/ReadableStream can only be serialized for RPC/);
}

/**
 * Date - echoThroughStorage (client → server → DO storage → server → client)
 */
export async function testEchoThroughStorageDate(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a specific date
  const originalDate = new Date('2024-01-15T10:30:00.000Z');
  
  const echoedDate = await (client as any).echoThroughStorage(originalDate);
  
  // Verify Date is preserved
  expect(echoedDate).toBeInstanceOf(Date);
  expect(echoedDate.getTime()).toBe(originalDate.getTime());
  expect(echoedDate.toISOString()).toBe('2024-01-15T10:30:00.000Z');
  
  // Test in object context
  const obj = {
    created: new Date('2024-01-01T00:00:00.000Z'),
    updated: new Date('2024-01-15T12:00:00.000Z'),
  };
  const echoedObj = await (client as any).echoThroughStorage(obj);
  expect(echoedObj.created).toBeInstanceOf(Date);
  expect(echoedObj.updated).toBeInstanceOf(Date);
  expect(echoedObj.created.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  expect(echoedObj.updated.toISOString()).toBe('2024-01-15T12:00:00.000Z');
}

/**
 * RegExp - echoThroughStorage (client → server → DO storage → server → client)
 */
export async function testEchoThroughStorageRegExp(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a RegExp with flags
  const originalRegex = /test-pattern/gi;
  
  const echoedRegex = await (client as any).echoThroughStorage(originalRegex);
  
  // Verify RegExp is preserved
  expect(echoedRegex).toBeInstanceOf(RegExp);
  expect(echoedRegex.source).toBe('test-pattern');
  expect(echoedRegex.flags).toBe('gi');
  
  // Verify it works
  expect(echoedRegex.test('TEST-PATTERN')).toBe(true);
  expect(echoedRegex.test('other')).toBe(false);
  
  // Test in object context
  const obj = {
    emailPattern: /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/,
    urlPattern: /^https?:\/\/.+/,
  };
  const echoedObj = await (client as any).echoThroughStorage(obj);
  expect(echoedObj.emailPattern).toBeInstanceOf(RegExp);
  expect(echoedObj.urlPattern).toBeInstanceOf(RegExp);
  expect(echoedObj.emailPattern.test('test@example.com')).toBe(true);
  expect(echoedObj.urlPattern.test('https://example.com')).toBe(true);
}

/**
 * Map - echoThroughStorage (client → server → DO storage → server → client)
 */
export async function testEchoThroughStorageMap(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a Map with various key/value types
  const originalMap = new Map<any, any>([
    ['string-key', 'string-value'],
    [42, 'number-key'],
    [{ id: 'obj' }, 'object-key'],
    ['nested', new Map([['inner', 'value']])],
  ]);
  
  const echoedMap = await (client as any).echoThroughStorage(originalMap);
  
  // Verify Map is preserved
  expect(echoedMap).toBeInstanceOf(Map);
  expect(echoedMap.size).toBe(4);
  expect(echoedMap.get('string-key')).toBe('string-value');
  expect(echoedMap.get(42)).toBe('number-key');
  
  // Verify nested Map
  const nestedMap = echoedMap.get('nested');
  expect(nestedMap).toBeInstanceOf(Map);
  expect(nestedMap.get('inner')).toBe('value');
  
  // Test in object context
  const obj = {
    metadata: new Map<string, any>([
      ['created', Date.now()],
      ['features', ['increment', 'add']],
    ]),
  };
  const echoedObj = await (client as any).echoThroughStorage(obj);
  expect(echoedObj.metadata).toBeInstanceOf(Map);
  expect(echoedObj.metadata.size).toBe(2);
  expect(Array.isArray(echoedObj.metadata.get('features'))).toBe(true);
}

/**
 * Set - echoThroughStorage (client → server → DO storage → server → client)
 */
export async function testEchoThroughStorageSet(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a Set with various value types
  const originalSet = new Set([
    'value1',
    'value2',
    42,
    { id: 'obj' },
    ['array'],
  ]);
  
  const echoedSet = await (client as any).echoThroughStorage(originalSet);
  
  // Verify Set is preserved
  expect(echoedSet).toBeInstanceOf(Set);
  expect(echoedSet.size).toBe(5);
  expect(echoedSet.has('value1')).toBe(true);
  expect(echoedSet.has('value2')).toBe(true);
  expect(echoedSet.has(42)).toBe(true);
  
  // Test in object context
  const obj = {
    tags: new Set(['test', 'rpc', 'durable-objects']),
  };
  const echoedObj = await (client as any).echoThroughStorage(obj);
  expect(echoedObj.tags).toBeInstanceOf(Set);
  expect(echoedObj.tags.size).toBe(3);
  expect(echoedObj.tags.has('test')).toBe(true);
  expect(echoedObj.tags.has('rpc')).toBe(true);
  expect(echoedObj.tags.has('durable-objects')).toBe(true);
}

/**
 * ArrayBuffer - echoThroughStorage (client → server → DO storage → server → client)
 */
export async function testEchoThroughStorageArrayBuffer(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create an ArrayBuffer with some data
  const originalBuffer = new ArrayBuffer(16);
  const view = new Uint8Array(originalBuffer);
  for (let i = 0; i < view.length; i++) {
    view[i] = i * 2;
  }
  
  const echoedBuffer = await (client as any).echoThroughStorage(originalBuffer);
  
  // Verify ArrayBuffer is preserved
  expect(echoedBuffer).toBeInstanceOf(ArrayBuffer);
  expect(echoedBuffer.byteLength).toBe(16);
  
  // Verify contents
  const echoedView = new Uint8Array(echoedBuffer);
  for (let i = 0; i < echoedView.length; i++) {
    expect(echoedView[i]).toBe(i * 2);
  }
  
  // Test in object context
  const obj = {
    buffer: new ArrayBuffer(8),
  };
  const echoedObj = await (client as any).echoThroughStorage(obj);
  expect(echoedObj.buffer).toBeInstanceOf(ArrayBuffer);
  expect(echoedObj.buffer.byteLength).toBe(8);
}

/**
 * TypedArray - echoThroughStorage (client → server → DO storage → server → client)
 */
export async function testEchoThroughStorageTypedArray(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a Uint8Array with data
  const originalArray = new Uint8Array([1, 2, 3, 4, 5]);
  
  const echoedArray = await (client as any).echoThroughStorage(originalArray);
  
  // Verify TypedArray is preserved
  expect(echoedArray).toBeInstanceOf(Uint8Array);
  expect(echoedArray.length).toBe(5);
  expect(Array.from(echoedArray)).toEqual([1, 2, 3, 4, 5]);
  
  // Test in object context with different typed array
  const obj = {
    data: new Uint16Array([100, 200, 300]),
  };
  const echoedObj = await (client as any).echoThroughStorage(obj);
  expect(echoedObj.data).toBeInstanceOf(Uint16Array);
  expect(Array.from(echoedObj.data)).toEqual([100, 200, 300]);
}

/**
 * Error - echoThroughStorage (client → server → DO storage → server → client)
 * 
 * NOTE: Errors serialize through DO Storage but custom properties are lost.
 * Only message, name, and stack are preserved.
 */
export async function testEchoThroughStorageError(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create an Error with custom properties
  const originalError = new Error('Test error message');
  (originalError as any).code = 'TEST_ERROR';
  (originalError as any).statusCode = 400;
  
  const echoedError = await (client as any).echoThroughStorage(originalError);
  
  // Verify basic Error properties are preserved
  expect(echoedError).toBeInstanceOf(Error);
  expect(echoedError.message).toBe('Test error message');
  expect(echoedError.name).toBe('Error');
  
  // Custom properties are NOT preserved through DO Storage
  expect((echoedError as any).code).toBeUndefined();
  expect((echoedError as any).statusCode).toBeUndefined();
  
  // Stack should be present
  expect(echoedError.stack).toBeDefined();
  expect(typeof echoedError.stack).toBe('string');
  expect(echoedError.stack).toContain('Error: Test error message');
}

/**
 * Custom Error Class - echoThroughStorage (client → server → DO storage → server → client)
 * 
 * NOTE: Custom Error classes serialize through DO Storage but:
 * - Custom properties are lost
 * - Name reverts to 'Error' (not the custom class name)
 * - Only message and stack are preserved
 */
export async function testEchoThroughStorageCustomErrorClass(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a custom Error subclass WITHOUT manually setting this.name
  class ValidationError extends Error {
    field: string;
    
    constructor(message: string, field: string) {
      super(message);
      this.field = field;
    }
  }
  
  const originalError = new ValidationError('Invalid email format', 'email');
  const echoedError = await (client as any).echoThroughStorage(originalError);
  
  // Verify basic Error properties
  expect(echoedError).toBeInstanceOf(Error);
  expect(echoedError.message).toBe('Invalid email format');
  
  // Custom property is NOT preserved through DO Storage
  expect((echoedError as any).field).toBeUndefined();
  
  // Name reverts to 'Error', not 'ValidationError'
  expect(echoedError.name).toBe('Error');
  
  // Prototype chain is not preserved
  expect(echoedError).not.toBeInstanceOf(ValidationError);
  
  // Stack should be present
  expect(echoedError.stack).toBeDefined();
  expect(typeof echoedError.stack).toBe('string');
}

/**
 * BigInt - echoThroughStorage (client → server → DO storage → server → client)
 */
export async function testEchoThroughStorageBigInt(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Create a BigInt value
  const originalBigInt = 1234567890123456789012345678901234567890n;
  
  // Send it through storage and get it back
  const echoedBigInt = await (client as any).echoThroughStorage(originalBigInt);
  
  // Verify it's preserved as BigInt
  expect(typeof echoedBigInt).toBe('bigint');
  expect(echoedBigInt).toBe(originalBigInt);
  
  // Test negative BigInt
  const negativeBigInt = -9876543210987654321098765432109876543210n;
  const echoedNegative = await (client as any).echoThroughStorage(negativeBigInt);
  expect(typeof echoedNegative).toBe('bigint');
  expect(echoedNegative).toBe(negativeBigInt);
}

/**
 * Special Numbers - echoThroughStorage (client → server → DO storage → server → client)
 */
export async function testEchoThroughStorageSpecialNumbers(testable: TestableClient): Promise<void> {
  const { client } = testable;
  
  // Test positive Infinity
  const infinity = Infinity;
  const echoedInfinity = await (client as any).echoThroughStorage(infinity);
  expect(echoedInfinity).toBe(Infinity);
  
  // Test negative Infinity
  const negInfinity = -Infinity;
  const echoedNegInfinity = await (client as any).echoThroughStorage(negInfinity);
  expect(echoedNegInfinity).toBe(-Infinity);
  
  // Test NaN - special handling needed since NaN !== NaN
  const nan = NaN;
  const echoedNaN = await (client as any).echoThroughStorage(nan);
  expect(Number.isNaN(echoedNaN)).toBe(true);
  
  // Test in object context
  const obj = {
    infinity: Infinity,
    negInfinity: -Infinity,
    nan: NaN,
    regularNumber: 42
  };
  const echoedObj = await (client as any).echoThroughStorage(obj);
  expect(echoedObj.infinity).toBe(Infinity);
  expect(echoedObj.negInfinity).toBe(-Infinity);
  expect(Number.isNaN(echoedObj.nan)).toBe(true);
  expect(echoedObj.regularNumber).toBe(42);
}

/**
 * All behavior tests in a registry for easy iteration
 */
export const behaviorTests = {
  increment: testIncrement,
  multipleIncrements: testMultipleIncrements,
  add: testAdd,
  throwError: testThrowError,
  throwString: testThrowString,
  getObject: testGetObject,
  getArray: testGetArray,
  getArrayWithFunctions: testGetArrayWithFunctions,
  getClassInstance: testGetClassInstance,
  getDeeplyNested: testGetDeeplyNested,
  echoCircularReference: testEchoCircularReference,
  asObject: testAsObject,
  slowIncrement: testSlowIncrement,
  echoRequest: testEchoRequest,
  echoResponse: testEchoResponse,
  echoHeaders: testEchoHeaders,
  echoURL: testEchoURL,
  echoNestedWebApi: testEchoNestedWebApi,
  echoDate: testEchoDate,
  echoRegExp: testEchoRegExp,
  echoMap: testEchoMap,
  echoSet: testEchoSet,
  echoArrayBuffer: testEchoArrayBuffer,
  echoTypedArray: testEchoTypedArray,
  echoError: testEchoError,
  echoCustomErrorClass: testEchoCustomErrorClass,
  echoBigInt: testEchoBigInt,
  echoSpecialNumbers: testEchoSpecialNumbers,
  echoThroughStorageCircularReference: testEchoThroughStorageCircularReference,
  echoThroughStorageRequest: testEchoThroughStorageRequest,
  echoThroughStorageResponse: testEchoThroughStorageResponse,
  echoThroughStorageHeaders: testEchoThroughStorageHeaders,
  echoThroughStorageURL: testEchoThroughStorageURL,
  echoThroughStorageNestedWebApi: testEchoThroughStorageNestedWebApi,
  echoThroughStorageDate: testEchoThroughStorageDate,
  echoThroughStorageRegExp: testEchoThroughStorageRegExp,
  echoThroughStorageMap: testEchoThroughStorageMap,
  echoThroughStorageSet: testEchoThroughStorageSet,
  echoThroughStorageArrayBuffer: testEchoThroughStorageArrayBuffer,
  echoThroughStorageTypedArray: testEchoThroughStorageTypedArray,
  echoThroughStorageError: testEchoThroughStorageError,
  echoThroughStorageCustomErrorClass: testEchoThroughStorageCustomErrorClass,
  echoThroughStorageBigInt: testEchoThroughStorageBigInt,
  echoThroughStorageSpecialNumbers: testEchoThroughStorageSpecialNumbers,
};

/**
 * Test categories for organizing matrix tests
 */
export const testCategories = {
  basic: ['increment', 'multipleIncrements', 'add'],
  errors: ['throwError', 'throwString'],
  objects: ['getObject', 'getDeeplyNested'],
  arrays: ['getArray', 'getArrayWithFunctions'],
  classes: ['getClassInstance'],
  circularRefs: ['echoCircularReference'],
  inspection: ['asObject'],
  async: ['slowIncrement'],
  webApi: ['echoRequest', 'echoResponse', 'echoHeaders', 'echoURL', 'echoNestedWebApi', 'echoDate', 'echoRegExp', 'echoMap', 'echoSet', 'echoArrayBuffer', 'echoTypedArray', 'echoError', 'echoCustomErrorClass', 'echoBigInt', 'echoSpecialNumbers'],
  storage: ['echoThroughStorageCircularReference', 'echoThroughStorageRequest', 'echoThroughStorageResponse', 'echoThroughStorageHeaders', 'echoThroughStorageURL', 'echoThroughStorageNestedWebApi', 'echoThroughStorageDate', 'echoThroughStorageRegExp', 'echoThroughStorageMap', 'echoThroughStorageSet', 'echoThroughStorageArrayBuffer', 'echoThroughStorageTypedArray', 'echoThroughStorageError', 'echoThroughStorageCustomErrorClass', 'echoThroughStorageBigInt', 'echoThroughStorageSpecialNumbers'],
};
