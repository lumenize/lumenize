/**
 * Pedagogical tests for alarm testing workarounds documentation
 * These tests are referenced in website/docs/testing/alarm-simulation.mdx
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { createTestingClient } from '@lumenize/testing';

// Example using @lumenize/alarms triggerAlarms()
describe('Alarm Execution', () => {
  it('executes scheduled tasks', async () => {
    const stub = env.MY_DO.getByName('alarm-test');
    
    // Schedule alarms
    await stub.scheduleTask('task1', 10);
    await stub.scheduleTask('task2', 20);
    
    // Manually trigger alarms (fast-forward instead of waiting)
    const executed = await stub.triggerAlarms(2);
    expect(executed.length).toBe(2);
    
    // Verify execution
    const results = await stub.getExecutedTasks();
    expect(results).toHaveLength(2);
  });
});

// Example testing alarm handlers directly via RPC
describe('Alarm Handlers', () => {
  it('handles scheduled task correctly', async () => {
    const client = await createTestingClient(env.MY_DO.getByName('handler-test'));
    
    // Call your alarm handler directly via RPC
    await client.handleAlarm({ task: 'process-data' }, mockSchedule);
    
    // Verify the handler worked
    const result = await client.getTaskResult();
    expect(result.status).toBe('completed');
  });
});

// Example using runDurableObjectAlarm from cloudflare:test
it('triggers all pending alarms', async () => {
  const stub = env.MY_DO.getByName('alarm-test');
  
  // Schedule alarms
  await stub.scheduleTask(10);
  await stub.scheduleTask(20);
  
  // Manually trigger alarm execution
  await runDurableObjectAlarm(stub);
  
  // Verify alarms fired
  const executed = await stub.getExecutedAlarms();
  expect(executed.length).toBeGreaterThan(0);
});

// Mock schedule object for testing
const mockSchedule = {
  id: 'test-schedule-id',
  callback: 'handleAlarm',
  payload: { task: 'process-data' },
  time: Math.floor(Date.now() / 1000),
  type: 'delayed' as const,
};

