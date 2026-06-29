import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { SQLSchemaMigrations } from '../../src/index';

// Source-of-truth for the `website/docs/sql-migrations/index.md` usage example
// (matched via @check-example). Runs the live runner against a real DO ctx.storage.
describe('docs: basic usage', () => {
  it('applies pending migrations once, atomically, from a DO ctx', async () => {
    const stub = env.TEST_DO.get(env.TEST_DO.newUniqueId());
    await runInDurableObject(stub, (_instance: any, ctx: any) => {
      const MIGRATIONS = [
        { idMonotonicInc: 1, description: 'create users', sql: 'CREATE TABLE IF NOT EXISTS Users (id TEXT PRIMARY KEY)' },
        { idMonotonicInc: 2, description: 'add email', sql: 'ALTER TABLE Users ADD COLUMN email TEXT' },
      ];
      new SQLSchemaMigrations({ doStorage: ctx.storage, migrations: MIGRATIONS }).runAll();

      // The schema is in place: insert against the new column, then read it back.
      ctx.storage.sql.exec('INSERT INTO Users (id, email) VALUES (?, ?)', 'u1', 'a@b.com');
      const rows = ctx.storage.sql.exec('SELECT id, email FROM Users').toArray();
      expect(rows).toEqual([{ id: 'u1', email: 'a@b.com' }]);
    });
  });
});
