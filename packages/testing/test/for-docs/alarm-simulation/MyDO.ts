/**
 * Pedagogical example DO for alarm simulation docs
 */
export class MyDO {
  ctx: DurableObjectState;
  env: Env;
  taskStatus: string = 'idle';
  alarmFiredCount: number = 0;
  lastAlarmTime: number | null = null;
  alarmRetryCount: number = 0;
  shouldFailCount: number = 0;
  failuresRemaining: number = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  // Standard Cloudflare alarm handler
  async alarm() {
    // Simulate failures for retry testing
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
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

  getAlarmState() {
    const scheduledTime = (this.ctx.storage.getAlarm as any)() as number | null;
    return {
      firedCount: this.alarmFiredCount,
      scheduledTime
    };
  }

  getAlarmTime(): number | null {
    return (this.ctx.storage.getAlarm as any)() as number | null;
  }

  setAlarmFailureCount(count: number) {
    this.failuresRemaining = count;
    this.alarmRetryCount = 0;
  }
}

