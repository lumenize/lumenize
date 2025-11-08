import { it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createRpcClient, createWebSocketTransport, setInspectMode, getLastBatchRequest } from '@lumenize/rpc';
import { getWebSocketShim } from '@lumenize/utils';
import { ExampleDO } from './test-worker-and-dos';

it('simple case with inspect mode', async () => {
  using client = createRpcClient<typeof ExampleDO>({
    transport: createWebSocketTransport('EXAMPLE_DO', 'inspect-test', {
      WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF))
    })
  });

  // Enable inspect mode
  setInspectMode(true);
  
  // Just a simple call - executes normally but captures operation chain
  const result = await client.add(2, 3);
  
  // Get the captured operation chain
  const batchRequest = getLastBatchRequest();
  
  // Disable inspect mode
  setInspectMode(false);
  
  // Should have captured the operation chain
  expect(batchRequest).toBeTruthy();
  expect(batchRequest!.batch).toHaveLength(1);
  expect(batchRequest!.batch[0].operations).toMatchObject([
    { type: 'get', key: 'add' },
    { type: 'apply', args: [2, 3] }
  ]);
  
  // Result should still be correct
  expect(result).toBe(5);
});

it('chaining case with inspect mode', async () => {
  using client = createRpcClient<typeof ExampleDO>({
    transport: createWebSocketTransport('EXAMPLE_DO', 'inspect-chain-test', {
      WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF))
    })
  });

  // Enable inspect mode
  setInspectMode(true);
  
  // Chained call - executes normally but captures operation chain
  const result = await client.increment().then(async (count) => {
    // This creates a second operation that chains off the first
    return client.add(count, 10);
  });
  
  // Get the captured operation chain from the second operation
  const batchRequest = getLastBatchRequest();
  
  // Disable inspect mode
  setInspectMode(false);
  
  // Should have captured the operation chain from the last call
  expect(batchRequest).toBeTruthy();
  expect(batchRequest!.batch).toHaveLength(1);
  expect(batchRequest!.batch[0].operations).toMatchObject([
    { type: 'get', key: 'add' },
    { type: 'apply' } // args will include the result from increment
  ]);
  
  // Result should be correct (1 from increment + 10)
  expect(result).toBe(11);
});

it('detects aliases when same proxy is reused (not duplicated)', async () => {
  using client = createRpcClient<typeof ExampleDO>({
    transport: createWebSocketTransport('EXAMPLE_DO', 'alias-test', {
      WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF))
    })
  });

  setInspectMode(true);
  
  // Build OCAN chains without awaiting, then await both together
  const x = client.increment();              // No `await` - just building a chain
  const y = client.add(x as any, 10);        // Also no `await` - x used as arg (cast for OCAN)
  const z = client.add(x as any, 20);        // Also no `await` - x used AGAIN (cast for OCAN)
  const [yResult, zResult] = await Promise.all([y, z]);  // Both batched together
  
  const batchRequest = getLastBatchRequest();
  setInspectMode(false);

  // CRITICAL: `x` appears in TWO different operations (y and z) in the SAME batch
  // It should be:
  // 1. Assigned a unique __refId on first encounter (in y's args)
  // 2. Second occurrence (in z's args) references same __refId (alias, not duplicate)
  // 
  // If duplicated, `increment()` executes TWICE:
  // - Local behavior: x = 1, y = add(1, 10) = 11, z = add(1, 20) = 21
  // - RPC with duplication: 
  //   - First `x` resolves: increment() → 1 (counter: 0 → 1)
  //   - Second `x` resolves: increment() → 2 (counter: 1 → 2)
  //   - y = add(1, 10) = 11 ✅
  //   - z = add(2, 20) = 22 ❌ WRONG! Should be 21
  // 
  // This breaks the fundamental contract: RPC should behave identically to local calls!
  
  expect(batchRequest).toBeTruthy();
  expect(batchRequest!.batch).toHaveLength(2);  // Both y and z in batch
  
  // Check first operation (y)
  const yOps = batchRequest!.batch[0].operations;
  expect(yOps).toHaveLength(2);
  expect(yOps[0]).toMatchObject({ type: 'get', key: 'add' });
  expect(yOps[1].type).toBe('apply');
  if (yOps[1].type === 'apply') {
    expect(yOps[1].args).toMatchObject([expect.any(Object), 10]);
  }
  
  // Check second operation (z)
  const zOps = batchRequest!.batch[1].operations;
  expect(zOps).toHaveLength(2);
  expect(zOps[0]).toMatchObject({ type: 'get', key: 'add' });
  expect(zOps[1].type).toBe('apply');
  if (zOps[1].type === 'apply') {
    expect(zOps[1].args).toMatchObject([expect.any(Object), 20]);
  }
  
  // Check the nested operation markers (type narrowing ensures args exists)
  if (yOps[1].type !== 'apply' || zOps[1].type !== 'apply') {
    throw new Error('Expected apply operations');
  }
  const yFirstArg = yOps[1].args[0];
  const zFirstArg = zOps[1].args[0];
  
  expect(yFirstArg).toHaveProperty('__isNestedOperation', true);
  expect(zFirstArg).toHaveProperty('__isNestedOperation', true);
  
  // EXPECTED BEHAVIOR (AFTER REFACTOR): First has full marker, second is alias
  // yFirstArg = {
  //   __isNestedOperation: true,
  //   __refId: 'proxy-1',
  //   __operationChain: [{ type: 'get', key: 'increment' }, { type: 'apply', args: [] }]
  // }
  // zFirstArg = {
  //   __isNestedOperation: true,
  //   __refId: 'proxy-1'  // Same ID, NO __operationChain (alias!)
  // }
  
  // EXPECTED RESULT: increment() executes ONCE (alias detection working)
  expect(yResult).toBe(11);  // add(1, 10) = 11 ✅
  expect(zResult).toBe(21);  // add(1, 20) = 21 ✅
  
  // Validate alias structure
  expect(yFirstArg.__refId).toBeDefined();
  expect(yFirstArg.__refId).toMatch(/^proxy-\d+$/);  // Format: proxy-{number}
  expect(yFirstArg.__operationChain).toBeDefined();  // First occurrence has full chain
  
  expect(zFirstArg.__refId).toBeDefined();
  expect(zFirstArg.__refId).toBe(yFirstArg.__refId);  // Same ID - it's an alias!
  expect(zFirstArg.__operationChain).toBeUndefined();  // Alias has NO chain
});
