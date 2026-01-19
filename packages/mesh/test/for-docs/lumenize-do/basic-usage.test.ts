/**
 * Pedagogical tests for @lumenize/mesh documentation examples
 * These tests are referenced in website/docs/lumenize-mesh/*.mdx files
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

// Import packages - side-effect imports register services in NADIS
import '@lumenize/alarms';
import { LumenizeDO } from '@lumenize/mesh';

// Example: Basic auto-injection
class UsersDO extends LumenizeDO<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Run migrations in constructor
    this.#initTable();
  }

  #initTable() {
    this.svc.sql`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `;
  }

  addUser(id: string, email: string) {
    this.svc.sql`INSERT INTO users (id, email) VALUES (${id}, ${email})`;
    return { id, email };
  }

  getUser(id: string) {
    const rows = this.svc.sql`SELECT * FROM users WHERE id = ${id}`;
    return rows[0];
  }

  getAllUsers() {
    return this.svc.sql`SELECT * FROM users ORDER BY created_at DESC`;
  }
}

// Example: Using multiple services together
class NotificationsDO extends LumenizeDO<Env> {
  executedNotifications: Array<{ userId: string; message: string }> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Run migrations in constructor
    this.svc.sql`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        message TEXT NOT NULL,
        sent_at INTEGER
      )
    `;
  }

  scheduleNotification(userId: string, message: string, delaySeconds: number) {
    // Store notification in SQL
    const id = `notif-${Date.now()}`;
    this.svc.sql`
      INSERT INTO notifications (id, user_id, message)
      VALUES (${id}, ${userId}, ${message})
    `;

    // Schedule alarm to send it - schedule() is synchronous
    const payload = { id, userId, message };
    const schedule = this.svc.alarms.schedule(
      delaySeconds,
      this.ctn().sendNotification(payload) as any // Continuation proxy - TS doesn't understand runtime behavior
    );

    return { scheduled: true, id, scheduleId: schedule.id };
  }

  // Handler receives the payload passed to the continuation
  sendNotification(payload: { id: string; userId: string; message: string }) {
    // Mark as sent in database
    this.svc.sql`
      UPDATE notifications
      SET sent_at = ${Math.floor(Date.now() / 1000)}
      WHERE id = ${payload.id}
    `;

    // Track execution for tests
    this.executedNotifications.push({
      userId: payload.userId,
      message: payload.message,
    });
  }

  async alarm() {
    await this.svc.alarms.alarm();
  }

  getSentNotifications() {
    return this.svc.sql`
      SELECT * FROM notifications
      WHERE sent_at IS NOT NULL
      ORDER BY sent_at DESC
    `;
  }

  getExecutedNotifications() {
    return this.executedNotifications;
  }
}

export { UsersDO, NotificationsDO };

describe('LumenizeDO - Basic Usage', () => {
  it('auto-injects sql service', async () => {
    const stub = env.USERS_DO.getByName('sql-test');

    const user = await stub.addUser('user1', 'test@example.com');

    expect(user.email).toBe('test@example.com');

    // @ts-expect-error - Type instantiation is excessively deep (vitest-pool-workers stub typing)
    const retrieved = await stub.getUser('user1');
    expect(retrieved.email).toBe('test@example.com');
  });

  it('uses multiple injected services together', async () => {
    const stub = env.NOTIFICATIONS_DO.getByName('multi-service-test');

    const result = await stub.scheduleNotification(
      'user1',
      'Hello, world!',
      5
    );

    expect(result.scheduled).toBe(true);
    expect(result.id).toContain('notif-');
  });

  it('works with queries and inserts', async () => {
    const stub = env.USERS_DO.getByName('queries-test');

    await stub.addUser('alice', 'alice@example.com');
    await stub.addUser('bob', 'bob@example.com');

    const users = await stub.getAllUsers();
    expect(users.length).toBeGreaterThanOrEqual(2);
  });
});
