import { DurableObject } from 'cloudflare:workers';
// @ts-expect-error For some reason this import is not always recognized
import { Env } from 'cloudflare:test';
import { sql, newContinuation } from '@lumenize/core';
import { Alarms, type Schedule } from '../src/alarms';
import { enableAlarmSimulation } from '@lumenize/testing';

// Export DOs for documentation examples
export { TaskSchedulerDO } from './for-docs/basic-usage.test';
export { MyDO as StandalonePatternDO } from './for-docs/standalone-pattern.test';
export { MyDO as LumenizeBasePatternDO } from './for-docs/lumenize-base-pattern.test';

export class AlarmDO extends DurableObject<Env> {
  #alarms: Alarms;
  #sql = sql(this);
  executedAlarms: Array<{ payload: any }> = [];

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

  // Helper to create continuations (like this.ctn() in LumenizeBase)
  ctn<T = this>(): T {
    return newContinuation<T>();
  }

  // Test helper: Schedule an alarm
  scheduleAlarm(when: Date | string | number, payload?: any) {
    return this.#alarms.schedule(when, this.ctn().handleAlarm(payload));
  }

  // Test helper: Get a schedule by ID
  getSchedule(id: string) {
    return this.#alarms.getSchedule(id);
  }

  // Test helper: Get all schedules
  getSchedules(criteria?: Parameters<typeof this.#alarms.getSchedules>[0]) {
    return this.#alarms.getSchedules(criteria);
  }

  // Test helper: Cancel a schedule
  cancelSchedule(id: string) {
    return this.#alarms.cancelSchedule(id);
  }

  // Alarm callback - gets called when an alarm fires
  handleAlarm(payload: any) {
    this.executedAlarms.push({ payload });
  }

  // Test helper: Schedule alarm with invalid callback (not a function)
  scheduleAlarmWithBadCallback(when: Date | string | number, payload?: any) {
    // Force schedule with an invalid operation chain
    return this.#alarms.schedule(when, this.ctn().notAFunction(payload));
  }

  // Alarm callback that throws an error
  handleThrowingAlarm(payload: any) {
    throw new Error('Intentional error from alarm callback');
  }

  // Test helper: Schedule an alarm with a throwing callback
  scheduleThrowingAlarm(when: Date | string | number, payload?: any) {
    return this.#alarms.schedule(when, this.ctn().handleThrowingAlarm(payload));
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
