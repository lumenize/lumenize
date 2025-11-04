import { DurableObject } from 'cloudflare:workers';
// @ts-expect-error For some reason this import is not always recognized
import { Env } from 'cloudflare:test';
import { sql } from '@lumenize/core';
import { Alarms, type Schedule } from '../src/alarms';
import { enableAlarmSimulation } from '@lumenize/testing';

// Export TaskSchedulerDO for documentation examples
export { TaskSchedulerDO } from './for-docs/basic-usage.test';

export class AlarmDO extends DurableObject<Env> {
  #alarms: Alarms<AlarmDO>;
  #sql = sql(this);
  executedAlarms: Array<{ payload: any; schedule: Schedule }> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Enable alarm simulation BEFORE creating Alarms (so it captures mocked methods)
    enableAlarmSimulation(ctx, this, { timeScale: 100 });
    this.#alarms = new Alarms(ctx, this, { sql: this.#sql });
  }

  // Required: delegate to Alarms
  async alarm() {
    await this.#alarms.alarm();
  }

  // Test helper: Schedule an alarm
  async scheduleAlarm(when: Date | string | number, payload?: any) {
    return await this.#alarms.schedule(when, 'handleAlarm', payload);
  }

  // Test helper: Get a schedule by ID
  async getSchedule(id: string) {
    return await this.#alarms.getSchedule(id);
  }

  // Test helper: Get all schedules
  async getSchedules(criteria?: Parameters<typeof this.#alarms.getSchedules>[0]) {
    return this.#alarms.getSchedules(criteria);
  }

  // Test helper: Cancel a schedule
  async cancelSchedule(id: string) {
    return await this.#alarms.cancelSchedule(id);
  }

  // Alarm callback - gets called when an alarm fires
  async handleAlarm(payload: any, schedule: Schedule) {
    this.executedAlarms.push({ payload, schedule });
  }

  // Test helper: Schedule alarm with invalid callback (not a function)
  async scheduleAlarmWithBadCallback(when: Date | string | number, payload?: any) {
    // Force schedule with a non-function callback property
    return await this.#alarms.schedule(when, 'notAFunction' as any, payload);
  }

  // Alarm callback that throws an error
  async handleThrowingAlarm(payload: any, schedule: Schedule) {
    throw new Error('Intentional error from alarm callback');
  }

  // Test helper: Schedule an alarm with a throwing callback
  async scheduleThrowingAlarm(when: Date | string | number, payload?: any) {
    return await this.#alarms.schedule(when, 'handleThrowingAlarm', payload);
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
    return await this.#alarms.triggerAlarms(count);
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

