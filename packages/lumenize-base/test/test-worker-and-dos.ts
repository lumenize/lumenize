// Import NADIS packages to register services
import '@lumenize/core';
import '@lumenize/alarms';

import { LumenizeBase } from '../src/lumenize-base';
import type { Schedule } from '@lumenize/alarms';

// Export documentation example DOs
export { UsersDO, NotificationsDO } from './for-docs/basic-usage.test';

export class TestDO extends LumenizeBase<Env> {
  executedAlarms: Array<{ payload: any; schedule: Schedule }> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Run migrations in constructor (recommended pattern)
    this.#initTable();
  }

  // Required: delegate to Alarms
  async alarm() {
    await this.svc.alarms.alarm();
  }

  // Migration: Create users table
  #initTable() {
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
    return await this.svc.alarms.schedule(when, this.ctn().handleAlarm(payload));
  }

  // Test helper: Get a schedule by ID
  async getSchedule(id: string) {
    return await this.svc.alarms.getSchedule(id);
  }

  // Test helper: Cancel a schedule
  async cancelSchedule(id: string) {
    return await this.svc.alarms.cancelSchedule(id);
  }

  // Alarm callback - receives schedule as first parameter (injected by alarms)
  async handleAlarm(schedule: Schedule, payload: any) {
    this.executedAlarms.push({ payload, schedule });
  }

  // Test helper: Get executed alarms
  async getExecutedAlarms() {
    return this.executedAlarms;
  }

  // Test helper: Access non-existent service to trigger error
  async accessNonExistentService() {
    // @ts-expect-error - Intentionally accessing non-existent service
    return this.svc.nonExistent;
  }

  // Test helpers for __lmzInit()
  async testLmzInit(options?: { doBindingName?: string; doInstanceNameOrId?: string }) {
    await this.__lmzInit(options);
  }

  async getStoredBindingName() {
    return this.ctx.storage.kv.get('__lmz_do_binding_name');
  }

  async getStoredInstanceName() {
    return this.ctx.storage.kv.get('__lmz_do_instance_name');
  }

  async clearStoredMetadata() {
    this.ctx.storage.kv.delete('__lmz_do_binding_name');
    this.ctx.storage.kv.delete('__lmz_do_instance_name');
  }

  // Test helper for fetch() with custom headers
  async testFetch(headers: Record<string, string> = {}) {
    const request = new Request('https://example.com', { headers });
    return await this.fetch(request);
  }
}

// Default export for worker
export default {
  async fetch(request: Request, env: Env) {
    return new Response('OK');
  },
};

