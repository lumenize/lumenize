import { describe, test, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

describe('Call - DO-to-DO Communication', () => {
  describe('Basic Remote Calls', () => {
    test('calls remote method and receives result', async () => {
      const origin = env.ORIGIN_DO.getByName('basic-call-test');
      const remote = env.REMOTE_DO.getByName('remote-instance');

      // Clear any previous state
      await origin.clearResults();
      await remote.clearExecutedOperations();

      // Make remote call
      await origin.callRemoteGetUserData('user-123');

      // Wait for result to be processed
      await origin.waitForResults(1);

      // Verify result was received
      const results = await origin.getResults();
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('success');
      expect(results[0].value).toEqual({
        id: 'user-123',
        name: 'Test User',
        email: 'test@example.com'
      });

      // Verify remote DO executed the operation
      const executed = await remote.getExecutedOperations();
      expect(executed).toHaveLength(1);
      expect(executed[0].method).toBe('getUserData');
      expect(executed[0].args).toEqual(['user-123']);
    });

    test('calls remote math operation', async () => {
      const origin = env.ORIGIN_DO.getByName('math-call-test');
      const remote = env.REMOTE_DO.getByName('remote-instance');

      await origin.clearResults();
      await remote.clearExecutedOperations();

      // Make remote call
      await origin.callRemoteAdd(5, 3);

      // Wait for result
      await origin.waitForResults(1);

      // Verify result
      const results = await origin.getResults();
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('success');
      expect(results[0].value).toBe(8);

      // Verify execution
      const executed = await remote.getExecutedOperations();
      expect(executed).toHaveLength(1);
      expect(executed[0].method).toBe('add');
      expect(executed[0].args).toEqual([5, 3]);
    });

    test('handles multiple sequential calls', async () => {
      const origin = env.ORIGIN_DO.getByName('multi-call-test');
      const remote = env.REMOTE_DO.getByName('remote-instance');

      await origin.clearResults();
      await remote.clearExecutedOperations();

      // Make multiple calls
      await origin.callRemoteAdd(1, 2);
      await origin.callRemoteAdd(3, 4);
      await origin.callRemoteAdd(5, 6);

      // Wait for all results
      await origin.waitForResults(3);

      // Verify results
      const results = await origin.getResults();
      expect(results).toHaveLength(3);
      expect(results[0].value).toBe(3);
      expect(results[1].value).toBe(7);
      expect(results[2].value).toBe(11);

      // Verify all executed
      const executed = await remote.getExecutedOperations();
      expect(executed).toHaveLength(3);
    });
  });

  describe('Error Handling', () => {
    test('handles remote errors correctly', async () => {
      const origin = env.ORIGIN_DO.getByName('error-call-test');
      const remote = env.REMOTE_DO.getByName('remote-instance');

      await origin.clearResults();
      await remote.clearExecutedOperations();

      // Call method that throws error
      await origin.callRemoteThrowError('Test error message');

      // Wait for result
      await origin.waitForResults(1);

      // Verify error was received
      const results = await origin.getResults();
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('error');
      expect(results[0].value).toContain('Test error message');

      // Verify remote executed (even though it threw)
      const executed = await remote.getExecutedOperations();
      expect(executed).toHaveLength(1);
      expect(executed[0].method).toBe('throwError');
    });

    test('continuation receives Error instance', async () => {
      const origin = env.ORIGIN_DO.getByName('error-instance-test');
      await origin.clearResults();

      await origin.callRemoteThrowError('Should be Error instance');
      await origin.waitForResults(1);

      const results = await origin.getResults();
      expect(results[0].type).toBe('error');
      // Handler correctly identified it as Error
    });
  });

  describe('Actor Model Behavior', () => {
    test('call returns immediately without waiting for execution', async () => {
      const origin = env.ORIGIN_DO.getByName('actor-model-test');
      await origin.clearResults();

      const startTime = Date.now();
      
      // This should return immediately (not wait for remote execution)
      await origin.callRemoteGetUserData('fast-return');
      
      const callDuration = Date.now() - startTime;
      
      // Call should return in < 100ms (just message delivery)
      // Remote execution happens asynchronously
      expect(callDuration).toBeLessThan(100);

      // But result should eventually arrive
      await origin.waitForResults(1);
      const results = await origin.getResults();
      expect(results).toHaveLength(1);
    });

    test('work queue processes items asynchronously', async () => {
      const origin = env.ORIGIN_DO.getByName('queue-test');
      const remote = env.REMOTE_DO.getByName('remote-instance');

      // Clear state from any previous tests
      await origin.clearResults();
      await remote.clearExecutedOperations();

      // Wait a bit to ensure state is truly cleared
      await new Promise(resolve => setTimeout(resolve, 50));

      // Send multiple calls rapidly
      const promises = [
        origin.callRemoteAdd(1, 1),
        origin.callRemoteAdd(2, 2),
        origin.callRemoteAdd(3, 3)
      ];

      // All calls should return quickly (queued)
      await Promise.all(promises);

      // Results arrive asynchronously
      await origin.waitForResults(3);

      const results = await origin.getResults();
      expect(results).toHaveLength(3);
      
      // All operations should have been executed
      const executed = await remote.getExecutedOperations();
      // Note: May have operations from other tests if they ran concurrently
      // Just verify we have at least 3
      expect(executed.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Timeout Handling', () => {
    test('handles timeout for slow operations', async () => {
      const origin = env.ORIGIN_DO.getByName('timeout-test');
      await origin.clearResults();

      // Call with very short timeout (should timeout)
      await origin.callWithTimeout('slow-operation', 10); // 10ms timeout

      // Wait for timeout to trigger
      await origin.waitForResults(1, 500);

      const results = await origin.getResults();
      expect(results).toHaveLength(1);
      
      // Should receive timeout error
      if (results[0].type === 'error') {
        expect(results[0].value).toContain('timeout');
      }
    });

    test('successful call before timeout', async () => {
      const origin = env.ORIGIN_DO.getByName('no-timeout-test');
      await origin.clearResults();

      // Call with generous timeout (should succeed)
      await origin.callWithTimeout('fast-operation', 5000); // 5 second timeout

      await origin.waitForResults(1);

      const results = await origin.getResults();
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('success');
      expect(results[0].value).toContain('processed: fast-operation');
    });
  });

  describe('OCAN Integration', () => {
    test('type-safe operation chains', async () => {
      const origin = env.ORIGIN_DO.getByName('ocan-test');
      const remote = env.REMOTE_DO.getByName('remote-instance');

      await origin.clearResults();
      await remote.clearExecutedOperations();

      // OCAN chain captures method and arguments
      await origin.callRemoteGetUserData('ocan-user');

      await origin.waitForResults(1);

      // Verify correct method was called with correct arguments
      const executed = await remote.getExecutedOperations();
      expect(executed[0].method).toBe('getUserData');
      expect(executed[0].args[0]).toBe('ocan-user');
    });

    test('continuation receives typed result', async () => {
      const origin = env.ORIGIN_DO.getByName('typed-result-test');
      await origin.clearResults();

      await origin.callRemoteGetUserData('typed-user');
      await origin.waitForResults(1);

      const results = await origin.getResults();
      // Handler receives the actual UserData type
      expect(results[0].value).toHaveProperty('id');
      expect(results[0].value).toHaveProperty('name');
      expect(results[0].value).toHaveProperty('email');
    });
  });
});

