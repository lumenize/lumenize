/**
 * Pedagogical tests for @lumenize/alarms documentation examples
 * These tests are referenced in website/docs/alarms/*.mdx files
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import '@lumenize/core';    // Registers sql in this.svc
import '@lumenize/alarms';  // Registers alarms in this.svc (depends on sql)
import { LumenizeBase } from '@lumenize/lumenize-base';
import type { Schedule } from '@lumenize/alarms';

// Example: Task scheduling DO
class TaskSchedulerDO extends LumenizeBase<any> {
  executedTasks: Array<{ name: string; time: number }> = [];

  // Schedule a task - seconds from now
  scheduleTask(taskName: string, delaySeconds: number) {
    const schedule = this.svc.alarms.schedule(
      delaySeconds,  // a number
      this.ctn().handleTask({ name: taskName })  // OCAN chain
    );
    return { scheduled: true, taskName, id: schedule.id };
  }

  // Schedule task at specific time
  scheduleAt(taskName: string, timestamp: number) {
    const schedule = this.svc.alarms.schedule(
      new Date(timestamp),  // a Date
      this.ctn().handleTask({ name: taskName })  // OCAN chain
    );
    return { scheduled: true, taskName, id: schedule.id };
  }

  // Schedule a recurring task with cron
  scheduleRecurringTask(taskName: string) {
    const schedule = this.svc.alarms.schedule(
      '0 0 * * *',  // cron expression (daily at midnight)
      this.ctn().handleRecurringTask({ name: taskName })  // OCAN chain
    );
    return { scheduled: true, taskName, recurring: true, id: schedule.id };
  }

  // Schedule a task and return its ID (for later cancellation)
  scheduleTaskForCancellation(taskName: string, delaySeconds: number) {
    const schedule = this.svc.alarms.schedule(
      delaySeconds,  // a number
      this.ctn().handleTask({ name: taskName })  // OCAN chain
    );
    return { scheduled: true, scheduleId: schedule.id };
  }
  
  // Cancel a scheduled task (separate request)
  cancelScheduledTask(scheduleId: string) {
    const cancelled = this.svc.alarms.cancelSchedule(scheduleId);
    return { cancelled: cancelled !== undefined, scheduleId, cancelledData: cancelled };
  }

  // Get all scheduled tasks
  getScheduledTasks() {
    return this.svc.alarms.getSchedules();
  }

  // Alarm callbacks
  handleTask(payload: any) {
    console.log(payload);
    // payload: { name: 'send-email' }
    this.executedTasks.push({
      name: payload.name,
      time: Date.now(),
    });
  }

  handleRecurringTask(payload: any) {
    console.log(payload);
    // payload: { name: 'daily-report' }
    this.executedTasks.push({
      name: `recurring:${payload.name}`,
      time: Date.now(),
    });
  }

  // Test helper
  getExecutedTasks() {
    return this.executedTasks;
  }

  // Required: Cloudflare alarm handler
  async alarm() {
    await this.svc.alarms.alarm();
  }
}

export { TaskSchedulerDO };

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
    expect(scheduled.find((s: any) => s.id === scheduleResult.scheduleId)).toBeUndefined();
  });

  it('lists all scheduled tasks', async () => {
    const stub = env.TASK_SCHEDULER_DO.getByName('list-test');
    
    await stub.scheduleTask('task1', 10);
    await stub.scheduleTask('task2', 20);
    
    const scheduled = await stub.getScheduledTasks();
    expect(scheduled.length).toBeGreaterThanOrEqual(2);
  });
});
