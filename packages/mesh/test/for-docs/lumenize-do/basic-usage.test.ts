/**
 * Pedagogical tests of `LumenizeDO`'s built-in services, run once in the `main` project. The
 * Durable Objects they drive are in `example-dos.ts`, which the test worker exports.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('LumenizeDO - Basic Usage', () => {
  it('auto-injects sql service', async () => {
    const stub = env.USERS_DO.getByName('sql_test');

    const user = await stub.addUser('user1', 'test@example.com');

    expect(user.email).toBe('test@example.com');

    const retrieved = await stub.getUser('user1');
    expect(retrieved.email).toBe('test@example.com');
  });

  it('uses multiple injected services together', async () => {
    const stub = env.NOTIFICATIONS_DO.getByName('multi_service_test');

    const result = await stub.scheduleNotification(
      'user1',
      'Hello, world!',
      5
    );

    expect(result.scheduled).toBe(true);
    expect(result.id).toContain('notif-');
  });

  it('works with queries and inserts', async () => {
    const stub = env.USERS_DO.getByName('queries_test');

    await stub.addUser('alice', 'alice@example.com');
    await stub.addUser('bob', 'bob@example.com');

    const users = await stub.getAllUsers();
    expect(users.length).toBeGreaterThanOrEqual(2);
  });
});
