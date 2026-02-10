import { lumenizeRpcDO } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/routing';
import { DurableObject } from 'cloudflare:workers';

// A simple data service that demonstrates operation chaining and nesting
class _DataService extends DurableObject {
  // Get a value by key
  getValue(key: string): string {
    return this.ctx.storage.kv.get(key) ?? '';
  }

  // Set a value by key and return this for chaining
  setValue(key: string, value: string): this {
    this.ctx.storage.kv.put(key, value);
    this.ctx.storage.kv.put('lastValue', value); // Store for chaining
    return this;
  }

  // Uppercase the last value
  uppercaseValue(): string {
    const value = this.ctx.storage.kv.get<string>('lastValue') ?? '';
    return value.toUpperCase();
  }

  // Get multiple values and combine them
  combineValues(val1: string, val2: string): string {
    return `${val1} + ${val2}`;
  }
}

// Wrap with RPC support
export const DataService = lumenizeRpcDO(_DataService);

// Export a default worker to route RPC requests
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    // Route RPC requests to the Durable Object
    const response = await routeDORequest(request, env, { prefix: '__rpc' });
    if (response) return response;
    
    // Fallback for non-RPC requests
    return new Response('Not Found', { status: 404 });
  },
};
