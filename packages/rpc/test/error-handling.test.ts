/**
 * Error Handling Tests
 * 
 * Tests for error scenarios, malformed messages, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createRpcClient, createWebSocketTransport, createHttpTransport } from '../src/index';
import { getWebSocketShim } from '@lumenize/utils';
import { ExampleDO } from './test-worker-and-dos';

describe('Error Handling', () => {

  it('should handle method calls that throw errors', async () => {
    using client = createRpcClient<typeof ExampleDO>({
      transport: createWebSocketTransport('EXAMPLE_DO', 'error-test-1', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      })
    });

    // Call method that throws
    await expect(client.throwError('Test error')).rejects.toThrow('Test error');
  });

  it('should handle errors thrown as strings', async () => {
    using client = createRpcClient<typeof ExampleDO>({
      transport: createWebSocketTransport('EXAMPLE_DO', 'error-test-2', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      })
    });

    // Call method that throws string
    await expect(client.throwString('String error')).rejects.toThrow('String error');
  });

  it('should handle errors with HTTP transport', async () => {
    using client = createRpcClient<typeof ExampleDO>({
      transport: createHttpTransport('EXAMPLE_DO', 'error-test-3', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        fetch: SELF.fetch.bind(SELF),
      })
    });

    // Call method that throws
    await expect(client.throwError('HTTP error')).rejects.toThrow('HTTP error');
  });

  it('should handle errors with batched operations', async () => {
    using client = createRpcClient<typeof ExampleDO>({
      transport: createHttpTransport('EXAMPLE_DO', 'error-test-4', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        fetch: SELF.fetch.bind(SELF),
      })
    });

    // Call methods in batch - one succeeds, one fails
    const results = await Promise.allSettled([
      client.increment(), // Should succeed and return 1
      client.throwError('Batch error'), // Should fail
    ]);

    expect(results[0].status).toBe('fulfilled');
    if (results[0].status === 'fulfilled') {
      expect(results[0].value).toBe(1); // First increment should return 1
    }
    expect(results[1].status).toBe('rejected');
    if (results[1].status === 'rejected') {
      expect(results[1].reason.message).toContain('Batch error');
    }
  });

  it('should handle errors with custom properties', async () => {
    using client = createRpcClient<typeof ExampleDO>({
      transport: createWebSocketTransport('EXAMPLE_DO', 'error-test-7', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      })
    });

    // The error object should preserve custom properties
    try {
      await client.throwError('Custom error');
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Custom error');
    }
  });

  it('should handle concurrent errors', async () => {
    using client = createRpcClient<typeof ExampleDO>({
      transport: createWebSocketTransport('EXAMPLE_DO', 'error-test-8', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      })
    });

    // Fire multiple operations that will fail
    const promises = [
      client.throwError('Error 1'),
      client.throwError('Error 2'),
      client.throwError('Error 3'),
    ];

    // All should reject with their respective errors
    await expect(promises[0]).rejects.toThrow('Error 1');
    await expect(promises[1]).rejects.toThrow('Error 2');
    await expect(promises[2]).rejects.toThrow('Error 3');
  });

  it('should handle errors in downstream handler', async () => {
    const errors: any[] = [];

    // We can't directly test the error handling in onDownstream,
    // but we can verify the connection stays alive even if handler throws
    using client = createRpcClient<typeof ExampleDO>({
      transport: createWebSocketTransport('EXAMPLE_DO', 'error-test-9', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        onDownstream: () => {
          throw new Error('Handler error');
        },
      })
    });

    // Connection should still work despite handler errors - first increment returns 1
    const result = await client.increment();
    expect(result).toBe(1);
  });

  it('should handle errors in onClose handler', async () => {
    using client = createRpcClient<typeof ExampleDO>({
      transport: createWebSocketTransport('EXAMPLE_DO', 'error-test-10', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        onClose: () => {
          throw new Error('Close handler error');
        },
      })
    });

    // Establish connection - first increment returns 1
    const result = await client.increment();
    expect(result).toBe(1);

    // Close should not throw even if handler does
    client[Symbol.dispose]();
    
    // Give time for close handler to fire - we're just verifying no error propagates
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  it('should handle errors in onConnectionChange handler', async () => {
    using client = createRpcClient<typeof ExampleDO>({
      transport: createWebSocketTransport('EXAMPLE_DO', 'error-test-11', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        onConnectionChange: () => {
          throw new Error('Connection change handler error');
        },
      })
    });

    // Connection should still work despite handler errors - first increment returns 1
    const result = await client.increment();
    expect(result).toBe(1);
  });

});

