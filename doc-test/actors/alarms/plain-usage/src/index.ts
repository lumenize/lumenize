import { Storage } from "@cloudflare/actors/storage";
import { Alarms, type Schedule } from "@cloudflare/actors/alarms";
import { DurableObject } from "cloudflare:workers";

export class AlarmDO extends DurableObject<Env> {
  storage: Storage;
  alarms: Alarms<this>;
  executedAlarms: string[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = new Storage(ctx.storage);
    this.alarms = new Alarms(ctx, this);
  }

  // Required boilerplate: delegate to Alarms instance
  async alarm() {
    await this.alarms.alarm();
  }

  // Callback for alarms - gets called when an alarm fires
  async handleAlarm(payload: any, schedule: Schedule) {
    const message = `Alarm ${schedule.id} fired: ${JSON.stringify(payload)}`;
    this.executedAlarms.push(message);
  }

  // Method to get executed alarms (for testing)
  getExecutedAlarms(): string[] {
    return this.executedAlarms;
  }

  // Method to clear executed alarms (for testing)
  clearExecutedAlarms(): void {
    this.executedAlarms = [];
  }
}

// No default export needed - the test harness handles everything

