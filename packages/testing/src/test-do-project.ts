// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF, env } from 'cloudflare:test';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { serialize, deserialize } = require('@ungap/structured-clone');
import { CookieJar } from './cookie-jar.js';
// import { createSimpleWebSocketMock } from './websocket-simple.js';
import { getWebSocketShim } from './websocket-shim';


/**
 * Instance registry that provides direct access to DO instances
 */
export interface InstanceRegistry {
  /**
   * Get an instance proxy for a specific DO instance
   * @param bindingName - The binding name (e.g., 'MY_DO')
   * @param instanceName - The instance name/id
   * @returns A proxy to the full DO instance (this)
   */
  (bindingName: string, instanceName: string): any;
  
  /**
   * List all instances or instances for a specific binding
   * @param bindingName - Optional binding name to filter by
   * @returns Array of instance entries
   */
  list(bindingName?: string): InstanceEntry[];
}

/**
 * Instance entry information
 */
export interface InstanceEntry {
  bindingName: string;
  name: string;
  instance: any;
}

/**
 * Creates a pure instance proxy that tunnels through Worker fetch to DO
 */
function createPureInstanceProxy(bindingName: string, instanceName: string, path: string[] = []): any {
  const proxyFunction = function(...args: any[]) {
    // When called as a function, make a 'call' request
    return makePureInstanceRequest(bindingName, instanceName, 'call', path, args);
  };
  
  const proxy = new Proxy(proxyFunction, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') {
        return undefined;
      }
      
      // Special property to get the actual object (for discovery/debugging)
      if (prop === '__asObject') {
        return async () => {
          // Get the result with string conversion instead of proxy conversion
          return await makePureInstanceRequest(bindingName, instanceName, 'get', path, undefined, 'strings');
        };
      }
      
      // Handle 'then' property for Promise compatibility
      // This allows `await proxy` to work by making a GET request instead of calling as function
      if (prop === 'then') {
        const getValue = makePureInstanceRequest(bindingName, instanceName, 'get', path);
        return getValue.then.bind(getValue);
      }
      
      // Chain deeper into the property path
      const newPath = [...path, prop as string];
      return createPureInstanceProxy(bindingName, instanceName, newPath);
    },
    
    apply(target, thisArg, args) {
      return makePureInstanceRequest(bindingName, instanceName, 'call', path, args);
    }
  });
  
  return proxy;
}

async function makePureInstanceRequest(
  bindingName: string, 
  instanceName: string, 
  type: 'get' | 'call', 
  path: string[], 
  args?: any[], 
  postProcess: 'proxies' | 'strings' = 'proxies'
): Promise<any> {
  /**
   * ARCHITECTURE NOTE: Independence from User's Worker Routing
   * 
   * This function uses routeDORequest from @lumenize/utils, which might seem like it creates
   * a dependency on the user's Worker also using routeDORequest. However, this is NOT the case.
   * 
   * The testing framework operates completely independently of the user's Worker routing:
   * 
   * 1. SEPARATE ENVIRONMENTS: The testing framework creates its own instrumented environment
   *    using instrumentEnvironment() which wraps the user's DO bindings. This environment
   *    is stored in globalThis.__testingEnv and is separate from how the user's Worker works.
   * 
   * 2. PROXY TUNNEL BYPASSES USER'S WORKER: When you call instances('MY_DO', 'test').ctx.storage.get(),
   *    the proxy creates a direct request to the DO instance (__testing/instance endpoint).
   *    This request goes through routeDORequest IN THE TESTING FRAMEWORK, not through the user's Worker.
   * 
   * 3. ROUTEDOREQUEST IS JUST A UTILITY HERE: We use routeDORequest only as a utility to:
   *    - Parse binding name from URL path (my-do → MY_DO)  
   *    - Find the correct DO binding in the instrumented environment
   *    - Get the appropriate DO stub and call fetch() on it
   * 
   * 4. PROVEN BY TESTS: The custom-routing.test.ts file demonstrates this works with Workers
   *    that use completely different routing strategies (direct env.MY_DO.getByName() calls,
   *    custom URL parsing, etc.) and all instance proxy functionality works perfectly.
   * 
   * FLOW: instances().ctx.storage.get() → makePureInstanceRequest() → routeDORequest(testing framework)
   *       → getDOStubFromPathname() → instrumentedDO.fetch() → handleInstanceProxy() → result
   * 
   * The user's Worker routing is never involved in this flow.
   */
  const requestBody = {
    type,
    path,
    args: args || []
  };
  
  // Convert binding name to URL-friendly format for routing
  const bindingPath = bindingName.toLowerCase().replace(/_/g, '-');
  const url = `https://fake-host/${bindingPath}/${instanceName}/__testing/instance`;
  
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
  
  if (!response) {
    throw new Error('Testing instance request failed: routeDORequest returned undefined');
  }
  
  const serializedData = await response.json();
  
  // Handle error responses by re-throwing the original error
  if (!response.ok) {
    // The error response contains { error: string, stack?: string }
    const errorData = serializedData as { error?: string; stack?: string };
    if (errorData.error) {
      const error = new Error(errorData.error);
      if (errorData.stack) {
        error.stack = errorData.stack;
      }
      throw error;
    } else {
      throw new Error(`Testing instance request failed: ${response.status} ${JSON.stringify(serializedData)}`);
    }
  }
  
  // Use JSON.parse first, then structured-clone deserialize
  const result = deserialize(serializedData);
  
  // Post-process the result based on the requested format
  if (postProcess === 'strings') {
    // For __asObject() requests, convert remote functions to readable strings
    return convertRemoteFunctionsToStrings(result);
  } else {
    // For normal requests, convert remote functions back to proxies
    return convertRemoteFunctionsToProxies(result, bindingName, instanceName);
  }
}

/**
 * Converts remote function markers back to working proxy functions
 */
function convertRemoteFunctionsToProxies(obj: any, bindingName: string, instanceName: string, seen = new WeakSet()): any {
  // Handle primitive types and null/undefined - return as-is for direct access
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }
  
  // Handle circular references
  if (seen.has(obj)) {
    return '[Circular Reference]';
  }
  seen.add(obj);
  
  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => convertRemoteFunctionsToProxies(item, bindingName, instanceName, seen));
  }
  
  // Handle built-in types - return as-is
  if (obj instanceof Date || obj instanceof RegExp || obj instanceof Map || 
      obj instanceof Set || obj instanceof ArrayBuffer || 
      ArrayBuffer.isView(obj) || obj instanceof Error) {
    return obj;
  }
  
  // Check if this is a remote function marker (object with special properties)
  if (obj && typeof obj === 'object' && obj.__isRemoteFunction && obj.__remotePath) {
    // Convert back to a working proxy
    return createPureInstanceProxy(bindingName, instanceName, obj.__remotePath);
  }
  
  // Handle plain objects - recursively process but preserve structure
  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = convertRemoteFunctionsToProxies(value, bindingName, instanceName, seen);
  }
  
  return result;
}

/**
 * Converts remote function markers to readable "[Function]" strings for __asObject() display
 */
function convertRemoteFunctionsToStrings(obj: any, seen = new WeakMap()): any {
  // Handle primitive types and null/undefined - return as-is
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }
  
  // Handle circular references by returning the already-processed object
  if (seen.has(obj)) {
    return seen.get(obj);
  }
  
  // Handle arrays
  if (Array.isArray(obj)) {
    const result: any[] = [];
    seen.set(obj, result); // Set early to handle circular refs
    result.push(...obj.map(item => convertRemoteFunctionsToStrings(item, seen)));
    return result;
  }
  
  // Handle built-in types - return as-is
  if (obj instanceof Date || obj instanceof RegExp || obj instanceof Map || 
      obj instanceof Set || obj instanceof ArrayBuffer || 
      ArrayBuffer.isView(obj) || obj instanceof Error) {
    return obj;
  }
  
  // Check if this is a remote function marker (object with special properties)
  if (obj && typeof obj === 'object' && obj.__isRemoteFunction && obj.__remotePath && obj.__functionName) {
    // Convert to readable string instead of proxy
    return `${obj.__functionName} [Function]`;
  }
  
  // Handle plain objects - recursively process but preserve structure
  const result: any = {};
  seen.set(obj, result); // Set early to handle circular refs
  for (const [key, value] of Object.entries(obj)) {
    result[key] = convertRemoteFunctionsToStrings(value, seen);
  }
  
  return result;
}

/**
 * Creates a cookie-aware wrapper around SELF.fetch that automatically manages cookies
 */
function createCookieAwareSELF(originalSELF: any, cookieJar: CookieJar): any {
  return {
    ...originalSELF,
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      // Convert input to Request object for easier manipulation
      const request = new Request(input, init);
      
      // Add cookies to the request if any match
      const cookieHeader = cookieJar.getCookiesForRequest(request.url);
      if (cookieHeader) {
        request.headers.set('Cookie', cookieHeader);
      }
      
      // Make the actual request
      const response = await originalSELF.fetch(request);
      
      // Store any Set-Cookie headers from the response
      cookieJar.storeCookiesFromResponse(response, request.url);
      
      return response;
    }
  };
}

/**
 * Sets up a test environment for a Durable Object project
 * @param testFn - Test function that receives SELF, instances, and helpers
 * @returns Promise that resolves when test completes
 */
export async function testDOProject(
  testFn: (SELF: any, instances: InstanceRegistry, helpers: any) => Promise<void> | void
): Promise<void> {
  // Track created instances for the list() method
  const createdInstances = new Map<string, InstanceEntry>();
  
  // Function to register a DO instance when accessed
  function registerDOInstance(bindingName: string, instanceName: string) {
    const key = `${bindingName}:${instanceName}`;
    
    // Don't duplicate if already exists
    if (createdInstances.has(key)) {
      return;
    }
    
    // Create new instance proxy
    const instance = createPureInstanceProxy(bindingName, instanceName);
    
    // Track this instance
    createdInstances.set(key, {
      bindingName,
      name: instanceName,
      instance
    });
  }
  
  // Note: We have two registration mechanisms:
  // 1. Manual registration (when users call instances('MY_DO', 'name'))  
  // 2. Automatic registration (when users call env.MY_DO.getByName() - handled by instrumentWorker)
  // Both are needed for different use cases
  
  // Create instance registry that provides direct access to DO instances
  const instanceRegistry: InstanceRegistry = Object.assign(
    function(bindingName: string, instanceName: string) {
      const key = `${bindingName}:${instanceName}`;
      
      // Check if we already have this instance
      if (createdInstances.has(key)) {
        return createdInstances.get(key)!.instance;
      }
      
      // Register this instance
      registerDOInstance(bindingName, instanceName);
      return createdInstances.get(key)!.instance;
    },
    {
      list(bindingName?: string): InstanceEntry[] {
        const entries = Array.from(createdInstances.values());
        if (bindingName) {
          return entries.filter(entry => entry.bindingName === bindingName);
        }
        return entries;
      }
    }
  );
  
  // Store env and registration function globally
  // Important: We need to provide the instrumented env for custom Workers
  const { instrumentEnvironment } = await import('./instrument-worker.js');
  const instrumentedEnv = instrumentEnvironment(env);
  
  (globalThis as any).__testingEnv = instrumentedEnv;
  (globalThis as any).__testingInstanceRegistry = registerDOInstance;
  
  // Set up cookie jar (always available, but can be disabled via options)
  const cookieJar = new CookieJar();
  
  // Create cookie-aware SELF wrapper
  const cookieAwareSELF = createCookieAwareSELF(SELF, cookieJar);
  
  // Create helpers object with options and cookie management
  const helpers = {
    _restore: () => {
      // No cleanup needed for pure instance approach
    },
    options: {
      get hostname() {
        return (cookieJar as any).inferredHostname;
      },
      set hostname(value: string) {
        cookieJar.setDefaultHostname(value);
      },
      get cookieJar() {
        return cookieJar.isEnabled();
      },
      set cookieJar(enabled: boolean) {
        cookieJar.setEnabled(enabled);
      }
    },
    cookies: {
      get: (name: string, domain?: string) => cookieJar.getCookie(name, domain),
      set: (name: string, value: string, options?: any) => cookieJar.setCookie(name, value, options),
      getAll: () => cookieJar.getAllCookies(),
      remove: (name: string, domain?: string, path?: string) => cookieJar.removeCookie(name, domain, path),
      clear: () => cookieJar.clear()
    },
    // Simple WebSocket mock that converts wss:// to https://
    WebSocket: getWebSocketShim(cookieAwareSELF),
    getWebSocketShim,  // hanging onto helpers in 
  };
  
  try {
    // Call the test function with cookie-aware SELF, instances, and helpers
    await testFn(cookieAwareSELF, instanceRegistry, helpers);
  } finally {
    // Cleanup globals
    delete (globalThis as any).__testingEnv;
    delete (globalThis as any).__testingInstanceRegistry;
  }
}