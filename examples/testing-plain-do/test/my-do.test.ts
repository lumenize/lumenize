import { describe, it, expect, vi } from 'vitest';
import { testDOProject } from '@lumenize/testing';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { env, createExecutionContext } from 'cloudflare:test';

describe('MyDO', () => {

  it('should be used to experiment', async () => {
    await testDOProject(async (SELF, testingStubRegistry, helpers) => {
      
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
      expect(typeof storageList).toBe('object');
      // Fresh DO should have empty storage
      expect(Object.keys(storageList)).toHaveLength(0);
      
      // Check if our testingStubRegistry was populated correctly
      expect(testingStubRegistry).toBeDefined();
      expect(testingStubRegistry.size).toBe(1); // Should have MY_DO binding
      
      const myDoTestingStubs = testingStubRegistry.get('MY_DO');
      expect(myDoTestingStubs).toBeDefined();
      expect(myDoTestingStubs!.size).toBe(3); // Should have 3 testing stubs
      
      // Check named testing stubs are accessible by name
      expect(myDoTestingStubs!.has('my-direct-instance')).toBe(true);
      expect(myDoTestingStubs!.has('my-instance-name')).toBe(true);
      
      // Anonymous testing stub should be accessible by ID string
      const anonymousKey = Array.from(myDoTestingStubs!.keys()).find(key => 
        key !== 'my-direct-instance' && key !== 'my-instance-name'
      );
      expect(anonymousKey).toBeDefined();
      expect(anonymousKey!.length).toBeGreaterThan(32); // Should be a long opaque ID

      helpers.flush();
    }, {
      someOption: 'someValue',
    });

  });

});