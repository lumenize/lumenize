# @lumenize/sql-migrations

Minimal id-gated SQL schema migrations for SQLite-backed Cloudflare Durable Objects — **synchronous, atomic, run-once**.

Append-only migration list, a stored last-applied marker, each migration runs exactly once, the batch committed atomically via `transactionSync`. `runAll()` is synchronous, so you can call it straight from a DO constructor body.

```ts
import { SQLSchemaMigrations } from '@lumenize/sql-migrations';

const MIGRATIONS = [
  { idMonotonicInc: 1, description: 'create users', sql: 'CREATE TABLE IF NOT EXISTS Users (id TEXT PRIMARY KEY)' },
  { idMonotonicInc: 2, description: 'add email', sql: 'ALTER TABLE Users ADD COLUMN email TEXT' },
];

class MyDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    new SQLSchemaMigrations({ doStorage: ctx.storage, migrations: MIGRATIONS }).runAll();
  }
}
```

Bind values with `params` (never interpolate): `{ idMonotonicInc: 3, description: 'seed', sql: 'INSERT INTO Users (id) VALUES (?)', params: [id] }`.

Vendored and modified from [durable-utils](https://github.com/lambrospetrou/durable-utils) (MIT). Full docs: https://lumenize.com/docs/sql-migrations

## License

MIT
