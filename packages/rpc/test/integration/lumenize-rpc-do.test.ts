import { describe, it, expect } from 'vitest';
import { lumenizeRpcDo } from '@lumenize/rpc';
import type { RPCRequest, RPCResponse } from '@lumenize/rpc';
import { ExampleDO } from '../example-do';

// Use real structured-clone for sociable unit testing
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { serialize, deserialize } = require('@ungap/structured-clone');

describe('lumenizeRpcDo server-side functionality', () => {
  
  // Mock constructor arguments for ExampleDO
  let mockData: Record<string, any>;
  let mockCtx: any;
  let mockEnv: any;

  beforeEach(() => {
    // Reset mock data for each test
    mockData = {};
    mockCtx = {
      storage: {
        get: async (key: string) => mockData[key],
        kv: {
          put: (key: string, value: any) => { mockData[key] = value; }
        }
      }
    };
    mockEnv = {};
  });

  it('should create lumenized DO class', () => {
    const LumenizedDO = lumenizeRpcDo(ExampleDO);
    expect(LumenizedDO).toBeDefined();
    expect(LumenizedDO.name).toBe('_ExampleDO');
  });

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

  it.only('should execute simple operation chains', async () => {
    const LumenizedDO = lumenizeRpcDo(ExampleDO);
    const instance = new LumenizedDO(mockCtx, mockEnv);
    
    const rpcRequest: RPCRequest = {
      operations: serialize([
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
    
    const data = await response.json() as RPCResponse;
    expect(data.success).toBe(true);
    const result = deserialize(data.result);
    expect(result).toBe(1);
  });

  it('should execute operation chains with arguments', async () => {
    const LumenizedDO = lumenizeRpcDo(ExampleDO);
    const instance = new LumenizedDO(mockCtx, mockEnv);
    
    const rpcRequest: RPCRequest = {
      operations: serialize([
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
    
    const data = await response.json() as RPCResponse;
    expect(data.success).toBe(true);
    const result = deserialize(data.result);
    expect(result).toBe(8);
  });

  it('should handle errors gracefully', async () => {
    const LumenizedDO = lumenizeRpcDo(ExampleDO);
    const instance = new LumenizedDO(mockCtx, mockEnv);
    
    const rpcRequest: RPCRequest = {
      operations: serialize([
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
    
    const data = await response.json() as RPCResponse;
    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
  });

  it('should delegate non-RPC requests to original fetch', async () => {
    const LumenizedDO = lumenizeRpcDo(ExampleDO);
    const instance = new LumenizedDO(mockCtx, mockEnv);
    
    const request = new Request('https://example.com/some-other-path');
    const response = await instance.fetch(request);
    
    const text = await response.text();
    expect(text).toBe('original');
  });

  it('should preprocess function results with remote function markers', async () => {
    const LumenizedDO = lumenizeRpcDo(ExampleDO);
    const instance = new LumenizedDO(mockCtx, mockEnv);
    
    const rpcRequest: RPCRequest = {
      operations: serialize([
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
    
    const data = await response.json() as RPCResponse;
    expect(data.success).toBe(true);
    const result = deserialize(data.result);
    expect(result.value).toBe(42);
    expect(result.nested.getValue.__isRemoteFunction).toBe(true);
    expect(result.nested.getValue.__functionName).toBe('getValue');
  });

  it('should call nested functions and execute them remotely', async () => {
    const LumenizedDO = lumenizeRpcDo(ExampleDO);
    const instance = new LumenizedDO(mockCtx, mockEnv);
    
    // First get the object, then call the nested getValue function
    const rpcRequest: RPCRequest = {
      operations: serialize([
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
    
    const data = await response.json() as RPCResponse;
    expect(data.success).toBe(true);
    const result = deserialize(data.result);
    expect(result).toBe(42); // The getValue function should return this.value which is 42
  });

  it('should execute throwError method', async () => {
    const LumenizedDO = lumenizeRpcDo(ExampleDO);
    const instance = new LumenizedDO(mockCtx, mockEnv);
    
    const rpcRequest: RPCRequest = {
      operations: serialize([
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
    
    const data = await response.json() as RPCResponse;
    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
    expect(data.error.message).toBe('Test error message');
    expect(data.error.code).toBe('TEST_ERROR');
    expect(data.error.statusCode).toBe(400);
    expect(data.error.metadata).toBeDefined();
  });

  it('should handle throwing non-Error values (strings)', async () => {
    const LumenizedDO = lumenizeRpcDo(ExampleDO);
    const instance = new LumenizedDO(mockCtx, mockEnv);
    
    const rpcRequest: RPCRequest = {
      operations: serialize([
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
    
    const data = await response.json() as RPCResponse;
    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
    // When you throw a string, it should be passed through as-is by serializeError
    console.log('Thrown string error:', data.error);
  });

  it('should execute getArray method', async () => {
    const LumenizedDO = lumenizeRpcDo(ExampleDO);
    const instance = new LumenizedDO(mockCtx, mockEnv);
    
    const rpcRequest: RPCRequest = {
      operations: serialize([
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
    
    const data = await response.json() as RPCResponse;
    expect(data.success).toBe(true);
    const result = deserialize(data.result);
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it('should access complex data properties', async () => {
    const LumenizedDO = lumenizeRpcDo(ExampleDO);
    const instance = new LumenizedDO(mockCtx, mockEnv);
    
    const rpcRequest: RPCRequest = {
      operations: serialize([
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
    
    const data = await response.json() as RPCResponse;
    expect(data.success).toBe(true);
    const result = deserialize(data.result);
    expect(result).toBe('complex-data');
  });

  it('should handle circular references in complex data', async () => {
    const LumenizedDO = lumenizeRpcDo(ExampleDO);
    const instance = new LumenizedDO(mockCtx, mockEnv);
    
    // Test accessing the circular reference: complexData.data should point back to complexData
    const rpcRequest: RPCRequest = {
      operations: serialize([
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
    
    const data = await response.json() as RPCResponse;
    expect(data.success).toBe(true);
    const result = deserialize(data.result);
    expect(result).toBe('complex-data');
  });

  it('should call methods in complex data', async () => {
    const LumenizedDO = lumenizeRpcDo(ExampleDO);
    const instance = new LumenizedDO(mockCtx, mockEnv);
    
    // Test calling the getName method inside complexData.methods
    const rpcRequest: RPCRequest = {
      operations: serialize([
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
    
    const data = await response.json() as RPCResponse;
    expect(data.success).toBe(true);
    const result = deserialize(data.result);
    expect(result).toBe('ExampleDO');
  });

  it('should handle original fetch /increment path', async () => {
    const LumenizedDO = lumenizeRpcDo(ExampleDO);
    const instance = new LumenizedDO(mockCtx, mockEnv);
    
    const request = new Request('https://example.com/increment');
    const response = await instance.fetch(request);
    
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(parseInt(text)).toBeGreaterThan(0); // Should be a positive number
  });
});