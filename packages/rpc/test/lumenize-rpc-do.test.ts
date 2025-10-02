import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { runInDurableObject, env } from 'cloudflare:test';
import { lumenizeRpcDo } from '@lumenize/rpc';
import type { RpcRequest, RpcResponse } from '@lumenize/rpc';
import worker from './test-worker-and-dos';

// Use real structured-clone for sociable unit testing
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { serialize, deserialize } = require('@ungap/structured-clone');

describe('lumenizeRpcDo server-side functionality', () => {

  it('should throw error for non-function input', () => {
    // @ts-expect-error - Testing runtime validation for null (TypeScript correctly flags this at compile time)
    expect(() => lumenizeRpcDo(null)).toThrow('lumenizeRpcDo() expects a Durable Object class (constructor function), got object');
    // @ts-expect-error - Testing runtime validation for undefined (TypeScript correctly flags this at compile time)
    expect(() => lumenizeRpcDo(undefined)).toThrow('lumenizeRpcDo() expects a Durable Object class (constructor function), got undefined');
    // @ts-expect-error - Testing runtime validation for plain object (TypeScript correctly flags this at compile time)
    expect(() => lumenizeRpcDo({})).toThrow('lumenizeRpcDo() expects a Durable Object class (constructor function), got object');
    // @ts-expect-error - Testing runtime validation for string (TypeScript correctly flags this at compile time)
    expect(() => lumenizeRpcDo('string')).toThrow('lumenizeRpcDo() expects a Durable Object class (constructor function), got string');
    // @ts-expect-error - Testing runtime validation for number (TypeScript correctly flags this at compile time)
    expect(() => lumenizeRpcDo(42)).toThrow('lumenizeRpcDo() expects a Durable Object class (constructor function), got number');
  });

  it('should execute simple operation chains', async () => {
    // Get the Durable Object stub from the environment
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'increment' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result).toBe(1);
    });
  });

  it('should execute operation chains with arguments', async () => {
    // Get the Durable Object stub from the environment
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'add' },
          { type: 'apply', args: [5, 3] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result).toBe(8);
    });
  });

  it('should handle errors gracefully', async () => {
    // Get the Durable Object stub from the environment
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'nonexistentMethod' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(500);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    });
  });

  it('should delegate non-RPC requests to original fetch', async () => {
    // Get the Durable Object stub from the environment
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const request = new Request('https://example.com/some-other-path');
      const response = await instance.fetch(request);

      const text = await response.text();
      expect(text).toBe('original');
    });
  });

  it('should preprocess function results with remote function markers', async () => {
    // Get the Durable Object stub from the environment
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'getObject' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result.value).toBe(42);
      expect(result.nested.getValue.__isRemoteFunction).toBe(true);
      expect(result.nested.getValue.__functionName).toBe('getValue');
    });
  });

  it('should call nested functions and execute them remotely', async () => {
    // Get the Durable Object stub from the environment
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      // First get the object, then call the nested getValue function
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'getObject' },
          { type: 'apply', args: [] },
          { type: 'get', key: 'nested' },
          { type: 'get', key: 'getValue' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result).toBe(42); // The getValue function should return this.value which is 42
    });
  });

  it('should execute throwError method', async () => {
    // Get the Durable Object stub from the environment
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'throwError' },
          { type: 'apply', args: ['Test error message'] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(500);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
      expect(data.error.message).toBe('Test error message');
      expect(data.error.code).toBe('TEST_ERROR');
      expect(data.error.statusCode).toBe(400);
      expect(data.error.metadata).toBeDefined();
    });
  });

  it('should handle throwing non-Error values (strings)', async () => {
    // Get the Durable Object stub from the environment
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'throwString' },
          { type: 'apply', args: ['Just a string error'] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(500);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
      // When you throw a string, it should be passed through as-is by serializeError
    });
  });

  it('should execute getArray method', async () => {
    // Get the Durable Object stub from the environment
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'getArray' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result).toEqual([1, 2, 3, 4, 5]);
    });
  });

  it('should access complex data properties', async () => {
    // Get the Durable Object stub from the environment
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'complexData' },
          { type: 'get', key: 'data' },
          { type: 'get', key: 'id' }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result).toBe('complex-data');
    });
  });

  it('should handle circular references in complex data', async () => {
    // Get the Durable Object stub from the environment
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      // Test accessing the circular reference: complexData.data should point back to complexData
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'complexData' },
          { type: 'get', key: 'data' },
          { type: 'get', key: 'data' },
          { type: 'get', key: 'id' }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result).toBe('complex-data');
    });
  });

  it('should call methods in complex data', async () => {
    // Get the Durable Object stub from the environment
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      // Test calling the getName method inside complexData.methods
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'complexData' },
          { type: 'get', key: 'methods' },
          { type: 'get', key: 'getName' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result).toBe('ExampleDO');
    });
  });

  it('should handle original fetch /increment path', async () => {
    // Get the Durable Object stub from the environment
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const request = new Request('https://example.com/increment');
      const response = await instance.fetch(request);

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(parseInt(text)).toBeGreaterThan(0); // Should be a positive number
    });
  });

  it('should handle arrays with functions in results', async () => {
    // Tests that #preprocessResult handles arrays and converts functions to remote markers
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'getArrayWithFunctions' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      
      // Check array structure
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(5);
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(2);
      
      // Check function was converted to remote marker
      expect(result[2].__isRemoteFunction).toBe(true);
      expect(result[2].__operationChain).toBeDefined();
      
      // Check object with function was processed
      expect(result[3].value).toBe(42);
      expect(result[3].getValue.__isRemoteFunction).toBe(true);
      
      expect(result[4]).toBe(5);
    });
  });

  it('should handle errors during preprocessing', async () => {
    // Tests error handling in the fetch method when preprocessResult throws
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'getProblematicObject' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      
      // Should return error response when preprocessing fails
      expect(response.status).toBe(500);
      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    });
  });

  it('should handle class instances with prototype methods', async () => {
    // Tests that #preprocessResult walks the prototype chain to find methods
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'getClassInstance' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      
      // Check instance properties are preserved
      expect(result.value).toBe(42);
      expect(result.name).toBe('TestModel');
      
      // Check that prototype methods were converted to remote markers
      expect(result.getValue.__isRemoteFunction).toBe(true);
      expect(result.getValue.__functionName).toBe('getValue');
      expect(result.getName.__isRemoteFunction).toBe(true);
      expect(result.getName.__functionName).toBe('getName');
      expect(result.compute.__isRemoteFunction).toBe(true);
      expect(result.compute.__functionName).toBe('compute');
    });
  });

  it('should handle non-RPC requests at worker level', async () => {
    // Test that non-RPC requests fall through to custom worker handlers

    // Test the /ping endpoint which is handled by handleWorkerPing
    const request = new Request('https://example.com/ping');
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe('pong from Worker');
  });

  it('should return 404 for unhandled worker routes', async () => {
    // Test that unknown routes return 404

    const request = new Request('https://example.com/unknown-route');
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toBe('Not Found');
  });

  it('should return 405 for non-POST requests to /call endpoint', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      const request = new Request('https://example.com/__rpc/call', {
        method: 'GET'
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(405);
      const text = await response.text();
      expect(text).toBe('Method not allowed');
    });
  });

  it('should reject non-array operations payload', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      const rpcRequest = {
        scEncodedOperations: serialize('not an array') // Invalid: string instead of array
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(500);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(false);
      expect(data.error?.message).toContain('Invalid RPC request: operations must be an array');
    });
  });

  it('should reject operation chains exceeding maxDepth', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      // Create a chain longer than the default maxDepth (50)
      const operations = Array(51).fill({ type: 'get', key: 'someProperty' });
      
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize(operations)
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(500);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(false);
      expect(data.error?.message).toContain('Operation chain too deep');
      expect(data.error?.message).toContain('51 > 50');
    });
  });

  it('should reject operations with too many arguments', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      // Create an apply operation with more than maxArgs (100)
      const tooManyArgs = Array(101).fill(0);
      
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'add' },
          { type: 'apply', args: tooManyArgs }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(500);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(false);
      expect(data.error?.message).toContain('Too many arguments');
      expect(data.error?.message).toContain('101 > 100');
    });
  });

  it('should handle Date objects in results', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'getDate' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result).toBeInstanceOf(Date);
    });
  });

  it('should handle RegExp objects in results', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'getRegExp' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result).toBeInstanceOf(RegExp);
      expect(result.source).toBe('[0-9]+');
    });
  });

  it('should handle Map objects in results', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'getMap' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result).toBeInstanceOf(Map);
      expect(result.get('key')).toBe('value');
    });
  });

  it('should handle Set objects in results', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'getSet' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result).toBeInstanceOf(Set);
      expect(result.has(1)).toBe(true);
      expect(result.has(2)).toBe(true);
    });
  });

  it('should handle ArrayBuffer in results', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'getArrayBuffer' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result).toBeInstanceOf(ArrayBuffer);
      expect(result.byteLength).toBe(8);
    });
  });

  it('should handle TypedArray (Uint8Array) in results', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'getTypedArray' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(4);
      expect(result[0]).toBe(1);
      expect(result[3]).toBe(4);
    });
  });

  it('should handle Error objects in results', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      const rpcRequest: RpcRequest = {
        scEncodedOperations: serialize([
          { type: 'get', key: 'getError' },
          { type: 'apply', args: [] }
        ])
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: JSON.stringify(rpcRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const data = await response.json() as RpcResponse;
      expect(data.success).toBe(true);
      const result = deserialize(data.scEncodedResult);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('Test error');
    });
  });
});