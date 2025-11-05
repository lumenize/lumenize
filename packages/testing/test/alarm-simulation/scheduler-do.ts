/**
 * DO for alarm-simulation pedagogical examples
 * Demonstrates @cloudflare/actors Alarms package
 */
import { Actor } from '@cloudflare/actors';

export class SchedulerDO extends Actor<any> {
  private alarmsFiredCount: number = 0;
  
  // Required: delegate to Actor's alarm system
  async alarm() {
    await this.alarms.alarm();
  }

  // Your alarm handler
  async handleAlarm(payload: any) {
    this.alarmsFiredCount++;
  }

  async scheduleMultiple() {
    // Actor Alarms lets you schedule multiple alarms
    await this.alarms.schedule(5, 'handleAlarm', { task: 'first' });
    await this.alarms.schedule(10, 'handleAlarm', { task: 'second' });
    await this.alarms.schedule(15, 'handleAlarm', { task: 'third' });
    
    // All three will fire automatically in tests!
  }
  
  getAlarmsFiredCount(): number {
    return this.alarmsFiredCount;
  }
}

