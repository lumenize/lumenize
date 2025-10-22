import { describe, it, expect } from 'vitest';
import { createTestingClient, type RpcAccessible, Browser } from '../src/index';
import { TestDO } from './test-do';

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
  
  it('works with basic RPC calls', async () => {
    await using client = createTestingClient<TestDOType>('TEST_DO', 'rpc-test');
    
    await client.reset();
    
    const count1 = await client.increment();
    expect(count1).toBe(1);
    
    const count2 = await client.increment();
    expect(count2).toBe(2);
  });
  
  it('works with Browser for cookie-aware requests', async () => {
    // Browser now has convenient properties - no need to pass fetch!
    const browser = new Browser();
    
    await using client = createTestingClient<TestDOType>('TEST_DO', 'browser-test');
    
    await client.reset();
    
    // Use browser.fetch directly
    // In a real test, you'd use this to make cookie-aware requests
    const count = await client.increment();
    expect(count).toBe(1);
    
    // Can also use browser.WebSocket
    // const ws = new browser.WebSocket('wss://...');
  });
  
  it('provides access to ctx and storage', async () => {
    await using client = createTestingClient<TestDOType>('TEST_DO', 'ctx-test');
    
    // Direct storage access via ctx
    await client.ctx.storage.put('directKey', 'directValue');
    const value = await client.ctx.storage.get('directKey');
    expect(value).toBe('directValue');
  });
  
  it('creates multiple independent clients', async () => {
    await using client1 = createTestingClient<TestDOType>('TEST_DO', 'multi-test-1');
    await using client2 = createTestingClient<TestDOType>('TEST_DO', 'multi-test-2');
    
    await client1.reset();
    await client2.reset();
    
    await client1.increment();
    await client1.increment();
    
    await client2.increment();
    
    const count1 = await client1.getCount();
    const count2 = await client2.getCount();
    
    expect(count1).toBe(2);
    expect(count2).toBe(1);
  });
  
  it('auto-disposes with using/await using', async () => {
    // This test verifies that the client is properly disposed
    // Both 'using' and 'await using' work with synchronous Symbol.dispose
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
