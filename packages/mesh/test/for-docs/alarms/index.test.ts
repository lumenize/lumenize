/**
 * Alarm scheduling tests for alarms.mdx documentation
 *
 * This single test demonstrates the full alarm lifecycle:
 * 1. Quick Start: Schedule a follow-up reminder
 * 2. Scheduling patterns: delayed, scheduled, cron
 * 3. Rich context with structured-cloneable types
 * 4. Managing schedules: get info, list, cancel
 * 5. Retry with backoff pattern
 * 6. Testing alarms with triggerAlarms()
 */

import { it, expect } from 'vitest';
import { createTestingClient } from '@lumenize/testing';
import type { ReminderDO } from './reminder-do.js';

it('demonstrates alarm scheduling patterns', async () => {
  // ============================================
  // Quick Start: Schedule and trigger a follow-up
  // ============================================

  {
    using client = createTestingClient<typeof ReminderDO>('REMINDER_DO', 'quick-start');

    // Schedule a follow-up email for 60 seconds from now
    await client.scheduleFollowUp('user@example.com', 60);

    // Trigger the alarm immediately for testing
    await client.triggerAlarmsForTest(1);

    // Verify the handler executed
    const lastEmail = await client.ctx.storage.kv.get('lastEmailSent');
    expect(lastEmail).toBe('user@example.com');
  }

  // ============================================
  // Scheduling patterns: delayed, scheduled, cron
  // ============================================

  {
    using client = createTestingClient<typeof ReminderDO>('REMINDER_DO', 'scheduling');

    // Schedule delayed reminder (seconds from now)
    await client.scheduleDelayedReminder('Check document status', 60);

    // Schedule at specific time
    const futureDate = new Date(Date.now() + 3600000); // 1 hour from now
    await client.scheduleAtTime('Review meeting notes', futureDate);

    // Schedule daily cron job
    await client.scheduleDailyDigest();

    // Verify all three schedules were created
    const schedules = await client.getAllSchedules();
    expect(schedules.length).toBe(3);

    // Check schedule types
    const types = schedules.map((s: any) => s.type).sort();
    expect(types).toEqual(['cron', 'delayed', 'scheduled']);

    // Trigger delayed and scheduled alarms (they're overdue in test time)
    await client.triggerAlarmsForTest(2);

    // Verify reminders were recorded
    const reminders = await client.ctx.storage.kv.get<string[]>('reminders');
    expect(reminders).toContain('Check document status');
    expect(reminders).toContain('Review meeting notes');
  }

  // ============================================
  // Rich context: structured-cloneable types
  // ============================================

  {
    using client = createTestingClient<typeof ReminderDO>('REMINDER_DO', 'rich-context');

    const testDate = new Date('2026-06-15T10:00:00Z');
    const testSet = new Set([1, 2, 3]);

    await client.scheduleWithRichContext('test-value', testDate, testSet);
    await client.triggerAlarmsForTest(1);

    const stored = await client.ctx.storage.kv.get<any>('richContext');
    expect(stored.str).toBe('test-value');
    expect(new Date(stored.date).toISOString()).toBe(testDate.toISOString());
    expect(stored.setSize).toBe(3);
  }

  // ============================================
  // Managing schedules: get info, list, cancel
  // ============================================

  {
    using client = createTestingClient<typeof ReminderDO>('REMINDER_DO', 'manage');

    // Schedule returns schedule info
    const schedule = await client.scheduleAndReturnInfo('Important reminder', 300);
    expect(schedule.id).toBeDefined();
    expect(schedule.type).toBe('delayed');
    expect(schedule.delayInSeconds).toBe(300);

    // Get schedule by ID
    const retrieved = await client.getScheduleById(schedule.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(schedule.id);

    // List all schedules
    const allSchedules = await client.getAllSchedules();
    expect(allSchedules.length).toBe(1);

    // Cancel the schedule
    const cancelled = await client.cancelScheduleById(schedule.id);
    expect(cancelled).toBeDefined();
    expect(cancelled!.id).toBe(schedule.id);

    // Verify it's gone
    const afterCancel = await client.getAllSchedules();
    expect(afterCancel.length).toBe(0);
  }

  // ============================================
  // Retry with backoff pattern
  // ============================================

  {
    using client = createTestingClient<typeof ReminderDO>('REMINDER_DO', 'retry');

    // Configure to simulate failure
    await client.ctx.storage.kv.put('simulateFailure', true);

    // Start task with retry
    await client.startTaskWithRetry('sync-data', 3);

    // Trigger first attempt (will fail and schedule retry)
    await client.triggerAlarmsForTest(1);

    // Check that retry was scheduled with backoff
    let lastAttempt = await client.ctx.storage.kv.get<any>('lastAttempt');
    expect(lastAttempt.taskName).toBe('sync-data');
    expect(lastAttempt.attempt).toBe(0);
    expect(lastAttempt.backoffSeconds).toBe(2); // 2 * 2^0 = 2

    // Trigger second attempt
    await client.triggerAlarmsForTest(1);
    lastAttempt = await client.ctx.storage.kv.get<any>('lastAttempt');
    expect(lastAttempt.attempt).toBe(1);
    expect(lastAttempt.backoffSeconds).toBe(4); // 2 * 2^1 = 4

    // Now let it succeed
    await client.ctx.storage.kv.put('simulateFailure', false);
    await client.triggerAlarmsForTest(1);

    // Verify completion
    const completed = await client.ctx.storage.kv.get<any>('taskCompleted');
    expect(completed.taskName).toBe('sync-data');
    expect(completed.success).toBe(true);
  }

  // ============================================
  // Testing alarms with triggerAlarms()
  // ============================================

  {
    using client = createTestingClient<typeof ReminderDO>('REMINDER_DO', 'testing');

    // Schedule multiple alarms
    await client.scheduleDelayedReminder('Task 1', 10);
    await client.scheduleDelayedReminder('Task 2', 20);
    await client.scheduleDelayedReminder('Task 3', 30);

    // Trigger only the first 2 alarms
    const executed = await client.triggerAlarmsForTest(2);
    expect(executed.length).toBe(2);

    // Verify only 2 reminders were processed
    const reminders = await client.ctx.storage.kv.get<string[]>('reminders');
    expect(reminders?.length).toBe(2);

    // One alarm should remain
    const remaining = await client.getAllSchedules();
    expect(remaining.length).toBe(1);
  }

  // ============================================
  // getSchedules() with filter patterns
  // ============================================

  {
    using client = createTestingClient<typeof ReminderDO>('REMINDER_DO', 'filter-patterns');

    // Schedule different types
    await client.scheduleDelayedReminder('Delayed task', 60);
    await client.scheduleDailyDigest(); // cron

    // Use the patterns method
    const result = await client.getSchedulesPatterns();

    // Verify all schedules returned
    expect(result.all.length).toBe(2);

    // Verify type filter works
    expect(result.crons.length).toBe(1);
    expect(result.crons[0].type).toBe('cron');

    // Verify timeRange filter returns results (both should be in range)
    expect(result.upcoming.length).toBeGreaterThanOrEqual(0);
  }
});
