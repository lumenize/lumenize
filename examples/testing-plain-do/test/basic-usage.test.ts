import { describe, it, expect } from 'vitest';
import { testDOProject } from '@lumenize/testing';

/**
 * Basic Usage Examples for @lumenize/testing
 * 
 * This file demonstrates the essential usage patterns of the @lumenize/testing library.
 * It's designed as living documentation to help developers get started quickly.
 * 
 * Focus: Core library features and what you can do with contexts.
 * Note: More comprehensive testing patterns are in comprehensive.test.ts
 */
describe('Basic Usage', () => {

  it('demonstrates fetch operation verified via ctx assertion', async () => {
    await testDOProject(async (SELF, contexts, helpers) => {
      // Call increment
      const response = await SELF.fetch('https://example.com/my-do/fetch-then-assert/increment');
      
      // Verify that we get back the incremented count
      expect(response.status).toBe(200);
      const responseText = await response.text();
      expect(responseText).toBe('1');
      
      // Verify that count is correct in storage via pure context access
      const ctx = contexts.get('MY_DO', 'fetch-then-assert');
      const storedCount = await ctx.storage.get('count');
      expect(storedCount).toBe(1);
    });
  });

  it('demonstrates pre-populating via ctx and then doing a fetch operation', async () => {
    await testDOProject(async (SELF, contexts, helpers) => {
      // Verify that count is correct in storage via pure context access
      const ctx = contexts.get('MY_DO', 'put-then-fetch');
      await ctx.storage.put('count', 10);

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

  it('requires await for all ctx proxy access, even non-async functions and static properties', async () => {
    await testDOProject(async (SELF, contexts, helpers) => {
      const ctx = contexts.get('MY_DO', 'quirks');
      
      
      // 1. True async function - naturally requires await
      await ctx.storage.put('async-key', 'async-value');
      const asyncResult = await ctx.storage.get('async-key');
      expect(asyncResult).toBe('async-value');
      
      // 2. Non-async function - still requires await due to proxy architecture
      // ctx.storage.kv.put() is synchronous but we must await it through the proxy
      await ctx.storage.kv.put('kv-key', 'kv-value');
      const kvResult = await ctx.storage.kv.get('kv-key');
      expect(kvResult).toBe('kv-value');
      
      // 3. Static property - even properties require await through the proxy
      // storage.sql.databaseSize is just a number property, but proxy requires await
      const dbSize = await ctx.storage.sql.databaseSize;
      expect(typeof dbSize).toBe('number');
      expect(dbSize).toBeGreaterThanOrEqual(0);
      
      // This is the proxy quirk: everything looks like a function until awaited
      expect(typeof ctx.storage.sql.databaseSize).toBe('function');
    });
  });

});
