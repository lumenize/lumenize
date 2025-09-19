import { describe, it, expect } from 'vitest';
import { testDOProject } from '@lumenize/testing';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { env } from 'cloudflare:test';

/**
 * Basic Usage Examples for @lumenize/testing
 * 
 * This file demonstrates the essential usage patterns of the @lumenize/testing library.
 * It's designed as living documentation to help developers get started quickly.
 * 
 * Focus: Core library features and what you can do with created stubs.
 * Note: More comprehensive testing patterns are in comprehensive.test.ts
 */
describe('Basic Usage', () => {

  it('demonstrates essential DO testing with ctx proxy access', async () => {
    await testDOProject(async (SELF, stubs, helpers) => {
      
      // Create a DO stub - the typical way developers will work with DOs
      const stub = env.MY_DO.getByName('my-instance');
      expect(stub.name).toBe('my-instance');
      
      // The key feature: access the DO's internal context via .ctx proxy
      // This lets you directly manipulate storage, just like inside the DO
      await stub.ctx.storage.put('user:123', { name: 'Alice', score: 100 });
      
      // Verify storage operations work correctly
      const userData = await stub.ctx.storage.get('user:123');
      expect(userData).toEqual({ name: 'Alice', score: 100 });
      
      // storage.list() returns a proper Map (thanks to structured clone)
      const allData = await stub.ctx.storage.list();
      expect(allData.get('user:123')).toEqual({ name: 'Alice', score: 100 });
      
      // Access the same stub through the registry API
      const registryStub = stubs.get('MY_DO', 'my-instance');
      expect(registryStub).toBe(stub);
      
      // Direct ctx access for convenience
      const ctx = stubs.ctx('MY_DO', 'my-instance');
      await ctx.storage.put('score:high', 500);
      expect(await ctx.storage.get('score:high')).toBe(500);
    });
  });

  it('supports direct RPC calls to DO methods', async () => {
    await testDOProject(async (SELF, stubs, helpers) => {
      const stub = env.MY_DO.getByName('rpc-test-instance');
      const rpcResponse = await stub.sayHello();
      expect(rpcResponse).toBe('Hello, World!');
    });
  });

});

describe('Limitations and quirks', () =>{

  it('requires await for all ctx proxy access, even non-async functions and static properties', async () => {
    await testDOProject(async (SELF, stubs, helpers) => {
      const stub = env.MY_DO.getByName('quirks-test');
      
      // 1. True async function - naturally requires await
      await stub.ctx.storage.put('async-key', 'async-value');
      const asyncResult = await stub.ctx.storage.get('async-key');
      expect(asyncResult).toBe('async-value');
      
      // 2. Non-async function - still requires await due to proxy architecture
      // ctx.storage.kv.put() is synchronous but we must await it through the proxy
      await stub.ctx.storage.kv.put('kv-key', 'kv-value');
      const kvResult = await stub.ctx.storage.kv.get('kv-key');
      expect(kvResult).toBe('kv-value');
      
      // 3. Static property - even properties require await through the proxy
      // storage.sql.databaseSize is just a number property, but proxy requires await
      const dbSize = await stub.ctx.storage.sql.databaseSize;
      expect(typeof dbSize).toBe('number');
      expect(dbSize).toBeGreaterThanOrEqual(0);
      
      // This is the proxy quirk: everything looks like a function until awaited
      expect(typeof stub.ctx.storage.sql.databaseSize).toBe('function');
    });
  });

});
