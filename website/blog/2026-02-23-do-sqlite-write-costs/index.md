---
title: "Every index costs you $1 per million rows: measuring DO SQLite write costs"
slug: do-sqlite-write-costs
authors: [larry]
tags: [architecture]
description: "Empirical measurements of how indexes, PRIMARY KEY types, WITHOUT ROWID, UPDATEs, and DELETEs affect rowsWritten billing in Cloudflare Durable Objects SQLite storage."
---

Cloudflare Durable Objects with SQLite storage charge $1.00 per million rows written and $0.001 per million rows read. Writes are **1,000x more expensive** than reads. The [docs](https://developers.cloudflare.com/durable-objects/platform/pricing/#sqlite-storage-backend) tell you that "every row update of an index counts as an additional row written" — but that's where the guidance ends.

How much does a compound index cost? Does `WITHOUT ROWID` actually save money? If I update a column that isn't indexed, do I still pay for the indexes? Does `UNIQUE` have an impact? Questions like these come up regularly on the [#durable-objects Discord](https://discord.com/channels/595317990191398933/773219443911819284), and I've never seen an experimentally-validated publication that answers them. So I wrote 36 tests and measured everything.

<!-- truncate -->

## TL;DR; Recommendations

If you're designing schemas for Durable Objects with SQLite storage:

1. **Always use `WITHOUT ROWID` on tables with TEXT or compound primary keys.** There is no downside (these tables don't benefit from rowid anyway) and it saves 1 write per INSERT.

2. **Prefer compound indexes over multiple single-column indexes.** A compound index `(a, b)` costs 1 write and also covers lookups on `a` alone. Two separate indexes cost 2.

3. **Favor compound primary keys over single-column PK + separate indexes.** With `WITHOUT ROWID`, the compound PK doesn't need a separate index — you get multi-column uniqueness and first-column lookups for 1 write instead of 2.

4. **Use partial indexes for sparse flags.** `WHERE isAdmin = 1` costs nothing for the 99% of rows where it's false or missing.

5. **Keep frequently-updated columns out of indexes.** UPDATE only rewrites affected indexes, so structuring your schema to keep hot-path updates on non-indexed columns saves writes.

6. **Use `INSERT OR REPLACE` freely.** It costs 1 write even when replacing, not 2.

Read on for the evidence behind each recommendation.

---

## Method

I created a minimal DO with a single RPC method that executes SQL and returns `cursor.rowsWritten` — the billing-relevant metric. Each test gets a fresh DO instance (empty SQLite database), creates the schema, runs the operation, and records the write count. The full experiment code is [on GitHub](https://github.com/lumenize/lumenize/tree/main/experiments/do-write-costs).

```typescript
// The DO — just a thin wrapper around ctx.storage.sql.exec
export class WriteCostDO extends DurableObject<Env> {
  execSql(sql: string, params?: any[]): SqlResult {
    const cursor = this.ctx.storage.sql.exec(sql, ...(params ?? []));
    const rows = [...cursor];
    return {
      rowsWritten: cursor.rowsWritten,
      rowsRead: cursor.rowsRead,
      rows,
    };
  }
}
```

All tests run locally via `vitest-pool-workers` against the Miniflare runtime, which I believe should give us the same numbers as production DOs. If you know otherwise, please [reach out on Discord](https://discord.gg/tkug8FGfKR). Let's get to the results.

---

## The formula

For INSERTs, the write cost formula is simple:

> **`rowsWritten = 1 (table row) + 1 per index that needs updating`**

A "table row" always costs exactly 1 write regardless of how many columns it has — 2 columns or 10 columns, same price. Each index adds 1 write per INSERT, whether it's a single-column index, a compound index, or a UNIQUE index.

The sneaky part is that some table definitions create indexes you might not realize you're paying for.

---

## The hidden cost of TEXT PRIMARY KEY

This was the biggest finding. Consider these two tables:

```sql
CREATE TABLE t(a TEXT PRIMARY KEY, b TEXT);
-- INSERT costs: 2 rowsWritten

CREATE TABLE t(a TEXT PRIMARY KEY, b TEXT) WITHOUT ROWID;
-- INSERT costs: 1 rowsWritten
```

Why the difference? In SQLite, every regular table has an implicit `rowid` column — a hidden 64-bit integer that serves as the physical row identifier. When you declare a `TEXT PRIMARY KEY`, SQLite can't use the text value as the rowid (only integers can alias it), so it creates a **separate index** to enforce the primary key constraint. You end up with two data structures: the rowid-based table and the PK index.

`WITHOUT ROWID` tells SQLite to organize the table directly by the primary key. No hidden rowid, no separate PK index, no extra write.

This matters for any table where the primary key is text — UUIDs, email addresses, slug identifiers, composite keys. Every INSERT to such a table costs **double** unless you add `WITHOUT ROWID`.

For comparison, `INTEGER PRIMARY KEY` aliases the rowid and costs just 1 write — no extra index either way.

| Schema | INSERT `rowsWritten` |
|--------|:--------------------:|
| No PK (implicit rowid only) | 1 |
| `INTEGER PRIMARY KEY` (aliases rowid) | 1 |
| `TEXT PRIMARY KEY` (creates separate index) | 2 |
| `TEXT PRIMARY KEY ... WITHOUT ROWID` | 1 |

:::note SQLite's own guidance differs — here's why

The [official SQLite documentation on WITHOUT ROWID](https://www.sqlite.org/withoutrowid.html) recommends defaulting to regular rowid tables and only adding `WITHOUT ROWID` after performance testing shows it helps. That's sound advice for traditional SQLite — but it doesn't account for Cloudflare's billing model. SQLite's concern is that `WITHOUT ROWID` tables with large rows (roughly >1/20th of page size) can hurt query performance because content is stored on both leaf and intermediate B-tree nodes, reducing fan-out. In Durable Objects, though, you're paying $1/M for every extra write. For TEXT PK tables with reasonably-sized rows — which describes most DO schemas I've seen — the write cost savings are immediate and concrete.

:::

---

## Compound indexes: 1 write, not N

A compound index `CREATE INDEX idx ON t(a, b)` costs the same as a single-column index — 1 additional write per INSERT. Two separate single-column indexes cost 2 additional writes.

| Schema | INSERT `rowsWritten` |
|--------|:--------------------:|
| No indexes | 1 |
| 1 single-column index | 2 |
| 1 compound index `(a, b)` | 2 |
| 2 separate single-column indexes | 3 |

If you're debating between a compound index and two separate ones, the compound index is half the write cost. It also covers lookups on the first column alone — a compound index `(a, b)` supports `WHERE a = ?` queries efficiently via leftmost-prefix matching. JOINs on just `a` work too. You get multiple query patterns for the price of one write.

---

## Favor compound primary keys

The same leftmost-prefix property applies to primary keys, which means compound PKs can replace a single-column PK plus a separate index. Consider a table where rows are unique by `(email, instanceName)`:

```sql
-- Approach A: single-column PK + separate index
CREATE TABLE t(email TEXT PRIMARY KEY, instanceName TEXT, ...) WITHOUT ROWID;
CREATE INDEX idx ON t(email, instanceName);
-- INSERT costs: 2 rowsWritten (1 table + 1 index)

-- Approach B: compound PK
CREATE TABLE t(email TEXT, instanceName TEXT, ...,
  PRIMARY KEY (email, instanceName)) WITHOUT ROWID;
-- INSERT costs: 1 rowsWritten (the PK *is* the table)
```

Approach B gives you lookups on `email` alone (leftmost prefix), lookups on `(email, instanceName)` together (the full PK), and enforces the multi-column uniqueness constraint — all for 1 write instead of 2. If you also need lookups by `instanceName` alone, add one index and you're at 2 writes — still no worse than Approach A, but with better query coverage.

---

## UNIQUE in a column definition creates a hidden index

When you write `email TEXT UNIQUE` in a CREATE TABLE statement, SQLite implicitly creates an index to enforce that constraint. You're paying for an index whether you realize it or not:

```sql
CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT UNIQUE);
-- INSERT costs: 2 rowsWritten (1 table + 1 hidden UNIQUE index)
```

That hidden index costs exactly the same as an explicit one — there's no penalty or bonus either way:

| Schema | INSERT `rowsWritten` |
|--------|:--------------------:|
| `email TEXT UNIQUE` (inline constraint) | 2 |
| `CREATE INDEX idx ON t(email)` | 2 |
| `CREATE UNIQUE INDEX idx ON t(email)` | 2 |

This means every `UNIQUE` column in your table definition adds 1 write per INSERT. If you have a table with three UNIQUE columns, that's 3 extra writes you might not have budgeted for.

Before adding `UNIQUE`, ask whether the column is truly independently unique, or whether it's unique *in combination* with other columns. In many schemas — especially in Durable Objects where each instance is already a scope boundary — a column that looks unique is really only unique within a context. An `email` column in a per-tenant DO isn't globally unique; it's unique within that tenant. That's a compound primary key, not a UNIQUE constraint, and the compound PK is free (see [Favor compound primary keys](#favor-compound-primary-keys) above).

When a column really is independently unique and the value comes from external input where collisions are possible (like an email address or username), the UNIQUE index is the safest option — the database enforces it for you at the cost of 1 extra write per INSERT. For server-generated values like UUIDs that are unique by construction, you may not need the constraint at all.

---

## UPDATEs are smarter than you'd expect

This was a pleasant surprise. When you UPDATE a row, SQLite only rewrites the indexes that cover the columns you actually changed. Indexes on other columns are left alone.

| Scenario | UPDATE `rowsWritten` |
|----------|:--------------------:|
| Update non-indexed column (table has 1 extra index) | 1 |
| Update indexed column (table has 1 extra index) | 2 |
| Update 1 indexed column (table has 3 extra indexes) | 2 |
| Update non-indexed column (table has 3 extra indexes) | 1 |

This means you can safely add read-path indexes without worrying about write amplification on unrelated columns. If your hot UPDATE path only touches non-indexed columns, those indexes are free from a write-cost perspective.

---

## INSERT OR REPLACE costs 1 write, not 2

If you use upsert patterns, this one matters. `INSERT OR REPLACE` on an existing row reports `rowsWritten = 1` — it's not counted as a delete + insert internally.

| Scenario | `rowsWritten` |
|----------|:-------------:|
| `INSERT OR REPLACE`, new row | 1 |
| `INSERT OR REPLACE`, existing row | 1 |

This means you can use `INSERT OR REPLACE` as your default write pattern without worrying about double-charging on updates. It's cheaper than a SELECT-then-decide-INSERT-or-UPDATE pattern if that SELECT would hit indexes.

One caveat: `INSERT OR REPLACE` is semantically a full row replacement — it rewrites all indexes on the table, not just the ones covering columns you changed. On a table with 3 indexes, that's 4 writes (1 table + 3 indexes). Compare that to `UPDATE` on a non-indexed column, which costs just 1 write regardless of index count (see [UPDATEs are smarter than you'd expect](#updates-are-smarter-than-youd-expect)). So `INSERT OR REPLACE` is ideal when you're writing the whole row — true upserts where you have all the data. For single-field changes on indexed tables, a targeted `UPDATE` is cheaper.

---

## Partial indexes: free when the filter doesn't match

A partial index like `CREATE INDEX idx ON t(data) WHERE status = 1` only costs a write when the inserted row matches the filter:

| Scenario | INSERT `rowsWritten` |
|----------|:--------------------:|
| Row matches filter (`status = 1`) | 2 |
| Row doesn't match filter (`status = 0`) | 1 |

This is a powerful tool for tables where you only query a subset of rows. An `isAdmin` flag that's true for 1% of rows? A partial index costs almost nothing to maintain and speeds up the queries that matter.

---

## More findings

**DELETEs always cost 1 write**, regardless of how many indexes the table has. Index cleanup doesn't appear to be counted in `rowsWritten`. I haven't confirmed whether this means index cleanup is truly free for billing purposes or if it's accounted for differently — but `cursor.rowsWritten` consistently returns 1.

**Column count doesn't affect write cost.** 2-column and 10-column tables both cost 1 write per row (plus indexes). The billing unit is the row, not the column.

**Batch INSERTs offer no discount.** `INSERT INTO t VALUES (...), (...), (...)` with 3 rows costs exactly the same total `rowsWritten` as 3 separate INSERT statements.

---

The [experiment code](https://github.com/lumenize/lumenize/tree/main/experiments/do-write-costs) is open source — run it yourself or add test cases for schemas you're curious about.

I've incorporated the insight from this research into my [Durable Objects agentic coding skill](https://github.com/lumenize/lumenize/blob/main/.claude/skills/do-conventions/SKILL.md#16-sqlite-write-cost-optimization). Feel free to use it and any other part of that file as you see fit.

Have questions or want to discuss these findings? Join the conversation in the [Lumenize Discord #general channel](https://discord.gg/tkug8FGfKR).
