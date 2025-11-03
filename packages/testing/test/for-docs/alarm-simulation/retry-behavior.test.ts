import { it, expect, vi } from 'vitest';
import { createTestingClient } from '../../../src';
import { MyDO } from './MyDO';

it('retries failed alarms with exponential backoff', async () => {
  await using client = createTestingClient<typeof MyDO>('MY_DO', 'retry-test');

  // Make the alarm fail twice, then succeed
  await client.setAlarmFailureCount(2);

  // Schedule alarm
  await client.scheduleTask(1); // 1 second = 10ms in test time

  // Wait for retries to complete
  // First attempt (10ms) + Retry 1 (20ms) + Retry 2 (40ms) + buffer
  await vi.waitFor(async () => {
    const status = await client.taskStatus;
    expect(status).toBe('complete');
  }, { timeout: 150 });

  // Verify it succeeded after retries
  expect(await client.alarmRetryCount).toBe(2);
  expect(await client.taskStatus).toBe('complete');
});

