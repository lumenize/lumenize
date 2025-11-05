import { describe, it, expect } from 'vitest';
import { createTestingClient, type RpcAccessible } from '../../src/index';
import { TestDO } from './test-worker-and-dos';

type TestDOType = RpcAccessible<InstanceType<typeof TestDO>>;

describe('WebSocket with downstream messaging', () => {
  
  it('creates client with WebSocket transport and onDownstream callback', async () => {
    const downstreamMessages: any[] = [];
    
    await using client = createTestingClient<TestDOType>('TEST_DO', 'ws-downstream-test', {
      transport: 'websocket',
      onDownstream: (message) => {
        downstreamMessages.push(message);
      }
    });
    
    // Reset to ensure clean state
    await client.reset();
    
    // Verify basic RPC works
    const count1 = await client.increment();
    expect(count1).toBe(1);
    
    // Verify client can be used normally
    expect(await client.getCount()).toBe(1);
  });
  
  it('auto-generates clientId when onDownstream is provided without clientId', async () => {
    await using client = createTestingClient<TestDOType>('TEST_DO', 'ws-clientid-test', {
      transport: 'websocket',
      onDownstream: (message) => {
        // Just testing that clientId is auto-generated
      }
    });
    
    // Should work fine even without explicit clientId
    await client.reset();
    const count = await client.increment();
    expect(count).toBe(1);
  });
  
  it('uses explicit clientId when provided', async () => {
    await using client = createTestingClient<TestDOType>('TEST_DO', 'ws-explicit-id', {
      transport: 'websocket',
      clientId: 'my-test-client',
      onDownstream: (message) => {
        // Using explicit clientId
      }
    });
    
    await client.reset();
    const count = await client.increment();
    expect(count).toBe(1);
  });
});

