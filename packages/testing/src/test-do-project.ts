// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF, env } from 'cloudflare:test';

/**
 * Represents a Durable Object stub with dynamic access to internal state
 * via instrumentation endpoints. This wraps the standard DurableObjectStub
 * with additional testing capabilities like the .ctx proxy.
 */
export interface TestingStub {
  /** Dynamic access to any properties/methods on the real DO via the stub */
  [key: string]: any;
}

/**
 * Map of testing stubs by their name/id key
 */
export type TestingStubMap = Map<string, TestingStub>;

/**
 * Map of DO namespace bindings, each containing a map of testing stubs
 */
export type TestingStubRegistry = Map<string, TestingStubMap>;

/**
 * Creates a proxy that intercepts property access and method calls
 * and forwards them to the DO's ctx via the testing endpoint
 */
function createCtxProxy(stub: any, path: string[] = []): any {
  return new Proxy(function() {}, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') {
        return undefined;
      }
      
      const newPath = [...path, prop as string];
      
      // Return another proxy for chaining
      return createCtxProxy(stub, newPath);
    },
    
    apply(target, thisArg, args) {
      // This is a method call - call with the current path
      return makeCtxRequest(stub, 'call', path, args);
    }
  });
}

/**
 * Makes a request to the DO's ctx testing endpoint
 */
async function makeCtxRequest(stub: any, type: 'get' | 'call', path: string[], args?: any[]): Promise<any> {
  const request = new Request('https://example.com/__testing/ctx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, path, args })
  });
  
  const response = await stub.fetch(request);
  const result = await response.json();
  
  if (!result.success) {
    throw new Error(`DO ctx proxy error: ${result.error}`);
  }
  
  // Always await the result to handle both sync and async operations uniformly
  return await result.result;
}

/**
 * Sets up a test environment for a Durable Object project
 * @param testFn - Test function that receives SELF, testingStubRegistry, and helpers
 * @param options - Optional configuration for the test environment
 * @returns Promise that resolves when test completes
 */
export async function testDOProject<T = any>(
  testFn: (SELF: any, testingStubRegistry: TestingStubRegistry, helpers: any) => Promise<void> | void,
  options?: T
): Promise<void> {
  // Create testingStubRegistry map to track testing stubs
  const testingStubRegistry = new Map<string, TestingStubMap>();
  
  // Track original methods for restoration
  const originalMethods = new Map<string, any>();
  
  // Helper to identify DO bindings in env
  const getDOBindings = () => {
    return Object.keys(env).filter(key => {
      const value = env[key];
      return value && 
             typeof value === 'object' && 
             typeof value.get === 'function' &&
             typeof value.getByName === 'function' &&
             typeof value.idFromName === 'function';
    });
  };
  
  // Monkey-patch each DO binding
  const doBindings = getDOBindings();
  
  for (const bindingName of doBindings) {
    const namespace = env[bindingName];
    
    // Initialize map for this binding
    if (!testingStubRegistry.has(bindingName)) {
      testingStubRegistry.set(bindingName, new Map());
    }
    const testingStubMap = testingStubRegistry.get(bindingName)!;
    
    // Store original methods
    originalMethods.set(`${bindingName}.getByName`, namespace.getByName);
    originalMethods.set(`${bindingName}.get`, namespace.get);
    
    // Monkey-patch getByName
    namespace.getByName = function(name: string) {
      const stub = originalMethods.get(`${bindingName}.getByName`).call(this, name);
      const idString = stub.id.toString();
      
      console.log(`[testDOProject] ${bindingName}.getByName('${name}') -> ${idString}`);
      
      // Add ctx proxy to the stub
      stub.ctx = createCtxProxy(stub);
      
      // Use the name as the key for the map
      testingStubMap.set(name, stub);
      
      return stub;
    };
    
    // Monkey-patch get
    namespace.get = function(id: any) {
      const stub = originalMethods.get(`${bindingName}.get`).call(this, id);
      const idString = id.toString();
      
      // Get name directly from the stub
      const stubName = stub.name || stub.id?.name;
      
      // Add ctx proxy to the stub
      stub.ctx = createCtxProxy(stub);
      
      if (stubName) {
        console.log(`[testDOProject] ${bindingName}.get('${idString}') -> ${stubName}`);
        // Use the name as the key
        testingStubMap.set(stubName, stub);
      } else {
        console.log(`[testDOProject] ${bindingName}.get('${idString}') -> anonymous`);
        // Use the ID string as the key for anonymous testing stubs
        testingStubMap.set(idString, stub);
      }
      
      return stub;
    };
  }
  
  // Create helpers object with cleanup
  const helpers = {
    flush: () => {
      // TODO: Implement flush functionality
    },
    
    // Helper to restore original methods (for cleanup)
    _restore: () => {
      for (const bindingName of doBindings) {
        const namespace = env[bindingName];
        if (originalMethods.has(`${bindingName}.getByName`)) {
          namespace.getByName = originalMethods.get(`${bindingName}.getByName`);
        }
        if (originalMethods.has(`${bindingName}.get`)) {
          namespace.get = originalMethods.get(`${bindingName}.get`);
        }
      }
    }
  };
  
  try {
    // Call the test function with the real SELF and populated testingStubRegistry
    await testFn(SELF, testingStubRegistry, helpers);
  } finally {
    // Always restore original methods
    helpers._restore();
  }
}