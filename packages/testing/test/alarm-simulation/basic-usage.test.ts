/**
 * Pedagogical test for basic alarm simulation
 * Referenced in website/docs/testing/alarm-simulation.mdx
 */
import { it, expect, vi } from 'vitest';
import { createTestingClient } from '../../src/index';
import { MyDO } from './test-worker-and-dos';

it('automatically fires scheduled alarms', async () => {
  await using client = createTestingClient<typeof MyDO>('MY_DO', 'alarm-test');

  // Schedule an alarm for 10 seconds in the future
  await client.scheduleTask(10);

  // Verify alarm was scheduled
  const state = await client.getAlarmState();
  expect(state.scheduledTime).not.toBeNull();

  // Wait for alarm to fire (100x faster = 100ms in test time)
  await vi.waitFor(async () => {
    const status = await client.taskStatus;
    expect(status).toBe('complete');
  }, { timeout: 200 }); // Give it 200ms buffer

  // Verify alarm completed
  expect(await client.taskStatus).toBe('complete');
});

