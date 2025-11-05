/**
 * Pedagogical tests for alarm testing workarounds documentation
 * These tests are referenced in website/docs/testing/alarm-simulation.mdx
 */
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm } from 'cloudflare:test';

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

// Example using runDurableObjectAlarm from cloudflare:test
it('triggers all pending alarms', async () => {
  const stub = env.MY_DO.getByName('alarm-test');
  
  // Schedule alarms
  await stub.scheduleTask('task3', 10);
  await stub.scheduleTask('task4', 20);
  
  // Manually trigger alarm execution
  await runDurableObjectAlarm(stub);
  
  // Verify alarms fired
  const executed = await stub.getExecutedAlarms();
  expect(executed.length).toBeGreaterThan(0);
});

