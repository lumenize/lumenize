import { serialize, deserialize } from '@ungap/structured-clone';

/**
 * Instruments a Durable Obj    private async handleTestingEndpoint(pathname: string, request: Request): Promise<Response> {
      switch (pathname) {
        case '/__testing/info':
          return Response.json({
            className: this.constructor.name,
            timestamp: Date.now(),
            isInstrumented: true,
            availableEndpoints: [
              '/__testing/info',
              '/__testing/ctx'
            ],
            // Add any other metadata that's not accessible via ctx proxy
            ctxProxyAvailable: true
          });
        
        case '/__testing/ctx':
          return this.handleCtxProxy(request);
        
        default:
          return new Response('Testing endpoint not found', { status: 404 });
      }
    }testing capabilities
 * @param DOClass - The original Durable Object class to instrument
 * @returns Instrumented Durable Object class with testing endpoints
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

    private async handleTestingEndpoint(pathname: string, request: Request): Promise<Response> {
      switch (pathname) {
        case '/__testing/info':
          return Response.json({
            className: this.constructor.name,
            timestamp: Date.now(),
            isInstrumented: true,
            availableEndpoints: [
              '/__testing/info',
              '/__testing/ctx'
            ],
            // Add any other metadata that's not accessible via ctx proxy
            ctxProxyAvailable: true
          });
        
        case '/__testing/ctx':
          return this.handleCtxProxy(request);
        
        default:
          return new Response('Testing endpoint not found', { status: 404 });
      }
    }

    private async handleCtxProxy(request: Request): Promise<Response> {
      try {
        const requestText = await request.text();
        const serializedBody = JSON.parse(requestText);
        const { type, path, args } = deserialize(serializedBody);
        
        let target = this.__testingCtx;
        let parent = this.__testingCtx;
        let result: any;
        
        // Navigate to the target object using the path, keeping track of parent for context
        for (let i = 0; i < path.length - 1; i++) {
          parent = target;
          target = target[path[i]];
          if (target === undefined || target === null) {
            throw new Error(`Path not found: ${path.slice(0, i + 1).join('.')}`);
          }
        }
        
        const finalProp = path[path.length - 1];
        
        if (type === 'get') {
          result = target[finalProp];
        } else if (type === 'call') {
          const method = target[finalProp];
          if (typeof method !== 'function') {
            throw new Error(`Target at path ${path.join('.')} is not a function`);
          }
          
          // Call with correct context - use parent as `this`
          result = method.apply(target, args || []);
          
          // Await promises on the DO side
          if (result && typeof result.then === 'function') {
            result = await result;
          }
        } else {
          throw new Error(`Unknown operation type: ${type}`);
        }

        const serializedResponse = serialize({
          success: true,
          result: result
        });
        
        return new Response(JSON.stringify(serializedResponse), {
          headers: { 'Content-Type': 'application/json' }
        });
        
      } catch (error) {
        const serializedError = serialize({
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
        
        return new Response(JSON.stringify(serializedError), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  }

  // Copy static properties from original class
  Object.setPrototypeOf(InstrumentedDO, DOClass);
  Object.defineProperty(InstrumentedDO, 'name', { value: (DOClass as any).name });

  return InstrumentedDO as T;
}