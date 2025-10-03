/**
 * Reusable behavior test functions
 * 
 * These test functions can be run against any RPC client configuration
 * (WebSocket/HTTP × lumenizeRpcDo/handleRPCRequest × Base/Subclass)
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
  asObject: testAsObject,
  slowIncrement: testSlowIncrement,
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
  inspection: ['asObject'],
  async: ['slowIncrement'],
};
