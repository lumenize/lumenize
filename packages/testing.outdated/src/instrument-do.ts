// eslint-disable-next-line @typescript-eslint/no-require-imports
const { serialize, deserialize } = require('@ungap/structured-clone');

/**
 * Preprocesses an object to replace functions with callable proxy functions
 * and keep primitive values as-is for direct access.
 * 
 * Functions are replaced with proxy functions that can be called directly,
 * while primitive values (numbers, strings, etc.) are preserved for 
 * synchronous access without needing await.
 */
function preprocessFunctions(obj: any, seen = new WeakMap(), basePath: string[] = []): any {
  // Handle primitive types and null/undefined
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
    result.push(...obj.map(item => preprocessFunctions(item, seen, basePath)));
    return result;
  }
  
  // Handle built-in types that structured clone handles natively
  if (obj instanceof Date || obj instanceof RegExp || obj instanceof Map || 
      obj instanceof Set || obj instanceof ArrayBuffer || 
      ArrayBuffer.isView(obj) || obj instanceof Error) {
    return obj;
  }
  
  // Handle plain objects
  const result: any = {};
  seen.set(obj, result); // Set early to handle circular refs
  
  // First, collect all enumerable properties
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = [...basePath, key];
    
    if (typeof value === 'function') {
      // Create a callable proxy function that tunnels back to the DO
      result[key] = createRemoteFunction(currentPath);
    } else if (typeof value === 'symbol') {
      // Handle symbols
      result[key] = `[Symbol: ${value.toString()}]`;
    } else if (typeof value === 'object' && value !== null) {
      // Recursively process nested objects
      result[key] = preprocessFunctions(value, seen, currentPath);
    } else {
      // Keep primitives as-is for direct synchronous access
      result[key] = value;
    }
  }
  
  // Also check the prototype chain for methods (but not Object.prototype to avoid noise)
  let proto = Object.getPrototypeOf(obj);
  while (proto && proto !== Object.prototype && proto !== null) {
    const descriptors = Object.getOwnPropertyDescriptors(proto);
    
    for (const [key, descriptor] of Object.entries(descriptors)) {
      // Skip constructor and already processed properties
      if (key === 'constructor' || result.hasOwnProperty(key)) {
        continue;
      }
      
      const currentPath = [...basePath, key];
      
      // Check if it's a method (function)
      if (descriptor.value && typeof descriptor.value === 'function') {
        result[key] = createRemoteFunction(currentPath);
      }
      // Check if it's a getter that returns a function
      else if (descriptor.get) {
        try {
          const value = descriptor.get.call(obj);
          if (typeof value === 'function') {
            result[key] = createRemoteFunction(currentPath);
          } else if (value !== undefined && value !== null) {
            result[key] = preprocessFunctions(value, seen, currentPath);
          }
        } catch (error) {
          // If getter throws, just note it
          result[key] = '[Getter throws]';
        }
      }
    }
    
    proto = Object.getPrototypeOf(proto);
  }
  
  return result;
}

/**
 * Creates a serializable remote function marker
 */
function createRemoteFunction(path: string[]): any {
  // Instead of creating an actual function, create a special object marker
  // that can be serialized and identified on the client side
  return {
    __isRemoteFunction: true,
    __remotePath: path,
    __functionName: path[path.length - 1] || 'anonymous'
  };
}

/**
 * Instruments user's DO with RPC methods to enable instance inspection and other testing functionality
 */
export function instrumentDO<T>(DOClass: T): T {
  if (typeof DOClass !== 'function') {
    return DOClass;
  }

  // Create instrumented class that extends the original
  class InstrumentedDO extends (DOClass as any) {

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      
      // Handle testing endpoints - look for /__testing/ anywhere in the path
      const testingIndex = url.pathname.indexOf('/__testing/');
      if (testingIndex !== -1) {
        const testingPath = url.pathname.substring(testingIndex);
        return this.handleTestingEndpoint(testingPath, request);
      }
      
      // Delegate to the original user's fetch method
      return super.fetch(request);
    }

    async handleTestingEndpoint(pathname: string, request: Request): Promise<Response> {
      switch (pathname) {
        case '/__testing/info':
          return Response.json({
            className: this.constructor.name,
            timestamp: Date.now(),
            isInstrumented: true,
            availableEndpoints: [
              '/__testing/info',
              '/__testing/instance'
            ],
            instanceProxyAvailable: true
          });
          
        case '/__testing/instance':
          return this.handleInstanceProxy(request);
          
        default:
          return new Response('Testing endpoint not found', { status: 404 });
      }
    }

    async handleInstanceProxy(request: Request): Promise<Response> {
      try {
        const requestData = await request.json();
        const requestBody = deserialize(requestData) as { type: 'get' | 'call', path: string[], args?: any[] };
        const { type, path, args } = requestBody;
        
        let target = this; // Start from the entire DO instance, providing full access to this.ctx, this.env, constructor, and all methods
        
        // Handle the case where path is empty (accessing root instance)
        if (path.length === 0) {
          if (type === 'get') {
            // Return the entire instance, preprocessed for discovery
            const result = preprocessFunctions(this);
            const serialized = serialize(result);
            return Response.json(serialized);
          } else {
            // For calls on root, we'd need a method name in the path
            throw new Error('instance root (this) is not a function');
          }
        }
        
        // Navigate to the target object using the path
        for (let i = 0; i < path.length - 1; i++) {
          target = target[path[i]];
          if (target === undefined || target === null) {
            throw new Error(`Path not found: ${path.slice(0, i + 1).join('.')}`);
          }
        }
        
        const finalProp = path[path.length - 1];
        let result;
        
        if (type === 'get') {
          result = target[finalProp];
          // For GET requests, preprocess functions to make them discoverable
          result = preprocessFunctions(result);
        } else if (type === 'call') {
          const method = target[finalProp];
          
          // Check if the method exists and is callable
          if (method === undefined || method === null) {
            throw new Error(`Method '${finalProp}' does not exist on ${target.constructor?.name || 'object'}`);
          }
          if (typeof method !== 'function') {
            throw new Error(`Property '${finalProp}' is not a function (it's a ${typeof method})`);
          }
          
          result = method.apply(target, args || []);
          
          // Await promises on the DO side and return result
          if (result && typeof result.then === 'function') {
            result = await result;
          }
          
          // Preprocess any functions in the call result to make them serializable
          result = preprocessFunctions(result);
        }
        
        // Use structured-clone for proper serialization, including special cases
        const serialized = serialize(result);
        return Response.json(serialized);
      } catch (error: any) {
        console.error(`[handleInstanceProxy] Error:`, error);
        return Response.json({ 
          error: error.message,
          stack: error.stack 
        }, { status: 500 });
      }
    }
  }

  // Copy static properties from original class
  Object.setPrototypeOf(InstrumentedDO, DOClass);
  Object.defineProperty(InstrumentedDO, 'name', { value: (DOClass as any).name });

  return InstrumentedDO as T;
}