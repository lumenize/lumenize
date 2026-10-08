/**
 * The Durable Object `basic-usage.test.ts` drives, apart from the test so the test worker can
 * export it: a worker that imported the test file would register its suite in every test file
 * that loads the worker. Alarms is a built-in service in `LumenizeDO`, so nothing else is imported.
 */
import { UnscopedMeshDO } from '@lumenize/mesh';

// Example: Task scheduling DO
class TaskSchedulerDO extends UnscopedMeshDO<Env> {
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

  // Test helper: Trigger alarms manually for testing
  async triggerAlarms(count?: number) {
    return await this.svc.alarms.triggerAlarms(count);
  }

  // Alarm callbacks - no @mesh decorator needed since alarms are local
  handleTask(payload: { name: string }) {
    this.executedTasks.push({
      name: payload.name,
      time: Date.now(),
    });
  }

  handleRecurringTask(payload: { name: string }) {
    this.executedTasks.push({
      name: `recurring:${payload.name}`,
      time: Date.now(),
    });
  }

  // Test helper
  getExecutedTasks() {
    return this.executedTasks;
  }
}

export { TaskSchedulerDO };
