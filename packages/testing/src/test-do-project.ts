// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF, env } from 'cloudflare:test';

/**
 * Represents a Durable Object instance proxy with dynamic access to internal state
 * via instrumentation endpoints
 */
interface DurableObjectProxy {
  /** Dynamic access to any properties/methods on the real DO instance */
  [key: string]: any;
}

/**
 * Map of DO instances by their name/id
 */
type DurableObjectInstanceMap = Map<string, DurableObjectProxy>;

/**
 * Map of DO bindings, each containing a map of instances
 */
type DurableObjectsMap = Map<string, DurableObjectInstanceMap>;

/**
 * Sets up a test environment for a Durable Object project
 * @param testFn - Test function that receives SELF, durableObjects, and helpers
 * @param options - Optional configuration for the test environment
 * @returns Promise that resolves when test completes
 */
export async function testDOProject<T = any>(
  testFn: (SELF: any, durableObjects: DurableObjectsMap, helpers: any) => Promise<void> | void,
  options?: T
): Promise<void> {
  // Create durableObjects map to track instances
  const durableObjects = new Map<string, DurableObjectInstanceMap>();
  
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
    if (!durableObjects.has(bindingName)) {
      durableObjects.set(bindingName, new Map());
    }
    const instanceMap = durableObjects.get(bindingName)!;
    
    // Store original methods
    originalMethods.set(`${bindingName}.getByName`, namespace.getByName);
    originalMethods.set(`${bindingName}.get`, namespace.get);
    
    // Monkey-patch getByName
    namespace.getByName = function(name: string) {
      const stub = originalMethods.get(`${bindingName}.getByName`).call(this, name);
      const idString = stub.id.toString();
      
      console.log(`[testDOProject] ${bindingName}.getByName('${name}') -> ${idString}`);
      
      // Use the name as the key for the map
      instanceMap.set(name, stub);
      
      return stub;
    };
    
    // Monkey-patch get
    namespace.get = function(id: any) {
      const stub = originalMethods.get(`${bindingName}.get`).call(this, id);
      const idString = id.toString();
      
      // Get name directly from the stub
      const stubName = stub.name || stub.id?.name;
      
      if (stubName) {
        console.log(`[testDOProject] ${bindingName}.get('${idString}') -> ${stubName}`);
        // Use the name as the key
        instanceMap.set(stubName, stub);
      } else {
        console.log(`[testDOProject] ${bindingName}.get('${idString}') -> anonymous`);
        // Use the ID string as the key for anonymous instances
        instanceMap.set(idString, stub);
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
    // Call the test function with the real SELF and populated durableObjects map
    await testFn(SELF, durableObjects, helpers);
  } finally {
    // Always restore original methods
    helpers._restore();
  }
}