import { it, expect, vi } from 'vitest';
import { createTestingClient } from '../../../src';
import { SchedulerDO } from './SchedulerDO';

it('handles multiple Actor alarms automatically', { timeout: 25000 }, async () => {
  await using client = createTestingClient<typeof SchedulerDO>(
    'SCHEDULER_DO',
    'multi-alarms'
  );

  // Schedule multiple alarms
  await client.scheduleMultiple();

  // Wait for all alarms to fire (1x speed = real time)
  await vi.waitFor(async () => {
    const firedCount = await client.getAlarmsFiredCount();
    expect(firedCount).toBe(3);
  }, { timeout: 20000 }); // 20 seconds for 15-second max delay

  // Verify all fired
  expect(await client.getAlarmsFiredCount()).toBe(3);
});

