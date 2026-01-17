// @ts-expect-error For some reason this import is not always recognized
import { Env } from 'cloudflare:test';
import '@lumenize/core';    // Registers sql in this.svc
import '@lumenize/alarms';  // Registers alarms in this.svc (depends on sql)
import { LumenizeDO } from '@lumenize/mesh';
import type { Schedule } from '../src/alarms';

// Export DOs for documentation examples
export { TaskSchedulerDO } from './for-docs/basic-usage.test';
export { MyDO as LumenizeBasePatternDO } from './for-docs/lumenize-base-pattern.test';

export class AlarmDO extends LumenizeDO<Env> {
  executedAlarms: Array<{ payload: any }> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // Required: delegate to Alarms (NADIS pattern)
  async alarm() {
    await this.svc.alarms.alarm();
  }

  // Test helper: Schedule an alarm
  scheduleAlarm(when: Date | string | number, payload?: any) {
    return this.svc.alarms.schedule(when, this.ctn().handleAlarm(payload));
  }

  // Test helper: Schedule a delayed alarm (by seconds)
  scheduleDelayedAlarm(delayInSeconds: number, payload?: any) {
    return this.svc.alarms.schedule(delayInSeconds, this.ctn().handleAlarm(payload));
  }

  // Test helper: Schedule a cron alarm
  scheduleCronAlarm(cronExpression: string, payload?: any) {
    return this.svc.alarms.schedule(cronExpression, this.ctn().handleAlarm(payload));
  }

  // Test helper: Get a schedule by ID
  getSchedule(id: string) {
    return this.svc.alarms.getSchedule(id);
  }

  // Test helper: Get all schedules
  getSchedules(criteria?: Parameters<typeof this.svc.alarms.getSchedules>[0]) {
    return this.svc.alarms.getSchedules(criteria);
  }

  // Test helper: Cancel a schedule
  cancelSchedule(id: string) {
    return this.svc.alarms.cancelSchedule(id);
  }

  // Alarm callback - gets called when an alarm fires
  handleAlarm(payload: any) {
    this.executedAlarms.push({ payload });
  }

  // Test helper: Schedule alarm with invalid callback (not a function)
  scheduleAlarmWithBadCallback(when: Date | string | number, payload?: any) {
    // Force schedule with an invalid operation chain
    return this.svc.alarms.schedule(when, this.ctn().notAFunction(payload));
  }

  scheduleAlarmWithInvalidType(when: any, payload?: any) {
    // Force schedule with an invalid when type (not Date, number, or string)
    return this.svc.alarms.schedule(when, this.ctn().handleAlarm(payload));
  }

  // Alarm callback that throws an error
  handleThrowingAlarm(payload: any) {
    throw new Error('Intentional error from alarm callback');
  }

  // Test helper: Schedule an alarm with a throwing callback
  scheduleThrowingAlarm(when: Date | string | number, payload?: any) {
    return this.svc.alarms.schedule(when, this.ctn().handleThrowingAlarm(payload));
  }

  // Test helper: Get executed alarms
  async getExecutedAlarms() {
    return this.executedAlarms;
  }

  // Test helper: Clear executed alarms
  async clearExecutedAlarms() {
    this.executedAlarms = [];
  }

  // Test helper: Manually trigger alarms for testing
  async triggerAlarms(count?: number) {
    return await this.svc.alarms.triggerAlarmsForTesting(count);
  }

  // Test helper: Call the alarm() method (simulates Cloudflare calling it)
  async callAlarmMethod() {
    await this.svc.alarms.alarm();
  }
  
  // Property to intentionally test invalid callback (not a function)
  notAFunction = 'this is not a function';
}

// Default export for worker
export default {
  async fetch(request: Request, env: Env) {
    return new Response('OK');
  },
};
