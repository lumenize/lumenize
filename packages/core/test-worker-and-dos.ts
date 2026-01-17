// Import NADIS packages to register services
import '@lumenize/core';

import { LumenizeDO } from '@lumenize/mesh';

// Export ProductDO for documentation examples
export { ProductDO } from './sql/test/for-docs/basic-usage.test';

// Export DOs for debug documentation examples
export { ChatRoom } from './debug/test/for-docs/quick-start-lumenize-base.test';
export { MyDO } from './debug/test/for-docs/quick-start-vanilla-do.test';

// Test DO for SQL tests
export class TestDO extends LumenizeDO<any> {
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
  }

  // Initialize test table
  initTable(): void {
    this.svc.sql`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        age INTEGER
      )
    `;
  }

  // Insert a user
  insertUser(id: string, name: string, age: number): void {
    this.svc.sql`
      INSERT INTO users (id, name, age)
      VALUES (${id}, ${name}, ${age})
    `;
  }

  // Get user by ID
  getUserById(id: string): any {
    const rows = this.svc.sql`
      SELECT * FROM users WHERE id = ${id}
    `;
    return rows[0] || null;
  }

  // Get all users
  getAllUsers(): any[] {
    return this.svc.sql`
      SELECT * FROM users ORDER BY name
    `;
  }

  // Update user age
  updateUserAge(id: string, age: number): void {
    this.svc.sql`
      UPDATE users SET age = ${age} WHERE id = ${id}
    `;
  }

  // Delete user
  deleteUser(id: string): void {
    this.svc.sql`
      DELETE FROM users WHERE id = ${id}
    `;
  }

  // Count users
  countUsers(): number {
    const rows = this.svc.sql`
      SELECT COUNT(*) as count FROM users
    `;
    return rows[0]?.count || 0;
  }

  // Get users by minimum age
  getUsersByMinAge(minAge: number): any[] {
    return this.svc.sql`
      SELECT * FROM users WHERE age >= ${minAge} ORDER BY age
    `;
  }

  // Get users by age range
  getUsersByAgeRange(minAge: number, maxAge: number): any[] {
    return this.svc.sql`
      SELECT * FROM users WHERE age >= ${minAge} AND age <= ${maxAge} ORDER BY age
    `;
  }

  // Clear all data from table
  clearTable(): void {
    this.svc.sql`DELETE FROM users`;
  }
}

// Test DO for Debug tests
import { debug } from '@lumenize/core';

export class DebugTestDO extends LumenizeDO<any> {
  #log = debug(this)('lmz.test.DebugTestDO');

  testBasicLogging() {
    this.#log.debug('Debug message', { level: 'debug' });
    this.#log.info('Info message', { level: 'info' });
    this.#log.warn('Warning message', { level: 'warn' });
    
    return { logged: true };
  }

  testEnabledFlag() {
    return { 
      enabled: this.#log.enabled,
      namespace: 'test.debug-do'
    };
  }

  testStructuredData() {
    const data = {
      requestId: 'req-123',
      userId: 'user-456',
      timestamp: Date.now()
    };
    
    this.#log.info('Processing request', data);
    
    return { processed: true };
  }

  // Note: testNamespaceMatch removed - it tested internal implementation details
  // (pattern-matcher), not the user-facing API. Users interact with debug()
  // via `debug(this)('namespace')`, not pattern matching internals.
}

// Default worker export
export default {
  async fetch(request: Request, env: any) {
    return new Response('OK');
  },
};

