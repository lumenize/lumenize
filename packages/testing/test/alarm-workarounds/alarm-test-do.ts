/**
 * Test DO for alarm workarounds documentation
 * Demonstrates using @lumenize/alarms with triggerAlarms() for testing
 */
import { Alarms } from '@lumenize/alarms';
import { sql } from '@lumenize/core';
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';

export class AlarmTestDO extends DurableObject {
  #alarms: Alarms;
  #executedTasks: Array<{ id: string; delay: number }> = [];

  constructor(
    ctx: DurableObjectState,
    env: any
  ) {
    super(ctx, env);
    this.#alarms = new Alarms(ctx, this, { sql: sql(this) });
  }

  // Required: delegate to Alarms
  async alarm() {
    await this.#alarms.alarm();
  }

  async scheduleTask(taskId: string, delaySeconds: number) {
    await this.#alarms.schedule(delaySeconds, 'handleTask', { taskId, delaySeconds });
  }

  async handleTask(payload: { taskId: string; delaySeconds: number }) {
    this.#executedTasks.push({ id: payload.taskId, delay: payload.delaySeconds });
  }

  async getExecutedTasks() {
    return this.#executedTasks;
  }

  async getExecutedAlarms() {
    return this.#executedTasks;
  }

  // Expose triggerAlarms for testing
  async triggerAlarms(count?: number) {
    return await this.#alarms.triggerAlarms(count);
  }
}

