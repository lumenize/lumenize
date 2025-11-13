import { it, expect, vi } from 'vitest';
import type { RpcAccessible } from '@lumenize/testing';
import { createTestingClient } from '@lumenize/testing';
import type { OriginDO, RemoteDO } from './test-dos';

type OriginDOType = RpcAccessible<InstanceType<typeof OriginDO>>;
type RemoteDOType = RpcAccessible<InstanceType<typeof RemoteDO>>;

/*
Basic call pattern - see OriginDO.exampleBasicCall() for full svc.call() usage
*/
it('shows basic remote call with result handler', async () => {
  using origin = createTestingClient<OriginDOType>('ORIGIN_DO', 'origin-1');
  using remote = createTestingClient<RemoteDOType>('REMOTE_DO', 'remote-1');

  await origin.exampleBasicCall('user-123');

  await vi.waitFor(async () => {
    const results = await origin.getResults();
    expect(results.length).toBeGreaterThan(0);
  });

  const results = await origin.getResults();
  expect(results[0].type).toBe('success');
  expect(results[0].value).toEqual({ userId: 'user-123', name: 'Test User' });

  const executed = await remote.getExecutedOperations();
  expect(executed).toContain('getUserData');
});

/*
Error handling - errors delivered as Error instances
*/
it('handles remote errors gracefully', async () => {
  using origin = createTestingClient<OriginDOType>('ORIGIN_DO', 'origin-2');

  await origin.exampleErrorHandling('Test error message');

  await vi.waitFor(async () => {
    const results = await origin.getResults();
    expect(results.length).toBeGreaterThan(0);
  });

  const results = await origin.getResults();
  expect(results[0].type).toBe('error');
  expect(results[0].value).toContain('Test error message');
});

/*
Timeout configuration - see OriginDO.exampleWithTimeout() for timeout option
*/
it('shows timeout configuration', async () => {
  using origin = createTestingClient<OriginDOType>('ORIGIN_DO', 'origin-3');

  await origin.exampleWithTimeout(10, 5000);

  await vi.waitFor(async () => {
    const results = await origin.getResults();
    expect(results.length).toBeGreaterThan(0);
  });

  const results = await origin.getResults();
  expect(results[0].type).toBe('success');
});

/*
Multiple sequential calls
*/
it('handles multiple sequential calls', async () => {
  using origin = createTestingClient<OriginDOType>('ORIGIN_DO', 'origin-4');

  await origin.exampleBasicCall('user-1');
  await origin.exampleBasicCall('user-2');
  await origin.exampleBasicCall('user-3');

  await vi.waitFor(async () => {
    const results = await origin.getResults();
    expect(results.length).toBe(3);
  });

  const results = await origin.getResults();
  expect(results.every(r => r.type === 'success')).toBe(true);
});

/*
Using $result pattern - see OriginDO.exampleMathOperation()
*/
it('confirms $result pattern works', async () => {
  using origin = createTestingClient<OriginDOType>('ORIGIN_DO', 'origin-5');

  await origin.exampleMathOperation(5, 3);

  await vi.waitFor(async () => {
    const results = await origin.getResults();
    expect(results.length).toBeGreaterThan(0);
  });

  const results = await origin.getResults();
  expect(results[0].type).toBe('success');
  expect(results[0].value).toBe(8);
});

/*
Actor model - non-blocking behavior
*/
it('demonstrates non-blocking actor model', async () => {
  using origin = createTestingClient<OriginDOType>('ORIGIN_DO', 'origin-6');

  await origin.exampleWithTimeout(100, 30000);

  await vi.waitFor(async () => {
    const results = await origin.getResults();
    expect(results.length).toBeGreaterThan(0);
  }, { timeout: 300 });

  const results = await origin.getResults();
  expect(results[0].type).toBe('success');
});

