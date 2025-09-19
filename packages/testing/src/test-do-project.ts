// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF, env } from 'cloudflare:test';

/**
 * Represents a Durable Object stub with dynamic access to internal state
 * via instrumentation endpoints. This wraps the standard DurableObjectStub
 * with additional testing capabilities like the .ctx proxy.
 */
export interface Stub {
  /** Dynamic access to any properties/methods on the real DO via the stub */
  [key: string]: any;
}

/**
 * Map of stubs by their name/id key
 */
export type StubRegistryMap = Map<string, Stub>;

/**
 * Registry entry containing the DO stub, the ctx Proxy and related metadata
 */
export interface StubRegistryEntry {
  bindingName: string;
  name?: string;
  id: string;
  stub: any;     // The DurableObjectStub
  ctx: any;      // ctx Proxy for testing internal state
}

/**
 * Registry for managing stubs across DO namespace bindings
 */
export class StubRegistry {
  private registry = new Map<string, StubRegistryMap>();

  /**
   * Get a Durable Object stub
   * @param bindingName - The DO namespace binding name (e.g., 'MY_DO')
   * @param stubIdentifier - The stub name or ID
   * @returns The DurableObjectStub with .ctx proxy attached for testing convenience
   */
  get(bindingName: string, stubIdentifier: string): any | undefined {
    return this._getStub(bindingName, stubIdentifier);
  }

  /**
   * Get the ctx proxy for direct access to DO internals
   * @param bindingName - The DO namespace binding name (e.g., 'MY_DO')
   * @param stubIdentifier - The stub name or ID
   * @returns The ctx proxy, or undefined if not found
   */
  ctx(bindingName: string, stubIdentifier: string): any | undefined {
    const stub = this._getStub(bindingName, stubIdentifier);
    return stub?.ctx;
  }

  /**
   * Get registry entry with complete stub metadata
   * @param bindingName - The DO namespace binding name (e.g., 'MY_DO')
   * @param stubIdentifier - The stub name or ID
   * @returns StubRegistryEntry with all details, or undefined if not found
   */
  entry(bindingName: string, stubIdentifier: string): StubRegistryEntry | undefined {
    const stub = this._getStub(bindingName, stubIdentifier);
    if (!stub) return undefined;

    return {
      bindingName,
      name: stub.name,
      id: stubIdentifier,
      stub: stub,
      ctx: stub.ctx
    };
  }

  /**
   * List all stubs, optionally filtered by binding name
   * @param bindingName - Optional binding name to filter by
   * @returns Array of stub registry entries
   */
  list(bindingName?: string): StubRegistryEntry[] {
    const result: StubRegistryEntry[] = [];
    
    if (bindingName) {
      // List only stubs for the specified binding
      const stubMap = this.registry.get(bindingName);
      if (stubMap) {
        for (const [stubId, stub] of stubMap) {
          result.push({
            bindingName,
            name: stub.name,
            id: stubId,
            stub: stub,
            ctx: stub.ctx
          });
        }
      }
    } else {
      // List all stubs across all bindings
      for (const [currentBindingName, stubMap] of this.registry) {
        for (const [stubId, stub] of stubMap) {
          result.push({
            bindingName: currentBindingName,
            name: stub.name,
            id: stubId,
            stub: stub,
            ctx: stub.ctx
          });
        }
      }
    }
    
    return result;
  }

  // Internal methods for the testing framework
  
  /** @internal */
  private _getStub(bindingName: string, stubIdentifier: string): any | undefined {
    const stubMap = this.registry.get(bindingName);
    return stubMap?.get(stubIdentifier);
  }

  /** @internal */
  _ensureBinding(bindingName: string): void {
    if (!this.registry.has(bindingName)) {
      this.registry.set(bindingName, new Map());
    }
  }

  /** @internal */
  _getStubMap(bindingName: string): StubRegistryMap {
    return this.registry.get(bindingName)!;
  }
}

/**
 * Creates a proxy that intercepts property access and method calls
 * and forwards them to the DO's ctx via RPC calls.
 * 
 * This proxy automatically detects usage patterns:
 * - When called as function: sends 'call' request
 * - When accessed and awaited: sends 'get' request 
 * - When accessed for chaining: returns new proxy
 */
function createCtxProxy(stub: any, path: string[] = []): any {
  const proxyFunction = function(...args: any[]) {
    // When called as a function, make a 'call' request
    return makeCtxRequest(stub, 'call', path, args);
  };
  
  return new Proxy(proxyFunction, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') {
        return undefined;
      }
      
      // Handle promise-like behavior for await
      if (prop === 'then') {
        // When someone tries to await this proxy, get the property value
        const promise = makeCtxRequest(stub, 'get', path);
        return promise.then.bind(promise);
      }
      if (prop === 'catch') {
        const promise = makeCtxRequest(stub, 'get', path);
        return promise.catch.bind(promise);
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
 * Makes a request to the DO's ctx via RPC calls
 */
async function makeCtxRequest(stub: any, type: 'get' | 'call', path: string[], args?: any[]): Promise<any> {
  if (type === 'get') {
    // Use RPC method for getting property values
    if (!stub.__testing_ctx_get) {
      throw new Error('Testing RPC method __testing_ctx_get not available on stub');
    }
    return await stub.__testing_ctx_get(path);
  } else {
    // Use RPC method for calling methods
    if (!stub.__testing_ctx_call) {
      throw new Error('Testing RPC method __testing_ctx_call not available on stub');
    }
    return await stub.__testing_ctx_call(path, args);
  }
}

/**
 * Sets up a test environment for a Durable Object project
 * @param testFn - Test function that receives SELF, stubs, and helpers
 * @param options - Optional configuration for the test environment
 * @returns Promise that resolves when test completes
 */
export async function testDOProject<T = any>(
  testFn: (SELF: any, stubs: StubRegistry, helpers: any) => Promise<void> | void,
  options?: T
): Promise<void> {
  // Create stub registry to track stubs
  const stubRegistry = new StubRegistry();
  
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
    stubRegistry._ensureBinding(bindingName);
    const stubRegistryMap = stubRegistry._getStubMap(bindingName);
    
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
      stubRegistryMap.set(name, stub);
      
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
        stubRegistryMap.set(stubName, stub);
      } else {
        console.log(`[testDOProject] ${bindingName}.get('${idString}') -> anonymous`);
        // Use the ID string as the key for anonymous stubs
        stubRegistryMap.set(idString, stub);
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
    // Call the test function with the real SELF and populated stub registry
    await testFn(SELF, stubRegistry, helpers);
  } finally {
    // Always restore original methods
    helpers._restore();
  }
}