import { it, expect, vi } from 'vitest';
import { createTestingClient } from '../../../src';
import { MyDO } from './MyDO';

it('new alarm overwrites pending alarm', async () => {
  await using client = createTestingClient<typeof MyDO>('MY_DO', 'overwrite');

  // Schedule first alarm for 10 seconds
  await client.scheduleTask(10); // 100ms in test time
  const firstAlarmTime = await client.getAlarmTime();

  // Schedule second alarm for 5 seconds (overwrites first)
  await client.scheduleTask(5); // 50ms in test time
  const secondAlarmTime = await client.getAlarmTime();

  expect(secondAlarmTime).not.toBe(firstAlarmTime);
  expect(secondAlarmTime).toBeLessThan(firstAlarmTime);

  // Only the second alarm fires
  await vi.waitFor(async () => {
    expect(await client.alarmFiredCount).toBe(1);
  }, { timeout: 100 });
});

