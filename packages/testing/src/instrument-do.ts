/**
 * Instruments a Durable Object class to add testing capabilities
 * @param DOClass - The original Durable Object class to instrument
 * @returns Instrumented Durable Object class with testing endpoints
 */
export function instrumentDO<T>(DOClass: T): T {
  if (typeof DOClass !== 'function') {
    return DOClass;
  }

  // Create instrumented class that extends the original
  class InstrumentedDO extends (DOClass as any) {
    constructor(ctx: any, env: any) {
      super(ctx, env);
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
        case '/__testing/ping':
          return Response.json({
            status: 'ok',
            timestamp: Date.now(),
            className: this.constructor.name,
            url: request.url
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