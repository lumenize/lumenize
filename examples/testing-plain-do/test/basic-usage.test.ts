import { describe, it, expect } from 'vitest';
import { testDOProject } from '@lumenize/testing';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { env } from 'cloudflare:test';

/**
 * Basic Usage Examples for @lumenize/testing
 * 
 * This file demonstrates the fundamental usage patterns of the @lumenize/testing library.
 * It's designed as living documentation to help developers understand how to test
 * Durable Objects effectively using our testing infrastructure.
 * 
 * Key concepts covered:
 * - Basic testDOProject setup
 * - Different ways to access Durable Object stubs
 * - Using the ctx proxy for internal testing
 * - Working with the three-method API (get/ctx/full)
 */
describe('Basic @lumenize/testing Usage', () => {

  it('demonstrates core Durable Object testing patterns', async () => {
    // The testDOProject function is the main entry point for testing DOs.
    // It sets up the testing environment and provides access to stubs and helpers.
    await testDOProject(async (SELF, stubs, helpers) => {
      
      /**
       * PART 1: Accessing Durable Object Stubs
       * 
       * There are three main patterns for getting DO stubs in Cloudflare Workers.
       * All of these work normally in tests, but our library enhances them with
       * testing capabilities.
       */
      
      // Pattern 1: Direct named access using getByName()
      // This is the simplest way to get a DO stub when you know the name
      const namedStub = env.MY_DO.getByName('example-instance');
      expect(namedStub).toBeDefined();
      expect(namedStub.name).toBe('example-instance');
      
      // Pattern 2: Two-step access using idFromName() + get()
      // Sometimes you need the ID for other operations
      const instanceId = env.MY_DO.idFromName('another-instance');
      const stubFromId = env.MY_DO.get(instanceId);
      expect(stubFromId).toBeDefined();
      expect(stubFromId.name).toBe('another-instance');
      
      // Pattern 3: Anonymous instances using newUniqueId() + get()
      // For when you need a fresh, unique DO instance
      const uniqueId = env.MY_DO.newUniqueId();
      const anonymousStub = env.MY_DO.get(uniqueId);
      expect(anonymousStub).toBeDefined();
      expect(anonymousStub.name).toBeUndefined(); // Anonymous instances have no name
      
      /**
       * PART 2: Testing DO Internal State with ctx Proxy
       * 
       * The most powerful feature of @lumenize/testing is the ability to access
       * the internal context (ctx) of Durable Objects during testing. This lets
       * you inspect and manipulate storage, call internal methods, etc.
       */
      
      // Access the DO's internal context through the .ctx proxy
      // This gives you direct access to storage, waitUntil, etc.
      const storage = namedStub.ctx.storage;
      
      // You can now perform storage operations just like inside the DO
      await storage.put('test-key', 'test-value');
      const retrievedValue = await storage.get('test-key');
      expect(retrievedValue).toBe('test-value');
      
      // storage.list() returns a Map (properly serialized thanks to structured clone)
      const storageList = await storage.list();
      expect(storageList).toBeInstanceOf(Map);
      expect(storageList.get('test-key')).toBe('test-value');
      
      // You can also access other ctx properties
      expect(namedStub.ctx.waitUntil).toBeDefined();
      expect(typeof namedStub.ctx.waitUntil).toBe('function');
      
      /**
       * PART 3: Using the Three-Method API
       * 
       * The stubs registry provides three methods for accessing your testing stubs:
       * - get(): Returns the enhanced stub (same as env.MY_DO.get(), but trackable)
       * - ctx(): Returns the ctx proxy directly for quick access
       * - full(): Returns complete information about the stub
       */
      
      // Method 1: stubs.get() - Get the enhanced stub
      const stubViaRegistry = stubs.get('MY_DO', 'example-instance');
      expect(stubViaRegistry).toBe(namedStub); // Same object
      
      // Method 2: stubs.ctx() - Direct ctx access
      const ctxProxy = stubs.ctx('MY_DO', 'example-instance');
      expect(ctxProxy).toBe(namedStub.ctx); // Same ctx proxy
      
      // You can use ctx directly for storage operations
      await ctxProxy.storage.put('direct-key', 'direct-value');
      const directValue = await ctxProxy.storage.get('direct-key');
      expect(directValue).toBe('direct-value');
      
      // Method 3: stubs.full() - Complete stub information
      const stubInfo = stubs.full('MY_DO', 'example-instance');
      expect(stubInfo).toBeDefined();
      expect(stubInfo!.bindingName).toBe('MY_DO');
      expect(stubInfo!.name).toBe('example-instance');
      expect(stubInfo!.stub).toBe(namedStub);
      expect(stubInfo!.ctx).toBe(ctxProxy);
      
      /**
       * PART 4: Testing DO Instrumentation
       * 
       * Our library automatically instruments your DOs with testing endpoints.
       * You can verify this instrumentation is working correctly.
       */
      
      // The /__testing/info endpoint provides metadata about the DO
      const infoResponse = await namedStub.fetch(new Request('https://example.com/__testing/info'));
      expect(infoResponse.ok).toBe(true);
      
      const info = await infoResponse.json();
      expect(info.className).toBe('MyDO'); // Your DO class name
      expect(info.isInstrumented).toBe(true);
      expect(info.ctxProxyAvailable).toBe(true);
      
      /**
       * PART 5: Working with Multiple DO Instances
       * 
       * You can test interactions between multiple DO instances,
       * and verify they have isolated storage.
       */
      
      // Create storage in one instance
      await namedStub.ctx.storage.put('instance1-data', 'value1');
      
      // Create storage in another instance  
      await stubFromId.ctx.storage.put('instance2-data', 'value2');
      
      // Verify isolation - data should not cross between instances
      const instance1Data = await namedStub.ctx.storage.get('instance2-data');
      const instance2Data = await stubFromId.ctx.storage.get('instance1-data');
      expect(instance1Data).toBeUndefined(); // Should not exist
      expect(instance2Data).toBeUndefined(); // Should not exist
      
      // But each instance should have its own data
      const ownData1 = await namedStub.ctx.storage.get('instance1-data');
      const ownData2 = await stubFromId.ctx.storage.get('instance2-data');
      expect(ownData1).toBe('value1');
      expect(ownData2).toBe('value2');
      
      /**
       * PART 6: Cleanup and Helpers
       * 
       * The helpers object provides utility functions for test management.
       */
      
      // Always call helpers.flush() at the end of your test
      // This ensures proper cleanup of resources
      helpers.flush();
    });
  });

  it('demonstrates working with anonymous DO instances', async () => {
    await testDOProject(async (SELF, stubs, helpers) => {
      
      // Anonymous instances are useful for tests that need fresh, isolated DOs
      const uniqueId = env.MY_DO.newUniqueId();
      const anonymousStub = env.MY_DO.get(uniqueId);
      
      // Anonymous stubs work the same as named ones
      await anonymousStub.ctx.storage.put('anonymous-data', 'anonymous-value');
      const value = await anonymousStub.ctx.storage.get('anonymous-data');
      expect(value).toBe('anonymous-value');
      
      // You can access anonymous stubs through the registry using their ID
      const stubFromRegistry = stubs.get('MY_DO', uniqueId.toString());
      expect(stubFromRegistry).toBe(anonymousStub);
      
      // The full() method shows the ID for anonymous instances
      const anonymousInfo = stubs.full('MY_DO', uniqueId.toString());
      expect(anonymousInfo!.name).toBeUndefined(); // No name for anonymous
      expect(anonymousInfo!.id).toBe(uniqueId.toString());
      
      helpers.flush();
    });
  });

});