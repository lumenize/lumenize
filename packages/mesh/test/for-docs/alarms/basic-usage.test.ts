/**
 * Pedagogical tests of `LumenizeDO`'s built-in alarms service, run once in the `main` project. The
 * Durable Object they drive is in `task-scheduler-do.ts`, which the test worker exports.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { Schedule } from '@lumenize/mesh';

describe('Alarms - Basic Usage', () => {
  it('schedules one-time task with delay', async () => {
    const stub = env.TASK_SCHEDULER_DO.getByName('delay-test');

    const result = await stub.scheduleTask('send-email', 5);

    expect(result.scheduled).toBe(true);
    expect(result.taskName).toBe('send-email');
  });

  it('schedules task at specific timestamp', async () => {
    const stub = env.TASK_SCHEDULER_DO.getByName('timestamp-test');

    const future = Date.now() + 10000; // 10 seconds from now
    const result = await stub.scheduleAt('cleanup', future);

    expect(result.scheduled).toBe(true);
  });

  it('schedules recurring task with cron', async () => {
    const stub = env.TASK_SCHEDULER_DO.getByName('cron-test');

    const result = await stub.scheduleRecurringTask('daily-report');

    expect(result.scheduled).toBe(true);
    expect(result.recurring).toBe(true);
  });

  it('cancels scheduled task', async () => {
    const stub = env.TASK_SCHEDULER_DO.getByName('cancel-test');

    // First request: schedule the task
    const scheduleResult = await stub.scheduleTaskForCancellation('reminder', 60);
    expect(scheduleResult.scheduled).toBe(true);

    // Second request: cancel the task
    const cancelResult = await stub.cancelScheduledTask(scheduleResult.scheduleId);
    expect(cancelResult.cancelled).toBe(true);
    expect(cancelResult.cancelledData).toBeDefined();
    expect(cancelResult.cancelledData!.id).toBe(scheduleResult.scheduleId);

    // Verify it's gone
    const scheduled = await stub.getScheduledTasks();
    expect(scheduled.find((s: Schedule) => s.id === scheduleResult.scheduleId)).toBeUndefined();
  });

  it('lists all scheduled tasks', async () => {
    const stub = env.TASK_SCHEDULER_DO.getByName('list-test');

    await stub.scheduleTask('task1', 10);
    await stub.scheduleTask('task2', 20);

    const scheduled = await stub.getScheduledTasks();
    expect(scheduled.length).toBeGreaterThanOrEqual(2);
  });

  it('executes scheduled task via triggerAlarms', async () => {
    const stub = env.TASK_SCHEDULER_DO.getByName('execute-test');

    // Schedule a task
    await stub.scheduleTask('execute-me', 10);

    // Manually trigger the alarm for testing
    const executed = await stub.triggerAlarms(1);
    expect(executed.length).toBe(1);

    // Verify task executed
    const tasks = await stub.getExecutedTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].name).toBe('execute-me');
  });
});
