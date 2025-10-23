import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { runInDurableObject, env, SELF } from 'cloudflare:test';
import type { RpcBatchRequest, RpcBatchResponse } from '@lumenize/rpc';

// Use real structured-clone for sociable unit testing
import { stringify, parse } from '@ungap/structured-clone/json';

/**
 * Server-side RPC Factory Tests
 * 
 * These tests verify internal implementation details and validation limits
 * that are not covered by the matrix integration tests.
 * 
 * KEPT: These are unit-level tests for:
 * - Internal preprocessing logic (#preprocessResult)
 * - HTTP method validation (405 errors)
 * - Security limits (maxDepth, maxArgs)
 */
describe('lumenizeRpcDO server-side functionality', () => {

  // KEPT: Tests internal #preprocessResult implementation for arrays with functions
  it('should handle arrays with functions in results', async () => {
    // Tests that #preprocessResult handles arrays and converts functions to remote markers
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      const rpcBatchRequest: RpcBatchRequest = {
        batch: [{
          id: 'test-1',
          operations: [
            { type: 'get', key: 'getArrayWithFunctions' },
            { type: 'apply', args: [] }
          ]
        }]
      };

      const request = new Request(`https://example.com/__rpc/example-do/${id.toString()}/call`, {
        method: 'POST',
        body: stringify(rpcBatchRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await SELF.fetch(request);  // Demonstrates that you can use SELF.fetch inside of `runInDurableObject`
      expect(response.status).toBe(200);

      const responseText = await response.text();
      const data = parse(responseText) as RpcBatchResponse;
      expect(data.batch).toHaveLength(1);
      expect(data.batch[0].success).toBe(true);
      const result = data.batch[0].result;
      
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

  // KEPT: HTTP method validation - 405 for non-POST (WebSocket doesn't have this)
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

  // KEPT: Security validation - maxDepth limit (50 operations)
  it('should reject operation chains exceeding maxDepth', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      // Create a chain longer than the default maxDepth (50)
      const operations = Array(51).fill({ type: 'get', key: 'someProperty' });
      
      const rpcBatchRequest: RpcBatchRequest = {
        batch: [{
          id: 'test-1',
          operations
        }]
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: stringify(rpcBatchRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(500);

      const responseText = await response.text();
      const data = parse(responseText) as RpcBatchResponse;
      expect(data.batch).toHaveLength(1);
      expect(data.batch[0].success).toBe(false);
      expect(data.batch[0].error?.message).toContain('Operation chain too deep');
      expect(data.batch[0].error?.message).toContain('51 > 50');
    });
  });

  // KEPT: Security validation - maxArgs limit (100 arguments)
  it('should reject operations with too many arguments', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      // Create an apply operation with more than maxArgs (100)
      const tooManyArgs = Array(101).fill(0);
      
      const rpcBatchRequest: RpcBatchRequest = {
        batch: [{
          id: 'test-1',
          operations: [
            { type: 'get', key: 'add' },
            { type: 'apply', args: tooManyArgs }
          ]
        }]
      };

      const request = new Request('https://example.com/__rpc/call', {
        method: 'POST',
        body: stringify(rpcBatchRequest),
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(500);

      const responseText = await response.text();
      const data = parse(responseText) as RpcBatchResponse;
      expect(data.batch).toHaveLength(1);
      expect(data.batch[0].success).toBe(false);
      expect(data.batch[0].error?.message).toContain('Too many arguments');
      expect(data.batch[0].error?.message).toContain('101 > 100');
    });
  });
});
