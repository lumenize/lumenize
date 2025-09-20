import { describe, it, expect } from 'vitest';
import { testDOProject } from '@lumenize/testing';

/**
 * Test with a Worker that uses custom routing instead of routeDORequest
 * This verifies that our instrumentation works regardless of routing strategy
 */
describe('Custom Routing Worker', () => {

  it('works with custom routing logic that calls env.MY_DO directly', async () => {
    // Create a custom Worker that doesn't use routeDORequest
    const customWorker = {
      async fetch(request: Request, env: any, ctx: ExecutionContext) {
        const url = new URL(request.url);
        
        // Custom routing logic - different from routeDORequest
        if (url.pathname.startsWith('/my-do/')) {
          const pathParts = url.pathname.split('/');
          const instanceName = pathParts[2]; // /my-do/{instanceName}/...
          
          // Direct DO access - this should be tracked by instrumentWorker
          const doStub = env.MY_DO.getByName(instanceName);
          return doStub.fetch(request);
        }
        
        if (url.pathname.startsWith('/different-routing/')) {
          const instanceId = url.searchParams.get('id');
          if (instanceId) {
            // Alternative access pattern - should also be tracked
            const doStub = env.MY_DO.get(env.MY_DO.idFromString(instanceId));
            return doStub.fetch(request);
          }
        }
        
        return new Response('Not found', { status: 404 });
      }
    };
    
    await testDOProject(async (SELF, contexts, helpers) => {
      // Override SELF with our custom worker for this test
      const customSELF = {
        fetch: (url: string | Request, init?: RequestInit) => {
          const request = typeof url === 'string' ? new Request(url, init) : url;
          return customWorker.fetch(request, (globalThis as any).__testingEnv, {} as ExecutionContext);
        }
      };
      
      // Make requests through custom routing
      const response1 = await customSELF.fetch('https://example.com/my-do/custom-test-1/increment');
      expect(response1.status).toBe(200);
      
      const response2 = await customSELF.fetch('https://example.com/my-do/custom-test-2/increment');
      expect(response2.status).toBe(200);
      
      // Verify that instrumentWorker tracked these DO accesses
      const allContexts = contexts.list();
      expect(allContexts.length).toBe(2);
      
      const myDOContexts = contexts.list('MY_DO');
      expect(myDOContexts.length).toBe(2);
      
      // Verify the specific instances were tracked
      const instanceNames = myDOContexts.map(ctx => ctx.name);
      expect(instanceNames).toContain('custom-test-1');
      expect(instanceNames).toContain('custom-test-2');
      
      // Verify we can still access contexts directly
      const ctx1 = contexts.get('MY_DO', 'custom-test-1');
      const count1 = await ctx1.storage.get('count');
      expect(count1).toBe(1); // Should have been incremented by the request
    });
  });

  it('tracks DO access with env.MY_DO.get() pattern', async () => {
    const customWorker = {
      async fetch(request: Request, env: any, ctx: ExecutionContext) {
        const url = new URL(request.url);
        
        if (url.pathname.startsWith('/by-id/')) {
          const instanceName = url.searchParams.get('name') || 'default-name';
          
          // Use get() with a proper ID generated from a name - should track by name, not hex ID
          const id = env.MY_DO.idFromName(instanceName);
          const doStub = env.MY_DO.get(id);
          return doStub.fetch(request);
        }
        
        return new Response('Not found', { status: 404 });
      }
    };
    
    await testDOProject(async (SELF, contexts, helpers) => {
      const customSELF = {
        fetch: (url: string | Request, init?: RequestInit) => {
          const request = typeof url === 'string' ? new Request(url, init) : url;
          return customWorker.fetch(request, (globalThis as any).__testingEnv, {} as ExecutionContext);
        }
      };
      
      // Make request using get() pattern with proper ID
      const response = await customSELF.fetch('https://example.com/by-id/increment?name=test-name-123');
      expect(response.status).toBe(200);
      
      // Verify tracking worked and used the original name, not the hex ID
      const allContexts = contexts.list();
      expect(allContexts.length).toBe(1);
      
      const myDOContexts = contexts.list('MY_DO');
      expect(myDOContexts.length).toBe(1);
      expect(myDOContexts[0].name).toBe('test-name-123'); // Should be the original name!
      
      // CRITICAL: Verify the ctx proxy tunnel actually works for this tracked context
      const ctx = myDOContexts[0].ctx;
      const count = await ctx.storage.get('count');
      expect(count).toBe(1); // Should have been incremented by the request
      
      // Verify we can also access it via contexts.get()
      const ctxViaGet = contexts.get('MY_DO', 'test-name-123');
      const sameCount = await ctxViaGet.storage.get('count');
      expect(sameCount).toBe(1);
    });
  });

  it('tracks DO access with unique ID (no name available) AND ctx tunnel works', async () => {
    let capturedUniqueId: string;
    
    const customWorker = {
      async fetch(request: Request, env: any, ctx: ExecutionContext) {
        const url = new URL(request.url);
        
        if (url.pathname.startsWith('/unique-id/')) {
          // Use newUniqueId() - should track by hex ID since there's no name
          const id = env.MY_DO.newUniqueId();
          capturedUniqueId = id.toString(); // Capture for later verification
          const doStub = env.MY_DO.get(id);
          return doStub.fetch(request);
        }
        
        return new Response('Not found', { status: 404 });
      }
    };
    
    await testDOProject(async (SELF, contexts, helpers) => {
      const customSELF = {
        fetch: (url: string | Request, init?: RequestInit) => {
          const request = typeof url === 'string' ? new Request(url, init) : url;
          return customWorker.fetch(request, (globalThis as any).__testingEnv, {} as ExecutionContext);
        }
      };
      
      // Make request using newUniqueId() pattern
      const response = await customSELF.fetch('https://example.com/unique-id/increment');
      expect(response.status).toBe(200);
      
      // Verify tracking worked and used the hex ID since no name was available
      const allContexts = contexts.list();
      expect(allContexts.length).toBe(1);
      
      const myDOContexts = contexts.list('MY_DO');
      expect(myDOContexts.length).toBe(1);
      const trackedName = myDOContexts[0].name;
      
      // Should be a 64-char hex string since no name was provided
      expect(trackedName).toMatch(/^[a-f0-9]{64}$/);
      expect(trackedName).toBe(capturedUniqueId); // Should match what we captured
      
      // CRITICAL: Verify the ctx proxy tunnel works even with a hex ID as the instance name
      const ctx = myDOContexts[0].ctx;
      const count = await ctx.storage.get('count');
      expect(count).toBe(1); // Should have been incremented by the request
      
      // CRITICAL: Verify we can also access it via contexts.get() using the hex ID
      const ctxViaGet = contexts.get('MY_DO', trackedName);
      const sameCount = await ctxViaGet.storage.get('count');
      expect(sameCount).toBe(1);
      
      // Verify we can modify storage via the ctx proxy
      await ctxViaGet.storage.put('test-key', 'test-value');
      const testValue = await ctx.storage.get('test-key');
      expect(testValue).toBe('test-value');
    });
  });

  it('tracks DO access with idFromString() + get() pattern AND ctx tunnel works', async () => {
    let capturedHexId: string;
    
    const customWorker = {
      async fetch(request: Request, env: any, ctx: ExecutionContext) {
        const url = new URL(request.url);
        
        if (url.pathname.startsWith('/from-string/')) {
          // First create a unique ID to get its string representation
          const uniqueId = env.MY_DO.newUniqueId();
          const hexString = uniqueId.toString();
          capturedHexId = hexString;
          
          // Now use idFromString() to recreate the ID from the string, then get() 
          // This simulates the pattern where you have a hex ID string (e.g., from a URL or database)
          const recreatedId = env.MY_DO.idFromString(hexString);
          const doStub = env.MY_DO.get(recreatedId);
          return doStub.fetch(request);
        }
        
        return new Response('Not found', { status: 404 });
      }
    };
    
    await testDOProject(async (SELF, contexts, helpers) => {
      const customSELF = {
        fetch: (url: string | Request, init?: RequestInit) => {
          const request = typeof url === 'string' ? new Request(url, init) : url;
          return customWorker.fetch(request, (globalThis as any).__testingEnv, {} as ExecutionContext);
        }
      };
      
      // Make request using idFromString() + get() pattern
      const response = await customSELF.fetch('https://example.com/from-string/increment');
      expect(response.status).toBe(200);
      
      // Verify tracking worked and used the hex ID since idFromString creates a unique ID
      const allContexts = contexts.list();
      expect(allContexts.length).toBe(1);
      
      const myDOContexts = contexts.list('MY_DO');
      expect(myDOContexts.length).toBe(1);
      const trackedName = myDOContexts[0].name;
      
      // Should be a 64-char hex string from idFromString
      expect(trackedName).toMatch(/^[a-f0-9]{64}$/);
      expect(trackedName).toBe(capturedHexId); // Should match the original hex string
      
      // CRITICAL: Verify the ctx proxy tunnel works with idFromString() + get() pattern
      const ctx = myDOContexts[0].ctx;
      const count = await ctx.storage.get('count');
      expect(count).toBe(1); // Should have been incremented by the request
      
      // CRITICAL: Verify we can also access it via contexts.get() using the hex ID
      const ctxViaGet = contexts.get('MY_DO', trackedName);
      const sameCount = await ctxViaGet.storage.get('count');
      expect(sameCount).toBe(1);
      
      // Verify we can modify storage via the ctx proxy  
      await ctxViaGet.storage.put('from-string-key', 'from-string-value');
      const testValue = await ctx.storage.get('from-string-key');
      expect(testValue).toBe('from-string-value');
    });
  });

});