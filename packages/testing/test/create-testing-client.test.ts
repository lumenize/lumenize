import { describe, it, expect } from 'vitest';
import { createTestingClient, type RpcAccessible, CookieJar } from '../src/index';
import { TestDO } from './test-worker-and-dos';

type TestDOType = RpcAccessible<InstanceType<typeof TestDO>>;

describe('createTestingClient', () => {
  
  it('creates a client with minimal config (http transport)', async () => {
    await using client = createTestingClient<TestDOType>('TEST_DO', 'http-test');
    
    // Reset to ensure clean state
    await client.reset();
    
    // Verify we can call DO methods via RPC
    const count1 = await client.increment();
    expect(count1).toBe(1);
    
    const count2 = await client.increment();
    expect(count2).toBe(2);
    
    const finalCount = await client.getCount();
    expect(finalCount).toBe(2);
  });
  
  it('supports websocket transport', async () => {
    await using client = createTestingClient<TestDOType>('TEST_DO', 'ws-test', {
      transport: 'websocket'
    });
    
    await client.reset();
    
    const count1 = await client.increment();
    expect(count1).toBe(1);
    
    const count2 = await client.increment();
    expect(count2).toBe(2);
  });
  
  it('supports cookie jar integration', async () => {
    const cookieJar = new CookieJar();
    cookieJar.setDefaultHostname('example.com');
    
    await using client = createTestingClient<TestDOType>('TEST_DO', 'cookie-test', {
      cookieJar
    });
    
    await client.reset();
    
    // Client should work normally with cookie jar
    const count = await client.increment();
    expect(count).toBe(1);
  });
  
  it('provides access to ctx and storage', async () => {
    await using client = createTestingClient<TestDOType>('TEST_DO', 'ctx-test');
    
    // Direct storage access via ctx
    await client.ctx.storage.put('directKey', 'directValue');
    const value = await client.ctx.storage.get('directKey');
    expect(value).toBe('directValue');
  });
  
  it('supports custom timeout', async () => {
    await using client = createTestingClient<TestDOType>('TEST_DO', 'timeout-test', {
      timeout: 5000
    });
    
    await client.reset();
    const count = await client.increment();
    expect(count).toBe(1);
  });
  
  it('auto-disposes with await using', async () => {
    // This test verifies that the client is properly disposed
    // The await using syntax should automatically call Symbol.asyncDispose
    {
      await using client = createTestingClient<TestDOType>('TEST_DO', 'dispose-test');
      await client.reset();
      const count = await client.increment();
      expect(count).toBe(1);
    }
    // Client should be disposed here
    
    // Create a new client with same instance name
    await using client2 = createTestingClient<TestDOType>('TEST_DO', 'dispose-test');
    const count2 = await client2.getCount();
    expect(count2).toBe(1); // Count persists because it's in DO storage
  });
});
