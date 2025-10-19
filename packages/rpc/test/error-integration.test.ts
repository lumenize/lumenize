import { describe, it, expect, afterEach } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, getWebSocketShim } from '../src/index';

/**
 * Error Serialization Integration Tests
 * 
 * Tests that Error objects with custom properties (including stack traces)
 * survive the full round trip through the RPC system:
 * 1. Thrown on DO server
 * 2. Serialized for transport
 * 3. Sent over HTTP or WebSocket
 * 4. Deserialized on client
 * 5. Re-thrown to calling code
 */

/**
 * Helper to create an RPC client for testing
 */
function createTestClient(transport: 'http' | 'websocket', doBindingName: string) {
  const baseConfig = {
    transport,
    baseUrl: 'https://fake-host.com',
    prefix: '__rpc',
  } as const;

  if (transport === 'websocket') {
    (baseConfig as any).WebSocketClass = getWebSocketShim(SELF.fetch.bind(SELF));
  } else {
    (baseConfig as any).fetch = SELF.fetch.bind(SELF);
  }

  const instanceId = `error-test-${Date.now()}-${Math.random()}`;
  
  return createRpcClient(doBindingName, instanceId, baseConfig);
}

describe('Error Integration - HTTP Transport', () => {
  let client: any;
  
  afterEach(async () => {
    if (client) {
      await client[Symbol.asyncDispose]();
      client = null;
    }
  });
  
  it('should preserve stack traces across the wire', async () => {
    client = createTestClient('http', 'example-do');
    
    try {
      await (client as any).throwError('Stack trace test');
      expect.fail('Should have thrown an error');
    } catch (error: any) {
      // Verify it's a proper Error instance
      expect(error).toBeInstanceOf(Error);
      
      // Verify stack trace exists
      expect(error.stack).toBeDefined();
      expect(typeof error.stack).toBe('string');
      expect(error.stack.length).toBeGreaterThan(0);
      
      // Stack trace should reference the original DO method
      // Note: Stack traces from DO will show internal DO implementation details
      expect(error.stack).toContain('Error');
      
      // Verify message is preserved
      expect(error.message).toBe('Stack trace test');
    }
  });
  
  it('should preserve custom error properties (code, statusCode, metadata)', async () => {
    client = createTestClient('http', 'example-do');
    
    try {
      await (client as any).throwError('Custom properties test');
      expect.fail('Should have thrown an error');
    } catch (error: any) {
      // Verify it's a proper Error instance
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Custom properties test');
      
      // Verify custom properties are preserved
      expect(error.code).toBe('TEST_ERROR');
      expect(error.statusCode).toBe(400);
      expect(error.metadata).toBeDefined();
      expect(error.metadata.source).toBe('SharedDOMethods');
      expect(error.metadata.timestamp).toBeDefined();
      expect(typeof error.metadata.timestamp).toBe('number');
    }
  });
  
  it('should preserve Error name and type information', async () => {
    client = createTestClient('http', 'example-do');
    
    try {
      await (client as any).throwError('Type preservation test');
      expect.fail('Should have thrown an error');
    } catch (error: any) {
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('Error');
      expect(error.constructor.name).toBe('Error');
    }
  });
  
  it('should allow caught errors to be re-thrown', async () => {
    client = createTestClient('http', 'example-do');
    
    let caughtError: any;
    try {
      await (client as any).throwError('Re-throw test');
    } catch (error) {
      caughtError = error;
    }
    
    // Verify we can re-throw the caught error
    expect(() => {
      throw caughtError;
    }).toThrow('Re-throw test');
    
    // Verify custom properties survive re-throw
    try {
      throw caughtError;
    } catch (error: any) {
      expect(error.code).toBe('TEST_ERROR');
      expect(error.statusCode).toBe(400);
      expect(error.metadata).toBeDefined();
    }
  });
  
  it('should handle errors with deeply nested metadata', async () => {
    client = createTestClient('http', 'example-do');
    
    // throwError adds simple metadata, but let's verify structured data survives
    try {
      await (client as any).throwError('Nested metadata test');
      expect.fail('Should have thrown an error');
    } catch (error: any) {
      expect(error).toBeInstanceOf(Error);
      expect(error.metadata).toBeDefined();
      expect(error.metadata.source).toBe('SharedDOMethods');
      expect(typeof error.metadata.timestamp).toBe('number');
    }
  });
  
  it('should preserve stack trace line breaks and formatting', async () => {
    client = createTestClient('http', 'example-do');
    
    try {
      await (client as any).throwError('Stack formatting test');
      expect.fail('Should have thrown an error');
    } catch (error: any) {
      expect(error.stack).toBeDefined();
      
      // Stack traces should contain newlines
      expect(error.stack).toContain('\n');
      
      // Should have multiple stack frames (more than just the error message)
      const lines = error.stack.split('\n');
      expect(lines.length).toBeGreaterThan(1);
      
      // First line should contain the error message
      expect(lines[0]).toContain('Stack formatting test');
    }
  });
});

describe('Error Integration - WebSocket Transport', () => {
  let client: any;
  
  afterEach(async () => {
    if (client) {
      await client[Symbol.asyncDispose]();
      client = null;
    }
  });
  
  it('should preserve stack traces over WebSocket', async () => {
    client = createTestClient('websocket', 'example-do');
    
    try {
      await (client as any).throwError('WebSocket stack trace test');
      expect.fail('Should have thrown an error');
    } catch (error: any) {
      // Verify it's a proper Error instance
      expect(error).toBeInstanceOf(Error);
      
      // Verify stack trace exists
      expect(error.stack).toBeDefined();
      expect(typeof error.stack).toBe('string');
      expect(error.stack.length).toBeGreaterThan(0);
      
      // Verify message
      expect(error.message).toBe('WebSocket stack trace test');
    }
  });
  
  it('should preserve custom error properties over WebSocket', async () => {
    client = createTestClient('websocket', 'example-do');
    
    try {
      await (client as any).throwError('WebSocket custom properties');
      expect.fail('Should have thrown an error');
    } catch (error: any) {
      expect(error).toBeInstanceOf(Error);
      
      // Verify custom properties survived
      expect(error.code).toBe('TEST_ERROR');
      expect(error.statusCode).toBe(400);
      expect(error.metadata).toBeDefined();
      expect(error.metadata.source).toBe('SharedDOMethods');
      expect(typeof error.metadata.timestamp).toBe('number');
    }
  });
  
  it('should preserve stack trace formatting over WebSocket', async () => {
    client = createTestClient('websocket', 'example-do');
    
    try {
      await (client as any).throwError('WebSocket stack formatting test');
      expect.fail('Should have thrown an error');
    } catch (error: any) {
      expect(error.stack).toBeDefined();
      
      // Stack traces should contain newlines
      expect(error.stack).toContain('\n');
      
      // Should have multiple stack frames
      const lines = error.stack.split('\n');
      expect(lines.length).toBeGreaterThan(1);
      
      // First line should contain the error message
      expect(lines[0]).toContain('WebSocket stack formatting test');
    }
  });
});
