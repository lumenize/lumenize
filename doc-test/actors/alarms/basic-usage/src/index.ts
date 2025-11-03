import { Actor } from "@cloudflare/actors";
import { type Schedule } from "@cloudflare/actors/alarms";

export class AlarmDO extends Actor<Env> {
  executedAlarms: string[] = [];

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

