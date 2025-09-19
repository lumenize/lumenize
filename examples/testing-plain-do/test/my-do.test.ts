import { describe, it, expect, vi } from 'vitest';
import { testDOProject } from '@lumenize/testing';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { env, createExecutionContext } from 'cloudflare:test';

describe('MyDO', () => {

  it('should be used to experiment', async () => {
    await testDOProject(async (SELF, stubs, helpers) => {
      
      // Now test all Durable Object access patterns
      
      // Pattern 1: Using getByName (direct named access)
      const directStub = env.MY_DO.getByName('my-direct-instance');
      expect(directStub).toBeDefined();
      expect(directStub.name).toBe('my-direct-instance');
      
      // Pattern 2: Using idFromName + get (two-step named access)
      const namedId = env.MY_DO.idFromName('my-instance-name');
      const namedStub = env.MY_DO.get(namedId);
      expect(namedStub).toBeDefined();
      expect(namedStub.name).toBe('my-instance-name');
      
      // Pattern 3: Using newUniqueId + get (anonymous instances)
      const uniqueId = env.MY_DO.newUniqueId();
      const uniqueStub = env.MY_DO.get(uniqueId);
      expect(uniqueStub).toBeDefined();
      expect(uniqueStub.name).toBeUndefined(); // Anonymous instances have no name
      
      // Test the instrumentation by calling a testing endpoint
      const testResponse = await directStub.fetch(new Request('https://example.com/__testing/info'));
      expect(testResponse.ok).toBe(true);
      const testData = await testResponse.json();
      expect(testData.className).toBe('MyDO');
      expect(testData.isInstrumented).toBe(true);
      expect(testData.ctxProxyAvailable).toBe(true);
      expect(typeof testData.timestamp).toBe('number');
      
      // Test the ctx proxy - this is the key functionality
      const storageList = await directStub.ctx.storage.list();
      expect(storageList).toBeDefined();
      expect(storageList).toBeInstanceOf(Map);
      // Fresh DO should have empty storage
      expect(storageList.size).toBe(0);
      
      // More comprehensive ctx proxy tests
      // Test storage operations through ctx proxy
      await directStub.ctx.storage.put('test-key', 'test-value');
      const retrievedValue = await directStub.ctx.storage.get('test-key');
      expect(retrievedValue).toBe('test-value');
      
      // Test that we can store and retrieve different types
      await directStub.ctx.storage.put('number-key', 42);
      const numberValue = await directStub.ctx.storage.get('number-key');
      expect(numberValue).toBe(42);
      
      await directStub.ctx.storage.put('object-key', { test: 'data' });
      const objectValue = await directStub.ctx.storage.get('object-key');
      expect(objectValue).toEqual({ test: 'data' });
      
      // Test storage delete
      await directStub.ctx.storage.delete('test-key');
      const deletedValue = await directStub.ctx.storage.get('test-key');
      expect(deletedValue).toBeUndefined();
      
      // Test other ctx properties/methods beyond storage
      // Access to waitUntil through ctx proxy
      expect(directStub.ctx.waitUntil).toBeDefined();
      expect(typeof directStub.ctx.waitUntil).toBe('function');
      
      // Access to passThroughOnException through ctx proxy
      expect(typeof directStub.ctx.passThroughOnException).toBe('function');
      
      // Demonstrate the new three-method API
      
      // 1. stubs.get() - returns the stub (currently with testing annotations, but semantic intent is clean)
      const stubFromGet = stubs.get('MY_DO', 'my-direct-instance');
      expect(stubFromGet).toBeDefined();
      expect(stubFromGet).toBe(directStub); // Currently the same object
      
      // 2. stubs.ctx() - returns ctx proxy directly
      const ctxProxy = stubs.ctx('MY_DO', 'my-direct-instance');
      expect(ctxProxy).toBeDefined();
      expect(ctxProxy).toBe(directStub.ctx); // Direct access to the ctx
      const storageFromProxy = await ctxProxy.storage.list();
      
      // At this point, storage should have the data we put in earlier
      expect(storageFromProxy).toBeInstanceOf(Map);
      expect(storageFromProxy.get('number-key')).toBe(42);
      expect(storageFromProxy.get('object-key')).toEqual({ test: 'data' });
      expect(storageFromProxy.has('test-key')).toBe(false); // This was deleted
      
      // Test that storage.list() now works correctly with structured clone!
      expect(storageFromProxy.size).toBe(2); // Should have 2 items
      expect([...storageFromProxy.keys()]).toContain('number-key');
      expect([...storageFromProxy.keys()]).toContain('object-key');
      
      // Test ctx proxy operations on different stub
      const namedCtxProxy = stubs.ctx('MY_DO', 'my-instance-name');
      expect(namedCtxProxy).toBeDefined();
      
      // Test storage operations through different ctx proxy
      await namedCtxProxy.storage.put('named-key', 'named-value');
      const namedValue = await namedCtxProxy.storage.get('named-key');
      expect(namedValue).toBe('named-value');
      
      // Verify isolation - original stub should have different storage
      const isolationCheck = await directStub.ctx.storage.get('named-key');
      expect(isolationCheck).toBeUndefined(); // Should not exist in different DO instance
      
      // 3. stubs.full() - returns full info with both stub and ctx
      const stubFull = stubs.full('MY_DO', 'my-direct-instance');
      expect(stubFull).toBeDefined();
      expect(stubFull!.bindingName).toBe('MY_DO');
      expect(stubFull!.name).toBe('my-direct-instance');
      expect(stubFull!.stub).toBe(stubFromGet); // Same stub
      expect(stubFull!.ctx).toBe(ctxProxy); // Same ctx proxy
      
      // Check if our stubs registry was populated correctly
      expect(stubs).toBeDefined();
      const allStubs = stubs.list();
      expect(allStubs).toHaveLength(3); // Should have 3 testing stubs total
      
      const myDoStubs = stubs.list('MY_DO');
      expect(myDoStubs).toHaveLength(3); // Should have 3 testing stubs for MY_DO
      
      // Verify that all stubs in list have both stub and ctx
      for (const stubFull of myDoStubs) {
        expect(stubFull.bindingName).toBe('MY_DO');
        expect(stubFull.stub).toBeDefined(); // Stub (currently has testing annotations)
        expect(stubFull.ctx).toBeDefined();  // ctx proxy
      }
      
      // Check named testing stubs are accessible by the new API methods
      const directFromGet = stubs.get('MY_DO', 'my-direct-instance');
      const directFromCtx = stubs.ctx('MY_DO', 'my-direct-instance');
      const directFromFull = stubs.full('MY_DO', 'my-direct-instance');
      
      expect(directFromGet).toBeDefined();
      expect(directFromCtx).toBeDefined();
      expect(directFromFull).toBeDefined();
      expect(directFromFull!.stub).toBe(directFromGet);
      expect(directFromFull!.ctx).toBe(directFromCtx);
      
      // Anonymous testing stub should be accessible by ID string
      const anonymousStubFull = myDoStubs.find(stubFull => 
        stubFull.name === undefined && stubFull.id.length > 32
      );
      expect(anonymousStubFull).toBeDefined();
      expect(anonymousStubFull!.bindingName).toBe('MY_DO');
      
      const anonymousFromGet = stubs.get('MY_DO', anonymousStubFull!.id);
      const anonymousFromCtx = stubs.ctx('MY_DO', anonymousStubFull!.id);
      expect(anonymousFromGet).toBeDefined();
      expect(anonymousFromCtx).toBeDefined();
      
      // Test ctx proxy functionality on anonymous stub
      await anonymousFromCtx.storage.put('anonymous-key', 'anonymous-value');
      const anonymousValue = await anonymousFromCtx.storage.get('anonymous-key');
      expect(anonymousValue).toBe('anonymous-value');
      
      // Verify ctx proxy matches between stub.ctx and stubs.ctx()
      const anonymousViaStubGet = await anonymousFromGet.ctx.storage.get('anonymous-key');
      expect(anonymousViaStubGet).toBe('anonymous-value'); // Same storage, same value

      helpers.flush();
    }, {
      someOption: 'someValue',
    });

  });

});