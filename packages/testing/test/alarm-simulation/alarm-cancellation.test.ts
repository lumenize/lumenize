/**
 * Test for alarm cancellation (deleteAlarm)
 * Tests the uncovered deleteAlarm() path in alarm-simulation.ts
 */
import { it, expect, vi } from 'vitest';
import { createTestingClient } from '../../src/index';
import { MyDO } from './test-worker-and-dos';

it('cancels scheduled alarm with deleteAlarm', async () => {
  await using client = createTestingClient<typeof MyDO>('MY_DO', 'cancel-test');

  // Schedule an alarm
  await client.scheduleTask(10); // 100ms in test time
  
  // Verify alarm was scheduled
  const beforeCancel = await client.getAlarmTime();
  expect(beforeCancel).not.toBeNull();

  // Cancel the alarm
  await client.ctx.storage.deleteAlarm();
  
  // Verify alarm was cancelled
  const afterCancel = await client.getAlarmTime();
  expect(afterCancel).toBeNull();
  
  // Wait to ensure alarm doesn't fire
  await new Promise(resolve => setTimeout(resolve, 150));
  
  // Verify alarm never fired
  expect(await client.alarmFiredCount).toBe(0);
  expect(await client.taskStatus).toBe('idle');
});

