/**
 * Simple DO for alarm-simulation pedagogical examples
 * Demonstrates native Cloudflare alarm API
 */
import type { DurableObjectState } from '@cloudflare/workers-types';

export class MyDO {
  ctx: DurableObjectState;
  env: Env;
  taskStatus: string = 'idle';
  alarmFiredCount: number = 0;
  alarmRetryCount: number = 0;
  private failuresBeforeSuccess: number = 0;

  constructor(ctx: DurableObjectState, env: Env) {
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
  }

  // Test helpers below this line
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
