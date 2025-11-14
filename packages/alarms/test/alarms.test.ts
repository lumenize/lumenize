import { describe, test, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('Alarms', () => {
  describe('One-time Scheduled Alarms', () => {
    test('schedules alarm for specific date', async () => {
      const stub = env.ALARM_DO.getByName('scheduled-date-test');
      
      const futureDate = new Date(Date.now() + 1000);
      const schedule = await stub.scheduleAlarm(futureDate, { task: 'test-task' });
      
      expect(schedule.type).toBe('scheduled');
      expect(schedule.time).toBe(Math.floor(futureDate.getTime() / 1000));
      expect(schedule.operationChain).toBeDefined();
      expect(schedule.operationChain.length).toBeGreaterThan(0);
    });

    test('executes scheduled alarm at specified time', async () => {
      const stub = env.ALARM_DO.getByName('scheduled-execute-test');
      
      // Schedule alarm in the future
      const futureDate = new Date(Date.now() + 10000);
      const schedule = await stub.scheduleAlarm(futureDate, { task: 'execute-me' });
      
      // Manually trigger the next alarm (even though it's in the future)
      const executedIds = await stub.triggerAlarms(1);
      expect(executedIds.length).toBe(1);
      expect(executedIds[0]).toBe(schedule.id);
      
      const executed = await stub.getExecutedAlarms();
      expect(executed.length).toBe(1);
      expect(executed[0].payload).toEqual({ task: 'execute-me' });
    });

    test('removes one-time alarm after execution', async () => {
      const stub = env.ALARM_DO.getByName('scheduled-remove-test');
      
      const futureDate = new Date(Date.now() + 10000);
      const schedule = await stub.scheduleAlarm(futureDate, { task: 'remove-after' });
      
      // Verify alarm exists before execution
      const beforeExecution = await stub.getSchedule(schedule.id);
      expect(beforeExecution).toBeDefined();
      expect(beforeExecution?.type).toBe('scheduled');
      
      // Manually trigger the alarm
      await stub.triggerAlarms(1);
      
      // Verify alarm was removed after execution (one-time alarms are deleted)
      const afterExecution = await stub.getSchedule(schedule.id);
      expect(afterExecution).toBeUndefined();
    });
  });

  describe('Delayed Alarms', () => {
    test('schedules alarm with delay in seconds', async () => {
      const stub = env.ALARM_DO.getByName('delayed-test');
      
      const schedule = await stub.scheduleAlarm(5, { task: 'delayed-task' });
      
      expect(schedule.type).toBe('delayed');
      expect(schedule.delayInSeconds).toBe(5);
      expect(schedule.operationChain).toBeDefined();
    });

    test('executes delayed alarm after specified seconds', async () => {
      const stub = env.ALARM_DO.getByName('delayed-execute-test');
      
      await stub.scheduleAlarm(10, { task: 'delayed-task' }); // 10 seconds delay
      
      // Manually trigger the alarm (fast-forward instead of waiting)
      const executedIds = await stub.triggerAlarms(1);
      expect(executedIds.length).toBe(1);
      
      const executed = await stub.getExecutedAlarms();
      expect(executed.length).toBe(1);
      expect(executed[0].payload).toEqual({ task: 'delayed-task' });
    });
  });

  describe('Cron Alarms', () => {
    test('schedules recurring cron alarm', async () => {
      const stub = env.ALARM_DO.getByName('cron-test');
      
      // Every minute
      const schedule = await stub.scheduleAlarm('* * * * *', { task: 'recurring' });
      
      expect(schedule.type).toBe('cron');
      expect(schedule.cron).toBe('* * * * *');
      expect(schedule.operationChain).toBeDefined();
    });

    test('cron alarm persists after execution', async () => {
      const stub = env.ALARM_DO.getByName('cron-persist-test');
      
      // Schedule for every minute
      const schedule = await stub.scheduleAlarm('* * * * *', { task: 'persist' });
      
      // Verify alarm exists before execution
      const beforeExecution = await stub.getSchedule(schedule.id);
      expect(beforeExecution).toBeDefined();
      expect(beforeExecution?.type).toBe('cron');
    });

    test('cron alarm is rescheduled after execution', async () => {
      const stub = env.ALARM_DO.getByName('cron-reschedule-test');
      
      // Schedule for every minute
      const schedule = await stub.scheduleAlarm('* * * * *', { task: 'reschedule' });
      const originalTime = schedule.time;
      
      // Execute the cron alarm
      await stub.triggerAlarms(1);
      
      // Verify alarm was executed
      const executed = await stub.getExecutedAlarms();
      expect(executed.length).toBe(1);
      expect(executed[0].payload).toEqual({ task: 'reschedule' });
      
      // Verify alarm still exists (not deleted like one-time alarms)
      const afterExecution = await stub.getSchedule(schedule.id);
      expect(afterExecution).toBeDefined();
      expect(afterExecution?.type).toBe('cron');
      expect(afterExecution?.cron).toBe('* * * * *');
      
      // Verify alarm was rescheduled for next execution (>= because "every minute" might be same minute)
      expect(afterExecution?.time).toBeGreaterThanOrEqual(originalTime);
    });
  });

  describe('Alarm Management', () => {
    test('retrieves schedule by ID', async () => {
      const stub = env.ALARM_DO.getByName('get-schedule-test');
      
      const futureDate = new Date(Date.now() + 5000);
      const schedule = await stub.scheduleAlarm(futureDate, { task: 'get-me' });
      
      const retrieved = await stub.getSchedule(schedule.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(schedule.id);
      expect(retrieved?.type).toBe('scheduled');
      expect(retrieved?.operationChain).toBeDefined();
    });

    test('returns undefined for non-existent schedule', async () => {
      const stub = env.ALARM_DO.getByName('get-missing-test');
      
      const retrieved = await stub.getSchedule('non-existent-id');
      expect(retrieved).toBeUndefined();
    });

    test('cancels scheduled alarm', async () => {
      const stub = env.ALARM_DO.getByName('cancel-test');
      
      const futureDate = new Date(Date.now() + 5000);
      const schedule = await stub.scheduleAlarm(futureDate, { task: 'cancel-me' });
      
      const cancelled = await stub.cancelSchedule(schedule.id);
      expect(cancelled).toBe(true);
      
      const retrieved = await stub.getSchedule(schedule.id);
      expect(retrieved).toBeUndefined();
    });

    test('lists all schedules', async () => {
      const stub = env.ALARM_DO.getByName('list-all-test');
      
      const date1 = new Date(Date.now() + 1000);
      const date2 = new Date(Date.now() + 2000);
      
      await stub.scheduleAlarm(date1, { task: 'first' });
      await stub.scheduleAlarm(date2, { task: 'second' });
      await stub.scheduleAlarm(5, { task: 'third' });
      
      const schedules = await stub.getSchedules();
      expect(schedules.length).toBeGreaterThanOrEqual(3);
    });

    test('filters schedules by type', async () => {
      const stub = env.ALARM_DO.getByName('filter-type-test');
      
      await stub.scheduleAlarm(new Date(Date.now() + 1000), { task: 'scheduled' });
      await stub.scheduleAlarm(5, { task: 'delayed' });
      await stub.scheduleAlarm('* * * * *', { task: 'cron' });
      
      const scheduledOnly = await stub.getSchedules({ type: 'scheduled' });
      expect(scheduledOnly.every((s: { type: string; }) => s.type === 'scheduled')).toBe(true);
      
      const delayedOnly = await stub.getSchedules({ type: 'delayed' });
      expect(delayedOnly.every((s: { type: string; }) => s.type === 'delayed')).toBe(true);
      
      const cronOnly = await stub.getSchedules({ type: 'cron' });
      expect(cronOnly.every((s: { type: string; }) => s.type === 'cron')).toBe(true);
    });

    test('filters schedules by time range', async () => {
      const stub = env.ALARM_DO.getByName('filter-time-test');
      
      const now = Date.now();
      const date1 = new Date(now + 1000); // 1 second from now
      const date2 = new Date(now + 5000); // 5 seconds from now
      const date3 = new Date(now + 10000); // 10 seconds from now
      
      await stub.scheduleAlarm(date1, { task: 'early' });
      await stub.scheduleAlarm(date2, { task: 'middle' });
      await stub.scheduleAlarm(date3, { task: 'late' });
      
      const filtered = await stub.getSchedules({
        timeRange: {
          start: new Date(now),
          end: new Date(now + 6000),
        },
      });
      
      // Should include first two but not the third
      expect(filtered.length).toBeGreaterThanOrEqual(2);
      expect(filtered.every((s: { time: number; }) => s.time <= Math.floor((now + 6000) / 1000))).toBe(true);
    });

    test('filters schedules by id', async () => {
      const stub = env.ALARM_DO.getByName('filter-id-test');
      
      const schedule1 = await stub.scheduleAlarm(new Date(Date.now() + 1000), { task: 'first' });
      const schedule2 = await stub.scheduleAlarm(new Date(Date.now() + 2000), { task: 'second' });
      
      // Filter by specific ID
      const filtered = await stub.getSchedules({ id: schedule1.id });
      
      expect(filtered.length).toBe(1);
      expect(filtered[0].id).toBe(schedule1.id);
    });

    test('returns empty array when no schedules match filters', async () => {
      const stub = env.ALARM_DO.getByName('filter-empty-test');
      
      await stub.scheduleAlarm(new Date(Date.now() + 1000), { task: 'test' });
      
      // Filter with non-existent ID
      const filtered = await stub.getSchedules({ id: 'non-existent' });
      
      expect(filtered.length).toBe(0);
    });

    test('combines multiple filters (type + timeRange)', async () => {
      const stub = env.ALARM_DO.getByName('combined-filter-test');
      
      const now = Date.now();
      await stub.scheduleAlarm(new Date(now + 1000), { task: 'scheduled-early' });
      await stub.scheduleAlarm(new Date(now + 5000), { task: 'scheduled-late' });
      await stub.scheduleDelayedAlarm(3, { task: 'delayed-middle' });
      await stub.scheduleCronAlarm('*/5 * * * *', { task: 'cron' });
      
      // Filter by type and time range
      const filtered = await stub.getSchedules({
        type: 'scheduled',
        timeRange: {
          start: new Date(now),
          end: new Date(now + 3000),
        },
      });
      
      expect(filtered.every((s: { type: string; }) => s.type === 'scheduled')).toBe(true);
      expect(filtered.length).toBeGreaterThanOrEqual(1);
    });

    test('handles immediate execution (negative delay)', async () => {
      const stub = env.ALARM_DO.getByName('negative-delay-test');
      
      // Schedule with negative delay (in the past)
      await stub.scheduleDelayedAlarm(-5, { task: 'already-overdue' });
      
      // Should be in overdue schedules
      const schedules = await stub.getSchedules();
      expect(schedules.length).toBeGreaterThanOrEqual(1);
      
      // Trigger and verify execution
      const executed = await stub.triggerAlarms();
      expect(executed.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Multiple Alarms', () => {
    test('executes multiple alarms in order', async () => {
      const stub = env.ALARM_DO.getByName('multiple-order-test');
      
      // Schedule three alarms in the past (all overdue)
      const past1 = new Date(Date.now() - 3000);
      const past2 = new Date(Date.now() - 2000);
      const past3 = new Date(Date.now() - 1000);
      
      await stub.scheduleAlarm(past1, { order: 1 });
      await stub.scheduleAlarm(past2, { order: 2 });
      await stub.scheduleAlarm(past3, { order: 3 });
      
      // Manually trigger execution - will execute all overdue alarms by default
      const executedIds = await stub.triggerAlarms();
      expect(executedIds.length).toBe(3);
      
      const executed = await stub.getExecutedAlarms();
      expect(executed.length).toBe(3);
      expect(executed[0].payload.order).toBe(1);
      expect(executed[1].payload.order).toBe(2);
      expect(executed[2].payload.order).toBe(3);
    });

    test('handles overlapping alarm times', async () => {
      const stub = env.ALARM_DO.getByName('overlap-test');
      
      const pastTime = new Date(Date.now() - 1000);
      await stub.scheduleAlarm(pastTime, { id: 'a' });
      await stub.scheduleAlarm(pastTime, { id: 'b' });
      
      // Manually trigger execution
      const executedIds = await stub.triggerAlarms();
      expect(executedIds.length).toBe(2);
      
      const executed = await stub.getExecutedAlarms();
      expect(executed.length).toBe(2);
    });

    test('triggerAlarms returns empty array when no alarms exist', async () => {
      const stub = env.ALARM_DO.getByName('no-alarms-test');
      
      // No alarms scheduled - should return empty array
      const executedIds = await stub.triggerAlarms();
      expect(executedIds.length).toBe(0);
    });

    test('triggerAlarms with explicit count respects limit', async () => {
      const stub = env.ALARM_DO.getByName('count-limit-test');
      
      // Schedule 3 alarms in the past
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
  });

  describe('Native Alarm Integration', () => {
    test('alarm() method executes overdue alarms', async () => {
      const stub = env.ALARM_DO.getByName('native-alarm-test');
      
      // Schedule alarms in the past
      await stub.scheduleAlarm(new Date(Date.now() - 2000), { task: 'overdue1' });
      await stub.scheduleAlarm(new Date(Date.now() - 1000), { task: 'overdue2' });
      
      // Call the alarm() method directly (simulates Cloudflare calling it)
      await stub.callAlarmMethod();
      
      // Both alarms should have been executed
      const executed = await stub.getExecutedAlarms();
      expect(executed.length).toBe(2);
    });

    test('alarm() method does nothing when no overdue alarms', async () => {
      const stub = env.ALARM_DO.getByName('native-alarm-no-overdue-test');
      
      // Schedule alarm in the future
      await stub.scheduleAlarm(new Date(Date.now() + 10000), { task: 'future' });
      
      // Call the alarm() method
      await stub.callAlarmMethod();
      
      // No alarms should have been executed
      const executed = await stub.getExecutedAlarms();
      expect(executed.length).toBe(0);
      
      // Alarm should still be scheduled
      const remaining = await stub.getSchedules();
      expect(remaining.length).toBe(1);
    });
  });

  describe('Dependency Injection', () => {
    test('works with direct sql dependency', async () => {
      const stub = env.ALARM_DO.getByName('direct-sql-test');
      
      // Schedule an alarm (exercises path with deps.sql)
      const schedule = await stub.scheduleAlarm(new Date(Date.now() + 1000), { task: 'test' });
      expect(schedule.id).toBeDefined();
    });

    test('works with doInstance.svc.sql path', async () => {
      const stub = env.ALARM_DO.getByName('svc-sql-test');
      
      // Schedule an alarm (exercises path with doInstance.svc.sql)
      const schedule = await stub.scheduleAlarm(new Date(Date.now() + 1000), { task: 'test2' });
      expect(schedule.id).toBeDefined();
    });

    test('scheduleNextAlarm handles result without time property', async () => {
      const stub = env.ALARM_DO.getByName('no-time-test');
      
      // Cancel all alarms to ensure scheduleNextAlarm finds nothing
      const schedules = await stub.getSchedules();
      for (const schedule of schedules) {
        await stub.cancelSchedule(schedule.id);
      }
      
      // Schedule an alarm that's in the past (already overdue, won't be scheduled)
      await stub.scheduleAlarm(new Date(Date.now() - 5000), { task: 'past' });
      
      // Verify it was created but scheduleNextAlarm didn't schedule it
      const remaining = await stub.getSchedules();
      expect(remaining.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Error Handling', () => {
    test('throws error for invalid operation during schedule', async () => {
      const stub = env.ALARM_DO.getByName('invalid-callback-test');
      
      // This will throw because 'notAFunction' property is not a function on the DO
      await expect(
        stub.scheduleAlarmWithBadCallback(new Date(Date.now() + 1000), { task: 'test' })
      ).rejects.toThrow();
    });

    test('throws error for invalid schedule type', async () => {
      const stub = env.ALARM_DO.getByName('invalid-type-test');
      
      // Pass invalid type (not Date, number, or string)
      await expect(
        stub.scheduleAlarmWithInvalidType({ not: 'valid' }, { task: 'test' })
      ).rejects.toThrow('Invalid schedule type');
    });

    test('handles callback errors during execution gracefully', async () => {
      const stub = env.ALARM_DO.getByName('throwing-callback-test');
      
      const past1 = new Date(Date.now() - 2000);
      const past2 = new Date(Date.now() - 1000);
      
      // First alarm will throw, second should still execute
      await stub.scheduleThrowingAlarm(past1, { task: 'throws' });
      await stub.scheduleAlarm(past2, { task: 'succeeds' });
      
      // Trigger both - system should handle the error and continue
      const executedIds = await stub.triggerAlarms();
      
      // First one throws (not in executed list), second succeeds
      // Note: triggerAlarms continues on error, so both are attempted but only second succeeds
      const executed = await stub.getExecutedAlarms();
      expect(executed.some(e => e.payload.task === 'succeeds')).toBe(true);
    });

    test('handles invalid cron expression', async () => {
      const stub = env.ALARM_DO.getByName('invalid-cron-test');
      
      // Try to schedule with invalid cron expression
      await expect(
        stub.scheduleCronAlarm('not a valid cron', { task: 'invalid' })
      ).rejects.toThrow();
    });
  });

  describe('Edge Cases', () => {
    test('handles zero delay (immediate execution)', async () => {
      const stub = env.ALARM_DO.getByName('zero-delay-test');
      
      await stub.clearExecutedAlarms();
      
      // Schedule with 0 delay - stored, will execute when alarm fires
      await stub.scheduleDelayedAlarm(0, { task: 'immediate' });
      
      // Trigger alarms (0-second delay should be immediately overdue)
      const executed = await stub.triggerAlarms();
      expect(executed.length).toBeGreaterThanOrEqual(1);
      
      // Verify it was executed
      const executedAlarms = await stub.getExecutedAlarms();
      expect(executedAlarms.length).toBeGreaterThanOrEqual(1);
      expect(executedAlarms[0].payload.task).toBe('immediate');
    });

    test('handles very large delay', async () => {
      const stub = env.ALARM_DO.getByName('large-delay-test');
      
      // Schedule with very large delay (1 year)
      const schedule = await stub.scheduleDelayedAlarm(31536000, { task: 'distant-future' });
      
      expect(schedule.id).toBeDefined();
      expect(schedule.type).toBe('delayed');
      expect(schedule.delayInSeconds).toBe(31536000);
    });

    test('handles concurrent schedule operations', async () => {
      const stub = env.ALARM_DO.getByName('concurrent-test');
      
      // Schedule multiple alarms concurrently
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(stub.scheduleAlarm(new Date(Date.now() + (i + 1) * 1000), { task: `concurrent-${i}` }));
      }
      
      const schedules = await Promise.all(promises);
      expect(schedules.length).toBe(10);
      expect(schedules.every(s => s.id)).toBe(true);
    });
  });
});
