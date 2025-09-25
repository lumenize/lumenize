import { lumenizeRpcDo } from '../src/lumenize-rpc-do.js';

/**
 * Example Durable Object for testing RPC functionality
 */
class ExampleDO {
  public readonly ctx: DurableObjectState;
  public readonly env: Env;
  public readonly complexData: any;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    
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
export default lumenizeRpcDo(ExampleDO);