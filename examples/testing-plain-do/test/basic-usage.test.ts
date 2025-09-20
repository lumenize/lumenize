import { describe, it, expect } from 'vitest';
import { testDOProject } from '@lumenize/testing';

/**
 * Basic Usage Examples for @lumenize/testing
 * 
 * This file demonstrates the essential usage patterns of the @lumenize/testing library.
 * It's designed as living documentation to help developers get started quickly.
 * 
 * Focus: Core library features and what you can do with instances.
 * Note: More comprehensive testing patterns are in comprehensive.test.ts
 */
describe('Basic Usage', () => {

  it('demonstrates fetch operation verified via instance access', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      // Call increment
      const response = await SELF.fetch('https://example.com/my-do/fetch-then-assert/increment');
      
      // Verify that we get back the incremented count
      expect(response.status).toBe(200);
      const responseText = await response.text();
      expect(responseText).toBe('1');
      
      // Verify that count is correct in storage via instance access
      const instance = instances('MY_DO', 'fetch-then-assert');
      const storedCount = await instance.ctx.storage.get('count');
      expect(storedCount).toBe(1);
      
      const constructorName = await instance.constructor.name;
      expect(constructorName).toBe('MyDO');
      
      // Verify we can access environment through the instance
      const env = await instance.env;
      expect(env).toBeDefined();
      expect(typeof env).toBe('object');
    });
  });

  it('demonstrates pre-populating via instance and then doing a fetch operation', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      // Verify that count is correct in storage via instance access
      const instance = instances('MY_DO', 'put-then-fetch');
      await instance.ctx.storage.put('count', 10);

      // Call increment
      const response = await SELF.fetch('https://example.com/my-do/put-then-fetch/increment');
      
      // Verify that we get back the incremented count
      expect(response.status).toBe(200);
      const responseText = await response.text();
      expect(responseText).toBe('11');
    });
  });

});

describe('Limitations and quirks', () =>{

  it('requires await for all instance proxy access, even non-async functions and static properties', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      const instance = instances('MY_DO', 'quirks');
      
      
      // 1. True async function - naturally requires await
      await instance.ctx.storage.put('async-key', 'async-value');
      const asyncResult = await instance.ctx.storage.get('async-key');
      expect(asyncResult).toBe('async-value');
      
      // 2. Non-async function - still requires await due to proxy architecture
      // instance.ctx.storage.kv.put() is synchronous but we must await it through the proxy
      await instance.ctx.storage.kv.put('kv-key', 'kv-value');
      const kvResult = await instance.ctx.storage.kv.get('kv-key');
      expect(kvResult).toBe('kv-value');
      
      // 3. Static property - even properties require await through the proxy
      // storage.sql.databaseSize is just a number property, but proxy requires await
      const dbSize = await instance.ctx.storage.sql.databaseSize;
      expect(typeof dbSize).toBe('number');
      expect(dbSize).toBeGreaterThanOrEqual(0);
      
      // This is the proxy quirk: everything looks like a function until awaited
      expect(typeof instance.ctx.storage.sql.databaseSize).toBe('function');
    });
  });

});
