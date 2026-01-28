/**
 * ReminderDO - Demonstrates alarm scheduling patterns
 *
 * Example DO for alarms.mdx documentation
 */

import { LumenizeDO, mesh } from '../../../src/index.js';

export class ReminderDO extends LumenizeDO<Env> {
  // ============================================
  // Quick Start pattern: Schedule a follow-up reminder
  // ============================================

  @mesh()
  scheduleFollowUp(email: string, delaySeconds: number) {
    this.svc.alarms.schedule(
      delaySeconds,
      this.ctn().sendFollowUpEmail(email)
    );
  }

  // Handler executes when alarm fires
  // No @mesh decorator needed - alarms are internal
  sendFollowUpEmail(email: string) {
    this.ctx.storage.kv.put('lastEmailSent', email);
  }

  // ============================================
  // Scheduling patterns: delayed, scheduled, cron
  // ============================================

  @mesh()
  scheduleDelayedReminder(message: string, delaySeconds: number) {
    // Schedule task for N seconds from now
    this.svc.alarms.schedule(
      delaySeconds,
      this.ctn().handleReminder(message)
    );
  }

  @mesh()
  scheduleAtTime(message: string, when: Date) {
    // Schedule at a specific date/time
    this.svc.alarms.schedule(
      when,
      this.ctn().handleReminder(message)
    );
  }

  @mesh()
  scheduleDailyDigest() {
    // Daily at midnight UTC
    this.svc.alarms.schedule(
      '0 0 * * *',
      this.ctn().handleDailyDigest()
    );
  }

  handleReminder(message: string) {
    const reminders: string[] = this.ctx.storage.kv.get('reminders') ?? [];
    reminders.push(message);
    this.ctx.storage.kv.put('reminders', reminders);
  }

  handleDailyDigest() {
    this.ctx.storage.kv.put('lastDigestRun', Date.now());
  }

  // ============================================
  // Rich context: structured-cloneable types
  // ============================================

  @mesh()
  scheduleWithRichContext(str: string, date: Date, set: Set<number>) {
    this.svc.alarms.schedule(
      60,
      this.ctn().handleRichContext(str, date, set)
    );
  }

  handleRichContext(str: string, date: Date, set: Set<number>) {
    this.ctx.storage.kv.put('richContext', { str, date, setSize: set.size });
  }

  // ============================================
  // Managing schedules: get, list, cancel
  // ============================================

  @mesh()
  scheduleAndReturnInfo(message: string, delaySeconds: number) {
    const schedule = this.svc.alarms.schedule(
      delaySeconds,
      this.ctn().handleReminder(message)
    );
    return schedule;
  }

  @mesh()
  getScheduleById(id: string) {
    return this.svc.alarms.getSchedule(id);
  }

  @mesh()
  getAllSchedules() {
    return this.svc.alarms.getSchedules();
  }

  @mesh()
  getSchedulesPatterns() {
    // Get all schedules
    const all = this.svc.alarms.getSchedules();

    // Get only cron schedules
    const crons = this.svc.alarms.getSchedules({ type: 'cron' });

    // Get schedules in time range
    const upcoming = this.svc.alarms.getSchedules({
      timeRange: { start: new Date(), end: new Date(Date.now() + 3600000) }
    });

    return { all, crons, upcoming };
  }

  @mesh()
  cancelScheduleById(id: string) {
    return this.svc.alarms.cancelSchedule(id);
  }

  // ============================================
  // Retry with backoff pattern
  // ============================================

  @mesh()
  startTaskWithRetry(taskName: string, maxRetries = 3) {
    this.svc.alarms.schedule(
      1, // Initial delay of 1 second
      this.ctn().executeWithRetry(taskName, 0, maxRetries)
    );
  }

  executeWithRetry(taskName: string, attempt: number, maxRetries: number) {
    // Simulate a task that might fail
    const shouldFail = this.ctx.storage.kv.get<boolean>('simulateFailure') ?? false;

    if (shouldFail && attempt < maxRetries) {
      // Task failed, schedule retry with exponential backoff
      const backoffSeconds = 2 * Math.pow(2, attempt); // 2s, 4s, 8s
      this.ctx.storage.kv.put('lastAttempt', { taskName, attempt, backoffSeconds });

      this.svc.alarms.schedule(
        backoffSeconds,
        this.ctn().executeWithRetry(taskName, attempt + 1, maxRetries)
      );
    } else {
      // Success or max retries reached
      this.ctx.storage.kv.put('taskCompleted', { taskName, attempt, success: !shouldFail });
    }
  }

  // ============================================
  // Testing support: trigger alarms manually
  // ============================================

  @mesh()
  triggerAlarmsForTest(count?: number) {
    return this.svc.alarms.triggerAlarms(count);
  }
}
