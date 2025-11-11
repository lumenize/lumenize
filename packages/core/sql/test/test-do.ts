import { DurableObject } from 'cloudflare:workers';
import { sql } from '../index';

// Export ProductDO for documentation examples
export { ProductDO } from './for-docs/basic-usage.test';

// Export DebugTestDO for debug tests
export { DebugTestDO } from '../../debug/test/test-do';

// Export ChatRoom and MyDO for debug documentation examples
export { ChatRoom } from '../../debug/test/for-docs/quick-start-lumenize-base.test';
export { MyDO } from '../../debug/test/for-docs/quick-start-vanilla-do.test';

export class TestDO extends DurableObject<Env> {
  // Convenient convention - You can use sql(this)` ... directly just as well
  // We need `this` passed in because it's just the pattern that every Lumenize NADIS
  // plugin requires when used stand-alone. When using LumenizeBase, this is not necessary.
  #sql = sql(this);

  // Initialize test table
  initTable(): void {
    this.#sql`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        age INTEGER
      )
    `;
  }

  // Clear all data
  clearTable(): void {
    this.#sql`DELETE FROM users`;
  }

  // Insert a user
  insertUser(id: string, name: string, age: number): void {
    this.#sql`INSERT INTO users (id, name, age) VALUES (${id}, ${name}, ${age})`;
  }

  // Get user by ID
  getUserById(id: string): any {
    const rows = this.#sql`SELECT * FROM users WHERE id = ${id}`;
    return rows[0] || null;
  }

  // Get all users
  getAllUsers(): any[] {
    return this.#sql`SELECT * FROM users ORDER BY name`;
  }

  // Get users by age range
  getUsersByAgeRange(minAge: number, maxAge: number): any[] {
    return this.#sql`SELECT * FROM users WHERE age >= ${minAge} AND age <= ${maxAge} ORDER BY age`;
  }

  // Count users
  countUsers(): number {
    const rows = this.#sql`SELECT COUNT(*) as count FROM users`;
    return rows[0].count;
  }

  // Update user age
  updateUserAge(id: string, newAge: number): void {
    this.#sql`UPDATE users SET age = ${newAge} WHERE id = ${id}`;
  }

  // Delete user
  deleteUser(id: string): void {
    this.#sql`DELETE FROM users WHERE id = ${id}`;
  }

  // Test helper: Test sql() with invalid instance
  testInvalidSqlInstance(): void {
    // Create an invalid instance (no ctx.storage.sql)
    const invalidInstance = { ctx: { storage: {} } };
    sql(invalidInstance);
  }
}

// Export default worker (required by vitest-pool-workers)
export default {
  fetch(): Response {
    return new Response('Worker entrypoint for tests');
  }
};

