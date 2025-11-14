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

  await origin.initializeBinding('ORIGIN_DO');

  await origin.exampleBasicCall('user-123');

  // Manually trigger alarms to process the 0-second call alarm
  await origin.triggerAlarms();

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
Alternative syntax: inline with variable reference - see OriginDO.exampleBasicCall2()
*/
it('shows inline variable reference syntax', async () => {
  using origin = createTestingClient<OriginDOType>('ORIGIN_DO', 'origin-1b');

  await origin.initializeBinding('ORIGIN_DO');

  await origin.exampleBasicCall2('user-456');

  // Manually trigger alarms to process the 0-second call alarm
  await origin.triggerAlarms();

  await vi.waitFor(async () => {
    const results = await origin.getResults();
    expect(results.length).toBeGreaterThan(0);
  });

  const results = await origin.getResults();
  expect(results[0].type).toBe('success');
  expect(results[0].value).toEqual({ userId: 'user-456', name: 'Test User' });
});

/*
Alternative syntax: inline with $result marker - see OriginDO.exampleBasicCall3()
*/
it('shows inline $result marker syntax', async () => {
  using origin = createTestingClient<OriginDOType>('ORIGIN_DO', 'origin-1c');

  await origin.initializeBinding('ORIGIN_DO');

  await origin.exampleBasicCall3('user-789');

  // Manually trigger alarms to process the 0-second call alarm
  await origin.triggerAlarms();

  await vi.waitFor(async () => {
    const results = await origin.getResults();
    expect(results.length).toBeGreaterThan(0);
  });

  const results = await origin.getResults();
  expect(results[0].type).toBe('success');
  expect(results[0].value).toEqual({ userId: 'user-789', name: 'Test User' });
});

/*
Error handling - errors delivered as Error instances
*/
it('handles remote errors gracefully', async () => {
  using origin = createTestingClient<OriginDOType>('ORIGIN_DO', 'origin-2');

  await origin.initializeBinding('ORIGIN_DO');

  await origin.exampleErrorHandling('Test error message');

  // Manually trigger alarms to process the 0-second call alarm
  await origin.triggerAlarms();

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

  await origin.initializeBinding('ORIGIN_DO');

  await origin.exampleWithTimeout(10, 5000);

  // Manually trigger alarms to process the 0-second call alarm
  await origin.triggerAlarms();

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

  await origin.initializeBinding('ORIGIN_DO');

  await origin.exampleBasicCall('user-1');
  await origin.triggerAlarms();  // Trigger first call's alarm
  
  await origin.exampleBasicCall('user-2');
  await origin.triggerAlarms();  // Trigger second call's alarm
  
  await origin.exampleBasicCall('user-3');
  await origin.triggerAlarms();  // Trigger third call's alarm

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

  await origin.initializeBinding('ORIGIN_DO');

  await origin.exampleMathOperation(5, 3);

  // Manually trigger alarms to process the 0-second call alarm
  await origin.triggerAlarms();

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

  await origin.initializeBinding('ORIGIN_DO');

  await origin.exampleWithTimeout(100, 30000);

  // Manually trigger alarms to process the 0-second call alarm
  await origin.triggerAlarms();

  await vi.waitFor(async () => {
    const results = await origin.getResults();
    expect(results.length).toBeGreaterThan(0);
  }, { timeout: 300 });

  const results = await origin.getResults();
  expect(results[0].type).toBe('success');
});

/*
Direct storage access - accessing remote DO's storage via OCAN property chains
*/
it('accesses remote storage directly via property chains', async () => {
  using origin = createTestingClient<OriginDOType>('ORIGIN_DO', 'origin-7');
  using remote = createTestingClient<RemoteDOType>('REMOTE_DO', 'remote-storage-test');

  // Initialize both DOs
  await origin.initializeBinding('ORIGIN_DO');
  await remote.__lmzInit({ 
    doBindingName: 'REMOTE_DO',
    doInstanceNameOrId: 'my-remote-instance'
  });

  // Clear origin results
  await origin.clearResults();

  // Fetch the remote's instance name via storage access
  await origin.exampleStorageAccess('remote-storage-test');

  // Manually trigger alarms to process the 0-second call alarm
  await origin.triggerAlarms();

  // Wait for the result to arrive
  await vi.waitFor(async () => {
    const results = await origin.getResults();
    expect(results.length).toBeGreaterThan(0);
  });

  // Verify the result
  const results = await origin.getResults();
  expect(results[0].type).toBe('success');
  expect(results[0].value).toBe('my-remote-instance');

  // Verify it was stored locally under a different key
  const fetchedName = await origin.getFetchedRemoteName();
  expect(fetchedName).toBe('my-remote-instance');
});

/*
Direct storage access in BOTH operations - no handler methods needed!
*/
it('uses property chains for both remote operation and handler', async () => {
  using origin = createTestingClient<OriginDOType>('ORIGIN_DO', 'origin-8');
  using remote = createTestingClient<RemoteDOType>('REMOTE_DO', 'remote-storage-test-2');

  // Initialize both DOs
  await origin.initializeBinding('ORIGIN_DO');
  await remote.__lmzInit({ 
    doBindingName: 'REMOTE_DO',
    doInstanceNameOrId: 'my-remote-instance-2'
  });

  // Fetch and store using only property chains (no handler methods!)
  await origin.exampleStorageAccessDirect('remote-storage-test-2');

  // Manually trigger alarms to process the 0-second call alarm
  await origin.triggerAlarms();

  // Wait for the operation to complete
  await vi.waitFor(async () => {
    const fetchedName = await origin.getFetchedRemoteNameDirect();
    return fetchedName !== undefined;
  });

  // Verify the value was fetched from remote and stored locally
  const fetchedName = await origin.getFetchedRemoteNameDirect();
  expect(fetchedName).toBe('my-remote-instance-2');
});

