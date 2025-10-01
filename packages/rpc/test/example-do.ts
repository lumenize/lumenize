import { lumenizeRpcDo } from '../src/lumenize-rpc-do';
import { routeDORequest } from '@lumenize/utils';
import { DurableObject } from 'cloudflare:workers';
// @ts-expect-error For some reason this import is not always recognized
import { Env } from 'cloudflare:test';

/**
 * Example Durable Object for testing RPC functionality
 */
class _ExampleDO extends DurableObject<Env> {
  // public readonly ctx: DurableObjectState;
  // public readonly env: Env;
  public readonly complexData: any;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // this.ctx = ctx;
    // this.env = env;
    
    // Create a complex object with circular reference
    this.complexData = {
      id: 'complex-data',
      config: {
        name: 'ExampleDO'
      },
      numbers: [1, 2, 3],
      methods: {
        getName: () => 'ExampleDO'
      },
      collections: {
        tags: new Set(['test', 'rpc']),
        metadata: new Map<string, any>([
          ['created', Date.now()],
          ['features', ['increment', 'add']]
        ])
      }
    };
    
    // Create circular references
    this.complexData.data = this.complexData; // Points back to root
    this.complexData.parent = this; // Points back to DO instance
  }

  // Simple method
  async increment(): Promise<number> {
    const count = await this.ctx.storage.get<number>('count') || 0;
    const newCount = count + 1;
    this.ctx.storage.kv.put('count', newCount);
    return newCount;
  }

  // Method with arguments
  add(a: number, b: number): number {
    return a + b;
  }

  // Method that throws an error (for testing error handling)
  throwError(message: string): void {
    const error = new Error(message) as any;
    error.code = 'TEST_ERROR';
    error.statusCode = 400;
    error.metadata = { timestamp: Date.now(), source: 'ExampleDO' };
    throw error;
  }

  // Method that throws a string (not an Error object)
  throwString(message: string): void {
    throw message; // This throws a string, not an Error instance
  }

  // Method that returns object with remote functions (for testing preprocessing)
  getObject() {
    const nested = {
      value: 42,
      getValue(): number {
        return this.value;
      }
    };
    return {
      value: 42,
      nested
    };
  }

  // Method that returns array
  getArray(): number[] {
    return [1, 2, 3, 4, 5];
  }

  // Method that returns array with functions (for testing array preprocessing)
  getArrayWithFunctions(): any[] {
    return [
      1,
      2,
      () => 'hello',
      { value: 42, getValue: function() { return this.value; } },
      5
    ];
  }

  // Method that returns an object that will cause preprocessing to throw
  // This uses a getter that throws when accessed
  getProblematicObject(): any {
    const obj: any = { value: 42 };
    Object.defineProperty(obj, 'badGetter', {
      get() {
        throw new Error('Getter throws error');
      },
      enumerable: true
    });
    return obj;
  }

  // Original fetch method (would handle user's business logic)
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/increment') {
      const count = await this.increment();
      return new Response(count.toString());
    }
    
    return new Response('original');
  }
}

// Export the lumenized version
const ExampleDO = lumenizeRpcDo(_ExampleDO);
export { ExampleDO };

/**
 * Worker fetch handler that uses routeDORequest to handle RPC requests
 * and falls back to existing Worker handlers/responses for non-RPC requests
 */
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    console.debug('%o', {
      type: 'debug',
      where: 'example-do.ts Worker fetch handler',
      request,
      env
    });
    // Try to route RPC requests first using routeDORequest
    const doResponse = await routeDORequest(request, env, { prefix: '/__rpc' });
    if (doResponse) return doResponse;

    // Try something else
    const workerPingResponse = this.handleWorkerPing(request);
    if (workerPingResponse) return workerPingResponse;

    // Fall back to existing DO logic for non-RPC requests
    // This handles direct requests to the DO that don't match the routing pattern
    return new Response('Not Found', { status: 404 });
  },

  handleWorkerPing: (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/ping')) {
      return new Response('pong from Worker');
    } else {
      return undefined;
    }
  }
}
