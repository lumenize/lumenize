// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF, env } from 'cloudflare:test';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { serialize, deserialize } = require('@ungap/structured-clone');

/**
 * Context registry that provides direct access to DO contexts without stubs
 */
export interface ContextRegistry {
  /**
   * Get a context proxy for a specific DO instance
   * @param bindingName - The binding name (e.g., 'MY_DO')
   * @param instanceName - The instance name/id
   * @returns A proxy to the DO's ctx
   */
  get(bindingName: string, instanceName: string): any;
  
  /**
   * List all contexts or contexts for a specific binding
   * @param bindingName - Optional binding name to filter by
   * @returns Array of context entries
   */
  list(bindingName?: string): ContextEntry[];
}

/**
 * Context entry information
 */
export interface ContextEntry {
  bindingName: string;
  name: string;
  ctx: any;
}

/**
 * Creates a pure context proxy that tunnels through Worker fetch to DO
 * No stubs involved - direct Worker → DO routing via fetch
 */
function createPureContextProxy(bindingName: string, instanceName: string, path: string[] = []): any {
  const proxyFunction = function(...args: any[]) {
    // When called as a function, make a 'call' request
    return makePureCtxRequest(bindingName, instanceName, 'call', path, args);
  };
  
  return new Proxy(proxyFunction, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') {
        return undefined;
      }
      
      // Handle promise-like behavior for await
      if (prop === 'then') {
        // When someone tries to await this proxy, get the property value
        const promise = makePureCtxRequest(bindingName, instanceName, 'get', path);
        return promise.then.bind(promise);
      }
      
      if (prop === 'catch') {
        const promise = makePureCtxRequest(bindingName, instanceName, 'get', path);
        return promise.catch.bind(promise);
      }
      
      // Chain deeper into the property path
      const newPath = [...path, prop as string];
      return createPureContextProxy(bindingName, instanceName, newPath);
    },
    
    apply(target, thisArg, args) {
      return makePureCtxRequest(bindingName, instanceName, 'call', path, args);
    }
  });
}

async function makePureCtxRequest(bindingName: string, instanceName: string, type: 'get' | 'call', path: string[], args?: any[]): Promise<any> {
  // This is the key change: use routeDORequest directly instead of SELF.fetch
  // routeDORequest is designed to work within the current request context
  const requestBody = {
    type,
    path,
    args: args || []
  };
  
  // Convert binding name to URL-friendly format for routing
  const bindingPath = bindingName.toLowerCase().replace(/_/g, '-');
  const url = `https://fake-host/${bindingPath}/${instanceName}/__testing/ctx`;
  
  const request = new Request(url, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'X-Testing-Binding': bindingName
    },
    body: JSON.stringify(serialize(requestBody))
  });
  
  // Import routeDORequest dynamically to avoid circular deps
  const { routeDORequest } = await import('@lumenize/utils');
  
  // Get env from the test context - we need this for routeDORequest
  const testEnv = (globalThis as any).__testingEnv;
  if (!testEnv) {
    throw new Error('Test env not available - this is a testing framework bug');
  }
  
  // Use routeDORequest which is designed to work in the current context
  const response = await routeDORequest(request, testEnv);
  
  if (!response || !response.ok) {
    throw new Error(`Testing ctx request failed: ${response?.status || 'no response'} ${response ? await response.text() : 'routeDORequest returned undefined'}`);
  }
  
  const serializedData = await response.json();
  
  // Use JSON.parse first, then structured-clone deserialize
  return deserialize(serializedData);
}

/**
 * Sets up a test environment for a Durable Object project
 * @param testFn - Test function that receives SELF, contexts, and helpers
 * @param options - Optional configuration for the test environment
 * @returns Promise that resolves when test completes
 */
export async function testDOProject<T = any>(
  testFn: (SELF: any, contexts: ContextRegistry, helpers: any) => Promise<void> | void,
  options?: T
): Promise<void> {
  // Track created contexts for the list() method
  const createdContexts = new Map<string, ContextEntry>();
  
  // Function to register a DO context when accessed
  function registerDOContext(bindingName: string, instanceName: string) {
    const key = `${bindingName}:${instanceName}`;
    
    // Don't duplicate if already exists
    if (createdContexts.has(key)) {
      return;
    }
    
    // Create new context proxy
    const ctx = createPureContextProxy(bindingName, instanceName);
    
    // Track this context
    createdContexts.set(key, {
      bindingName,
      name: instanceName,
      ctx
    });
  }
  
  // TODO: Remove monkey patching since instrumentWorker should handle this
  // But let's test if instrumentWorker is actually working for auto-registration
  
  // Create context registry that provides direct access to DO contexts
  const contextRegistry: ContextRegistry = {
    get(bindingName: string, instanceName: string) {
      const key = `${bindingName}:${instanceName}`;
      
      // Check if we already have this context
      if (createdContexts.has(key)) {
        return createdContexts.get(key)!.ctx;
      }
      
      // Register this context
      registerDOContext(bindingName, instanceName);
      return createdContexts.get(key)!.ctx;
    },
    
    list(bindingName?: string): ContextEntry[] {
      const entries = Array.from(createdContexts.values());
      if (bindingName) {
        return entries.filter(entry => entry.bindingName === bindingName);
      }
      return entries;
    }
  };
  
  // Store env and registration function globally
  // Important: We need to provide the instrumented env for custom Workers
  const { instrumentEnvironment } = await import('./instrument-worker.js');
  const instrumentedEnv = instrumentEnvironment(env);
  
  (globalThis as any).__testingEnv = instrumentedEnv;
  (globalThis as any).__testingContextRegistry = registerDOContext;
  
  // Create simple helpers object
  const helpers = {
    _restore: () => {
      // No cleanup needed for pure context approach
    }
  };
  
  try {
    // Call the test function with SELF, contexts, and helpers
    await testFn(SELF, contextRegistry, helpers);
  } finally {
    // Cleanup globals
    delete (globalThis as any).__testingEnv;
    delete (globalThis as any).__testingContextRegistry;
  }
}