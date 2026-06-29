---
title: SQL Migrations
description: Minimal id-gated SQL schema migrations for SQLite-backed Durable Objects — synchronous, atomic, run-once.
---

# @lumenize/sql-migrations

Evolving a Durable Object's SQLite schema across deploys needs a runner: `CREATE TABLE IF NOT EXISTS` is idempotent, but `ALTER TABLE ADD COLUMN` is not — re-running it throws `duplicate column name`. `@lumenize/sql-migrations` gives you an **append-only list of migrations**, each run **exactly once**, the batch committed **atomically**.

It is **synchronous** — `runAll()` does its work through the sync storage API (`ctx.storage.kv` + `ctx.storage.transactionSync`), so you can call it straight from a Durable Object **constructor body**, before any request is served.

```bash
npm install @lumenize/sql-migrations
```

## Usage

Define a migration list and run it once in your DO's constructor:

```typescript @check-example('packages/sql-migrations/test/for-docs/basic-usage.test.ts')
const MIGRATIONS = [
  { idMonotonicInc: 1, description: 'create users', sql: 'CREATE TABLE IF NOT EXISTS Users (id TEXT PRIMARY KEY)' },
  { idMonotonicInc: 2, description: 'add email', sql: 'ALTER TABLE Users ADD COLUMN email TEXT' },
];
new SQLSchemaMigrations({ doStorage: ctx.storage, migrations: MIGRATIONS }).runAll();
```

In a real DO that's the constructor:

```typescript @skip-check-approved('conceptual')
class MyDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    new SQLSchemaMigrations({ doStorage: ctx.storage, migrations: MIGRATIONS }).runAll();
  }
}
```

`runAll()` applies only the migrations that **haven't run yet** — those with an id above the stored marker — in id order; everything already applied is skipped (so "all" means "all *pending*", not "re-run everything"). It is synchronous, so no `await` and no `blockConcurrencyWhile` are needed — the constructor runs to completion before any request is delivered. Reach for `blockConcurrencyWhile` only if a future migration step must itself `await`.

## How it works

- **Append-only, monotonic ids.** Every migration has an `idMonotonicInc`. Migrations are sorted and duplicate-checked at construction (a negative or duplicate id throws). **Never edit, reorder, or reuse an applied id** — add a new entry with a higher id instead.
- **Run-once via a stored marker, not introspection.** The runner records the last-applied id in `ctx.storage.kv` and skips everything `<=` it. That is what makes a bare `ALTER TABLE ADD COLUMN` safe: it can only ever run once, even though SQLite has no `ADD COLUMN IF NOT EXISTS`.
- **Atomic batch.** All pending migrations plus the marker write run inside one `transactionSync` — if any step throws, the whole batch rolls back and the marker does not advance, so a later retry re-applies cleanly.
- **Treat already-applied migrations as frozen — append, don't edit.** Nothing *stops* you editing the `sql` of a migration that already ran, but it has **no effect** (the marker gates it out), so to change the schema further you add a new migration with a higher id rather than modifying an old one.

## Binding values

Migration SQL values are **bound** with `params`, never interpolated:

```typescript @skip-check-approved('conceptual')
{ idMonotonicInc: 3, description: 'seed admin', sql: 'INSERT INTO Users (id) VALUES (?)', params: [adminId] }
```

Keep each migration to a **single statement** so the positional `?` binds are unambiguous; split an `ALTER` plus a value-bearing backfill into two consecutive migrations (they still run in the same atomic batch).

## API

- `new SQLSchemaMigrations({ doStorage, migrations })` — `doStorage` is the DO's `ctx.storage` handle; `migrations` is the full list (every migration ever, not just new ones).
- `SQLSchemaMigration` — `{ idMonotonicInc: number; description: string; sql: string; params?: SqlStorageValue[] }`.
- `runAll(): { rowsRead: number; rowsWritten: number }` — synchronous; applies all pending migrations and returns SQL rows read/written across the batch. Idempotent once current.

Vendored and modified from [durable-utils](https://github.com/lambrospetrou/durable-utils) (MIT).
