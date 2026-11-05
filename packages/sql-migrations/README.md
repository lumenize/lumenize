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

**Composition (multiple components in one DO).** Each runner tracks its progress under a kv marker — by default a single shared key. When one DO composes several classes that each own their own tables, give each its own runner **and a distinct `markerKey`**, so their migration sets advance independently instead of clobbering one shared counter:

```ts
new SQLSchemaMigrations({ doStorage: ctx.storage, markerKey: '__mig_Subscriptions', migrations: SUBSCRIPTIONS_MIGRATIONS }).runAll();
new SQLSchemaMigrations({ doStorage: ctx.storage, markerKey: '__mig_Resources',     migrations: RESOURCES_MIGRATIONS }).runAll();
```

Vendored and modified from [durable-utils](https://github.com/lambrospetrou/durable-utils) (MIT). Full docs: https://lumenize.com/docs/sql-migrations

## License

MIT
