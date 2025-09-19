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
describe('Basic @lumenize/testing Usage', () => {

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
      
      helpers.flush();
    });
  });

});