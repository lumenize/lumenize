/**
 * Simple DO for alarm-simulation pedagogical examples
 * Demonstrates native Cloudflare alarm API
 */
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';

export class MyDO extends DurableObject {
  ctx: DurableObjectState;
  env: any;
  taskStatus: string = 'idle';
  alarmFiredCount: number = 0;
  alarmRetryCount: number = 0;
  private failuresBeforeSuccess: number = 0;

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  // Standard Cloudflare alarm handler
  async alarm() {
    // Simulate failures for retry testing
    if (this.failuresBeforeSuccess > 0) {
      this.failuresBeforeSuccess--;
      this.alarmRetryCount++;
      throw new Error('Simulated alarm failure');
    }
    
    this.taskStatus = 'processing';
    await this.processScheduledTask();
    this.taskStatus = 'complete';
    this.alarmFiredCount++;
  }

  scheduleTask(delaySeconds: number) {
    // Standard Cloudflare alarm API
    const scheduledTime = Date.now() + (delaySeconds * 1000);
    this.ctx.storage.setAlarm(scheduledTime);
  }

  async processScheduledTask() {
    // Your task logic here
    await new Promise(resolve => setTimeout(resolve, 1));
  }

  // Test helpers
  async getAlarmState() {
    const scheduledTime = await this.ctx.storage.getAlarm();
    return { scheduledTime };
  }

  async getAlarmTime(): Promise<number | null> {
    return await this.ctx.storage.getAlarm();
  }

  setAlarmFailureCount(count: number) {
    this.failuresBeforeSuccess = count;
    this.alarmRetryCount = 0;
  }
}

