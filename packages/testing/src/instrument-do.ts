/**
 * Preprocesses an object to replace functions with descriptive strings
 * so they can be transported through RPC calls.
 * 
 * Functions are replaced with strings like "functionName [Function]" 
 * to provide a discoverable API surface.
 */
function preprocessFunctions(obj: any, seen = new WeakSet()): any {
  // Handle primitive types and null/undefined
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
    return obj.map(item => preprocessFunctions(item, seen));
  }
  
  // Handle built-in types that structured clone handles natively
  if (obj instanceof Date || obj instanceof RegExp || obj instanceof Map || 
      obj instanceof Set || obj instanceof ArrayBuffer || 
      ArrayBuffer.isView(obj) || obj instanceof Error) {
    return obj;
  }
  
  // Handle plain objects
  const result: any = {};
  
  // First, collect all enumerable properties
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'function') {
      // Replace function with descriptive string
      const functionName = value.name || 'anonymous';
      result[key] = `${functionName} [Function]`;
    } else if (typeof value === 'symbol') {
      // Handle symbols
      result[key] = `[Symbol: ${value.toString()}]`;
    } else if (typeof value === 'object' && value !== null) {
      // Recursively process nested objects
      result[key] = preprocessFunctions(value, seen);
    } else {
      // Keep primitives as-is
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
      
      // Check if it's a method (function)
      if (descriptor.value && typeof descriptor.value === 'function') {
        const functionName = descriptor.value.name || key;
        result[key] = `${functionName} [Function]`;
      }
      // Check if it's a getter that returns a function
      else if (descriptor.get) {
        try {
          const value = descriptor.get.call(obj);
          if (typeof value === 'function') {
            const functionName = value.name || key;
            result[key] = `${functionName} [Function]`;
          } else if (value !== undefined && value !== null) {
            result[key] = preprocessFunctions(value, seen);
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
 * Instruments user's DO with endpoints to enable ctx inspection and other testing functionality
 */
export function instrumentDO<T>(DOClass: T): T {
  if (typeof DOClass !== 'function') {
    return DOClass;
  }

  // Create instrumented class that extends the original
  class InstrumentedDO extends (DOClass as any) {
    private __testingCtx: any;

    constructor(ctx: any, env: any) {
      super(ctx, env);
      // Store a reference to ctx for testing access
      this.__testingCtx = ctx;
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      
      // Handle testing endpoints
      if (url.pathname.startsWith('/__testing/')) {
        return this.handleTestingEndpoint(url.pathname, request);
      }
      
      // Delegate to original fetch method
      return super.fetch(request);
    }

    // RPC method for getting property values from ctx
    async __testing_ctx_get(path: string[]): Promise<any> {
      let target = this.__testingCtx;
      
      // Navigate to the target object using the path
      for (const prop of path) {
        target = target[prop];
        if (target === undefined || target === null) {
          // Return undefined for non-existent properties instead of throwing
          // This matches the natural JavaScript behavior
          return undefined;
        }
      }
      
      // For get requests, preprocess functions to make them discoverable
      // This transforms the object to replace functions with "functionName [Function]" strings
      return preprocessFunctions(target);
    }

    // RPC method for calling methods on ctx
    async __testing_ctx_call(path: string[], args: any[] = []): Promise<any> {
      let target = this.__testingCtx;
      
      // Navigate to the target object using the path
      for (let i = 0; i < path.length - 1; i++) {
        target = target[path[i]];
        if (target === undefined || target === null) {
          throw new Error(`Path not found: ${path.slice(0, i + 1).join('.')}`);
        }
      }
      
      const finalProp = path[path.length - 1];
      const method = target[finalProp];
      
      // Let the natural JavaScript runtime error occur when calling non-functions
      // This gives more authentic error messages that match what would happen in the DO
      const result = method.apply(target, args || []);
      
      // Await promises on the DO side and return result
      if (result && typeof result.then === 'function') {
        return await result;
      }
      
      return result;
    }

    private async handleTestingEndpoint(pathname: string, request: Request): Promise<Response> {
      switch (pathname) {
        case '/__testing/info':
          return Response.json({
            className: this.constructor.name,
            timestamp: Date.now(),
            isInstrumented: true,
            availableEndpoints: [
              '/__testing/info'
            ],
            // Note: ctx access now available via RPC methods __testing_ctx_get and __testing_ctx_call
            ctxProxyAvailable: true
          });
        
        default:
          return new Response('Testing endpoint not found', { status: 404 });
      }
    }
  }

  // Copy static properties from original class
  Object.setPrototypeOf(InstrumentedDO, DOClass);
  Object.defineProperty(InstrumentedDO, 'name', { value: (DOClass as any).name });

  return InstrumentedDO as T;
}