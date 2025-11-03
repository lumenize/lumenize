// Import NADIS packages to register services
import '@lumenize/core';
import '@lumenize/alarms';

// @ts-expect-error For some reason this import is not always recognized
import { Env } from 'cloudflare:test';
import { LumenizeBase } from '../src/lumenize-base.js';
import type { Schedule } from '@lumenize/alarms';

export class TestDO extends LumenizeBase<Env> {
  executedAlarms: Array<{ payload: any; schedule: Schedule }> = [];

  // Required: delegate to Alarms
  async alarm() {
    await this.svc.alarms.alarm();
  }

  // Test helper: Create a table using sql
  initTable() {
    this.svc.sql`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        age INTEGER
      )
    `;
  }

  // Test helper: Insert a user using sql
  insertUser(id: string, name: string, age: number) {
    this.svc.sql`
      INSERT INTO users (id, name, age)
      VALUES (${id}, ${name}, ${age})
    `;
  }

  // Test helper: Get user by ID using sql
  getUserById(id: string) {
    const rows = this.svc.sql`SELECT * FROM users WHERE id = ${id}`;
    return rows[0];
  }

  // Test helper: Schedule an alarm using alarms
  async scheduleAlarm(when: Date | string | number, payload?: any) {
    return await this.svc.alarms.schedule(when, 'handleAlarm', payload);
  }

  // Test helper: Get a schedule by ID
  async getSchedule(id: string) {
    return await this.svc.alarms.getSchedule(id);
  }

  // Test helper: Cancel a schedule
  async cancelSchedule(id: string) {
    return await this.svc.alarms.cancelSchedule(id);
  }

  // Alarm callback
  async handleAlarm(payload: any, schedule: Schedule) {
    this.executedAlarms.push({ payload, schedule });
  }

  // Test helper: Get executed alarms
  async getExecutedAlarms() {
    return this.executedAlarms;
  }
}

// Default export for worker
export default {
  async fetch(request: Request, env: Env) {
    return new Response('OK');
  },
};

