import { it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, setInspectMode, getLastBatchRequest } from '@lumenize/rpc';
import { getWebSocketShim } from '@lumenize/utils';
import { ExampleDO } from './test-worker-and-dos';

it('simple case with inspect mode', async () => {
  using client = createRpcClient<typeof ExampleDO>(
    'EXAMPLE_DO',
    'inspect-test',
    { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
  );

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
  using client = createRpcClient<typeof ExampleDO>(
    'EXAMPLE_DO',
    'inspect-chain-test',
    { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
  );

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
