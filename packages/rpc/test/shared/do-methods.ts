/**
 * Shared Durable Object method implementations
 * 
 * These methods can be mixed into both lumenizeRpcDO-wrapped DOs and 
 * manual routing DOs to ensure consistent be  // Method for testing counter access (used by ManualRoutingDO)
  async getCounter(this: { ctx: DOContext }): Promise<number> {
    return (await this.ctx.storage.get('count') as number | undefined) || 0;
  }or across test configurations.
 */

// Type for DO context - matches DurableObject's protected ctx property
type DOContext = any;

// Helper type for objects with ctx
interface WithContext {
  readonly ctx: DOContext;
}

/**
 * Example class with methods on prototype (for testing prototype chain walking)
 */
export class DataModel {
  public value: number;
  public name: string;

  constructor(value: number, name: string) {
    this.value = value;
    this.name = name;
  }

  getValue(): number {
    return this.value;
  }

  getName(): string {
    return this.name;
  }

  compute(): number {
    return this.value * 2;
  }
}

/**
 * Shared DO methods that can be mixed into any DO class
 * Use this by spreading into your DO class or copying methods
 */
export const sharedDOMethods = {
  // Simple method
  async increment(this: WithContext): Promise<number> {
    const count = (await this.ctx.storage.get('count') as number | undefined) || 0;
    const newCount = count + 1;
    this.ctx.storage.kv.put('count', newCount);
    return newCount;
  },

  // Method with arguments
  add(a: number, b: number): number {
    return a + b;
  },

  // Method that throws an error (for testing error handling)
  throwError(message: string): void {
    const error = new Error(message) as any;
    error.code = 'TEST_ERROR';
    error.statusCode = 400;
    error.metadata = { timestamp: Date.now(), source: 'SharedDOMethods' };
    throw error;
  },

  // Method that throws a string (not an Error object)
  throwString(message: string): void {
    throw message; // This throws a string, not an Error instance
  },

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
  },

  // Method that returns array
  getArray(): number[] {
    return [1, 2, 3, 4, 5];
  },

  // Method that returns array with functions (for testing array preprocessing)
  getArrayWithFunctions(): any[] {
    return [
      1,
      2,
      () => 'hello',
      { value: 42, getValue: function() { return this.value; } },
      5
    ];
  },

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
  },

  // Method that returns a class instance (for testing prototype chain walking)
  getClassInstance(): DataModel {
    return new DataModel(42, 'TestModel');
  },

  // Method that returns an object with deeply nested properties for testing chaining
  getDeeplyNested() {
    return {
      level1: {
        level2: {
          level3: {
            value: 'deep',
            getValue: () => 'deeply nested value'
          }
        }
      }
    };
  },

  // Method that returns an object with a non-function property to test error handling
  getObjectWithNonFunction() {
    return {
      notAFunction: 42,
      data: { value: 'test' }
    };
  },

  // Method with built-in delay for testing pending operations
  async slowIncrement(this: { increment: () => Promise<number> }, delayMs: number = 100): Promise<number> {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return this.increment();
  },

  // Methods for testing built-in type handling
  getDate(): Date {
    return new Date('2025-01-01T00:00:00Z');
  },

  getRegExp(): RegExp {
    return /[0-9]+/g;
  },

  getBigInt(): bigint {
    return 1234567890123456789012345678901234567890n;
  },

  getMap(): Map<string, string> {
    return new Map([['key', 'value']]);
  },

  getSet(): Set<number> {
    return new Set([1, 2, 3]);
  },

  getArrayBuffer(): ArrayBuffer {
    return new ArrayBuffer(8);
  },

  getTypedArray(): Uint8Array {
    return new Uint8Array([1, 2, 3, 4]);
  },

  getError(): Error {
    return new Error('Test error');
  },

  // Method for testing counter access (used by ManualRoutingDO)
  async getCounter(this: WithContext): Promise<number> {
    return (await this.ctx.storage.get('count') as number | undefined) || 0;
  },

  // Method that echoes back whatever is passed to it (for testing structured-clone and circular refs)
  echo(value: any): any {
    return value;
  },

  // Methods for testing Web API object serialization
  getRequest(): Request {
    return new Request('https://example.com/api/test', {
      method: 'POST',
      headers: new Headers({
        'Content-Type': 'application/json',
        'X-Custom-Header': 'test-value',
      }),
      body: JSON.stringify({ test: 'data' }),
    });
  },

  getResponse(): Response {
    return new Response(JSON.stringify({ success: true, data: 'test' }), {
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'Content-Type': 'application/json',
        'X-Response-Id': '12345',
      }),
    });
  },

  getHeaders(): Headers {
    const headers = new Headers();
    headers.set('Authorization', 'Bearer token123');
    headers.set('Accept', 'application/json');
    headers.set('X-API-Key', 'secret-key');
    return headers;
  },

  getURL(): URL {
    return new URL('https://example.com/path?param1=value1&param2=value2#hash');
  },

  // Method that returns an object containing multiple Web API types
  getWebApiMix(): any {
    return {
      request: new Request('https://example.com/test'),
      response: new Response('test body'),
      headers: new Headers({ 'X-Test': 'value' }),
      url: new URL('https://example.com'),
      nested: {
        deepRequest: new Request('https://example.com/deep'),
      },
    };
  }
};

/**
 * Helper to create complex data structure for testing
 * Used in DO constructor
 * @param doInstance - The DO instance to reference in circular refs
 * @param name - The name to use in getName() method (defaults to 'TestDO')
 */
export function createComplexData(doInstance: any, name: string = 'TestDO') {
  const complexData = {
    id: 'complex-data',
    config: {
      name
    },
    numbers: [1, 2, 3],
    methods: {
      getName: () => name
    },
    collections: {
      tags: new Set(['test', 'rpc']),
      metadata: new Map<string, any>([
        ['created', Date.now()],
        ['features', ['increment', 'add']]
      ])
    },
    data: null as any,  // Will point back to root
    parent: null as any  // Will point back to DO instance
  };

  // Create circular references
  complexData.data = complexData; // Points back to root
  complexData.parent = doInstance; // Points back to DO instance

  return complexData;
}
