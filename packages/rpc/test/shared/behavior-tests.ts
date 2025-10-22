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
  cleanup?: () => Promise<void>;
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
 * Built-in types - Date
 */
export async function testGetDate(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).getDate();
  expect(result).toBeInstanceOf(Date);
  expect(result.toISOString()).toBe('2025-01-01T00:00:00.000Z');
}

/**
 * Built-in types - BigInt
 */
export async function testGetBigInt(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).getBigInt();
  expect(result).toBeInstanceOf(BigInt);
  expect(result).toBe(1234567890123456789012345678901234567890n);
}

/**
 * Built-in types - RegExp
 */
export async function testGetRegExp(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).getRegExp();
  expect(result).toBeInstanceOf(RegExp);
  expect(result.source).toBe('[0-9]+');
}

/**
 * Built-in types - Map
 */
export async function testGetMap(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).getMap();
  expect(result).toBeInstanceOf(Map);
  expect(result.get('key')).toBe('value');
}

/**
 * Built-in types - Set
 */
export async function testGetSet(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).getSet();
  expect(result).toBeInstanceOf(Set);
  expect(result.has(1)).toBe(true);
  expect(result.has(2)).toBe(true);
  expect(result.has(3)).toBe(true);
}

/**
 * Built-in types - ArrayBuffer
 */
export async function testGetArrayBuffer(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).getArrayBuffer();
  expect(result).toBeInstanceOf(ArrayBuffer);
  expect(result.byteLength).toBe(8);
}

/**
 * Built-in types - TypedArray (Uint8Array)
 */
export async function testGetTypedArray(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).getTypedArray();
  expect(result).toBeInstanceOf(Uint8Array);
  expect(result.length).toBe(4);
  expect(result[0]).toBe(1);
  expect(result[3]).toBe(4);
}

/**
 * Built-in types - Error
 */
export async function testGetError(testable: TestableClient): Promise<void> {
  const { client } = testable;
  const result = await (client as any).getError();
  expect(result).toBeInstanceOf(Error);
  expect(result.message).toBe('Test error');
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
  getDate: testGetDate,
  getRegExp: testGetRegExp,
  getMap: testGetMap,
  getSet: testGetSet,
  getArrayBuffer: testGetArrayBuffer,
  getTypedArray: testGetTypedArray,
  getError: testGetError,
  echoCircularReference: testEchoCircularReference,
  asObject: testAsObject,
  slowIncrement: testSlowIncrement,
  echoRequest: testEchoRequest,
  echoResponse: testEchoResponse,
  echoHeaders: testEchoHeaders,
  echoURL: testEchoURL,
  echoNestedWebApi: testEchoNestedWebApi,
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
  builtins: ['getDate', 'getRegExp', 'getMap', 'getSet', 'getArrayBuffer', 'getTypedArray', 'getError'],
  circularRefs: ['echoCircularReference'],
  inspection: ['asObject'],
  async: ['slowIncrement'],
  webApi: ['echoRequest', 'echoResponse', 'echoHeaders', 'echoURL', 'echoNestedWebApi'],
};
