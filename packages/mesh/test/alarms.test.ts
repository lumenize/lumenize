/**
 * Core tests for Alarms built-in service in @lumenize/mesh
 *
 * Note: Alarms is now a built-in service in LumenizeDO - no separate import needed.
 * Uses triggerAlarms() instead of flaky testing package alarm simulation.
 */
import { describe, test, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { DelayedAlarm, CronAlarm, Schedule } from '../src/alarms';

describe('Alarms', () => {
  describe('One-time Scheduled Alarms', () => {
    test('schedules alarm for specific date', async () => {
      const stub = env.ALARM_TEST_DO.getByName('scheduled-date-test');

      const futureDate = new Date(Date.now() + 1000);
      const schedule = await stub.scheduleAlarm(futureDate, { task: 'test-task' });

      expect(schedule.type).toBe('scheduled');
      expect(schedule.time).toBe(Math.floor(futureDate.getTime() / 1000));
      expect(schedule.operationChain).toBeDefined();
      expect(schedule.operationChain.length).toBeGreaterThan(0);
    });

    test('executes scheduled alarm at specified time', async () => {
      const stub = env.ALARM_TEST_DO.getByName('scheduled-execute-test');

      const futureDate = new Date(Date.now() + 10000);
      const schedule = await stub.scheduleAlarm(futureDate, { task: 'execute-me' });

      // Manually trigger the next alarm using triggerAlarms
      const executedIds = await stub.triggerAlarms(1);
      expect(executedIds.length).toBe(1);
      expect(executedIds[0]).toBe(schedule.id);

      const executed = await stub.getExecutedAlarms() as Array<{ payload: any }>;
      expect(executed.length).toBe(1);
      expect(executed[0].payload).toEqual({ task: 'execute-me' });
    });

    test('removes one-time alarm after execution', async () => {
      const stub = env.ALARM_TEST_DO.getByName('scheduled-remove-test');

      const futureDate = new Date(Date.now() + 10000);
      const schedule = await stub.scheduleAlarm(futureDate, { task: 'remove-after' });

      // Verify alarm exists before execution
      const beforeExecution = await stub.getSchedule(schedule.id);
      expect(beforeExecution).toBeDefined();
      expect(beforeExecution?.type).toBe('scheduled');

      // Manually trigger the alarm
      await stub.triggerAlarms(1);

      // Verify alarm was removed after execution
      const afterExecution = await stub.getSchedule(schedule.id);
      expect(afterExecution).toBeUndefined();
    });
  });

  describe('Delayed Alarms', () => {
    test('schedules alarm with delay in seconds', async () => {
      const stub = env.ALARM_TEST_DO.getByName('delayed-test');

      const schedule = await stub.scheduleDelayedAlarm(5, { task: 'delayed-task' });

      expect(schedule.type).toBe('delayed');
      expect((schedule as DelayedAlarm).delayInSeconds).toBe(5);
      expect(schedule.operationChain).toBeDefined();
    });

    test('executes delayed alarm', async () => {
      const stub = env.ALARM_TEST_DO.getByName('delayed-execute-test');

      await stub.scheduleDelayedAlarm(10, { task: 'delayed-task' });

      const executedIds = await stub.triggerAlarms(1);
      expect(executedIds.length).toBe(1);

      const executed = await stub.getExecutedAlarms() as Array<{ payload: any }>;
      expect(executed.length).toBe(1);
      expect(executed[0].payload).toEqual({ task: 'delayed-task' });
    });
  });

  describe('Cron Alarms', () => {
    test('schedules recurring cron alarm', async () => {
      const stub = env.ALARM_TEST_DO.getByName('cron-test');

      const schedule = await stub.scheduleCronAlarm('* * * * *', { task: 'recurring' });

      expect(schedule.type).toBe('cron');
      expect((schedule as CronAlarm).cron).toBe('* * * * *');
      expect(schedule.operationChain).toBeDefined();
    });

    test('cron alarm is rescheduled after execution', async () => {
      const stub = env.ALARM_TEST_DO.getByName('cron-reschedule-test');

      const schedule = await stub.scheduleCronAlarm('* * * * *', { task: 'reschedule' });
      const originalTime = schedule.time;

      // Execute the cron alarm
      await stub.triggerAlarms(1);

      // Verify alarm was executed
      const executed = await stub.getExecutedAlarms() as Array<{ payload: any }>;
      expect(executed.length).toBe(1);
      expect(executed[0].payload).toEqual({ task: 'reschedule' });

      // Verify alarm still exists and was rescheduled
      const afterExecution = await stub.getSchedule(schedule.id);
      expect(afterExecution).toBeDefined();
      expect(afterExecution?.type).toBe('cron');
      expect((afterExecution as CronAlarm | undefined)?.cron).toBe('* * * * *');
      expect(afterExecution?.time).toBeGreaterThanOrEqual(originalTime);
    });
  });

  describe('Alarm Management', () => {
    test('retrieves schedule by ID', async () => {
      const stub = env.ALARM_TEST_DO.getByName('get-schedule-test');

      const futureDate = new Date(Date.now() + 5000);
      const schedule = await stub.scheduleAlarm(futureDate, { task: 'get-me' });

      const retrieved = await stub.getSchedule(schedule.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(schedule.id);
      expect(retrieved?.type).toBe('scheduled');
    });

    test('returns undefined for non-existent schedule', async () => {
      const stub = env.ALARM_TEST_DO.getByName('get-missing-test');

      const retrieved = await stub.getSchedule('non-existent-id');
      expect(retrieved).toBeUndefined();
    });

    test('cancels scheduled alarm', async () => {
      const stub = env.ALARM_TEST_DO.getByName('cancel-test');

      const futureDate = new Date(Date.now() + 5000);
      const schedule = await stub.scheduleAlarm(futureDate, { task: 'cancel-me' });

      const cancelled = await stub.cancelSchedule(schedule.id);
      expect(cancelled).toBeDefined();
      expect(cancelled!.id).toBe(schedule.id);
      expect(cancelled!.operationChain).toBeDefined();

      const retrieved = await stub.getSchedule(schedule.id);
      expect(retrieved).toBeUndefined();
    });

    test('lists all schedules', async () => {
      const stub = env.ALARM_TEST_DO.getByName('list-all-test');

      const date1 = new Date(Date.now() + 1000);
      const date2 = new Date(Date.now() + 2000);

      await stub.scheduleAlarm(date1, { task: 'first' });
      await stub.scheduleAlarm(date2, { task: 'second' });
      await stub.scheduleDelayedAlarm(5, { task: 'third' });

      const schedules = await stub.getSchedules();
      expect(schedules.length).toBeGreaterThanOrEqual(3);
    });

    test('filters schedules by type', async () => {
      const stub = env.ALARM_TEST_DO.getByName('filter-type-test');

      await stub.scheduleAlarm(new Date(Date.now() + 1000), { task: 'scheduled' });
      await stub.scheduleDelayedAlarm(5, { task: 'delayed' });
      await stub.scheduleCronAlarm('* * * * *', { task: 'cron' });

      const scheduledOnly = await stub.getSchedules({ type: 'scheduled' });
      expect(scheduledOnly.every((s: Schedule) => s.type === 'scheduled')).toBe(true);

      const delayedOnly = await stub.getSchedules({ type: 'delayed' });
      expect(delayedOnly.every((s: Schedule) => s.type === 'delayed')).toBe(true);

      const cronOnly = await stub.getSchedules({ type: 'cron' });
      expect(cronOnly.every((s: Schedule) => s.type === 'cron')).toBe(true);
    });
  });

  describe('Multiple Alarms', () => {
    test('executes multiple alarms in order', async () => {
      const stub = env.ALARM_TEST_DO.getByName('multiple-order-test');

      // Schedule three alarms in the past (all overdue)
      const past1 = new Date(Date.now() - 3000);
      const past2 = new Date(Date.now() - 2000);
      const past3 = new Date(Date.now() - 1000);

      await stub.scheduleAlarm(past1, { order: 1 });
      await stub.scheduleAlarm(past2, { order: 2 });
      await stub.scheduleAlarm(past3, { order: 3 });

      // Trigger all alarms
      const executedIds = await stub.triggerAlarms(3);
      expect(executedIds.length).toBe(3);

      const executed = await stub.getExecutedAlarms() as Array<{ payload: any }>;
      expect(executed.length).toBe(3);
      expect(executed[0].payload.order).toBe(1);
      expect(executed[1].payload.order).toBe(2);
      expect(executed[2].payload.order).toBe(3);
    });

    test('triggerAlarms with explicit count respects limit', async () => {
      const stub = env.ALARM_TEST_DO.getByName('count-limit-test');

      await stub.scheduleAlarm(new Date(Date.now() - 3000), { order: 1 });
      await stub.scheduleAlarm(new Date(Date.now() - 2000), { order: 2 });
      await stub.scheduleAlarm(new Date(Date.now() - 1000), { order: 3 });

      // Trigger only 2 alarms
      const executedIds = await stub.triggerAlarms(2);
      expect(executedIds.length).toBe(2);

      // Third alarm should still be in schedule
      const remaining = await stub.getSchedules();
      expect(remaining.length).toBe(1);
    });

    test('triggerAlarms returns empty array when no alarms exist', async () => {
      const stub = env.ALARM_TEST_DO.getByName('no-alarms-test');

      const executedIds = await stub.triggerAlarms();
      expect(executedIds.length).toBe(0);
    });
  });

  describe('Error Handling', () => {
    test('throws error for invalid schedule type', async () => {
      const stub = env.ALARM_TEST_DO.getByName('invalid-type-test');

      await expect(
        stub.scheduleAlarmWithInvalidType({ not: 'valid' }, { task: 'test' })
      ).rejects.toThrow('Invalid schedule type');
    });

    test('handles callback errors during execution gracefully', async () => {
      const stub = env.ALARM_TEST_DO.getByName('throwing-callback-test');

      const past1 = new Date(Date.now() - 2000);
      const past2 = new Date(Date.now() - 1000);

      // First alarm will throw, second should still execute
      await stub.scheduleThrowingAlarm(past1, { task: 'throws' });
      await stub.scheduleAlarm(past2, { task: 'succeeds' });

      // Trigger both - system should handle the error and continue
      await stub.triggerAlarms(2);

      const executed = await stub.getExecutedAlarms() as Array<{ payload: any }>;
      expect(executed.some(e => e.payload.task === 'succeeds')).toBe(true);
    });

    test('handles invalid cron expression', async () => {
      const stub = env.ALARM_TEST_DO.getByName('invalid-cron-test');

      await expect(
        stub.scheduleCronAlarm('not a valid cron', { task: 'invalid' })
      ).rejects.toThrow();
    });
  });

  describe('Edge Cases', () => {
    test('handles zero delay (immediate execution)', async () => {
      const stub = env.ALARM_TEST_DO.getByName('zero-delay-test');

      await stub.clearExecutedAlarms();

      // Schedule with 0 delay
      await stub.scheduleDelayedAlarm(0, { task: 'immediate' });

      // Trigger alarm
      const executed = await stub.triggerAlarms(1);
      expect(executed.length).toBe(1);

      const executedAlarms = await stub.getExecutedAlarms() as Array<{ payload: any }>;
      expect(executedAlarms.length).toBe(1);
      expect(executedAlarms[0].payload.task).toBe('immediate');
    });

    test('handles very large delay', async () => {
      const stub = env.ALARM_TEST_DO.getByName('large-delay-test');

      // Schedule with very large delay (1 year)
      const schedule = await stub.scheduleDelayedAlarm(31536000, { task: 'distant-future' });

      expect(schedule.id).toBeDefined();
      expect(schedule.type).toBe('delayed');
      expect((schedule as DelayedAlarm).delayInSeconds).toBe(31536000);
    });

    test('handles concurrent schedule operations', async () => {
      const stub = env.ALARM_TEST_DO.getByName('concurrent-test');

      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(stub.scheduleAlarm(new Date(Date.now() + (i + 1) * 1000), { task: `concurrent-${i}` }));
      }

      const schedules = await Promise.all(promises);
      expect(schedules.length).toBe(10);
      expect(schedules.every((s: Schedule) => s.id)).toBe(true);
    });
  });
});
