# DO SQLite Write Cost Research

## Goal

Empirically measure how indexes, PRIMARY KEY definitions, UNIQUE constraints, and `WITHOUT ROWID` affect `rowsWritten` in Cloudflare Durable Objects SQLite storage. Publish findings as a Lumenize blog post.

## Why This Matters

- Writes cost $1.00/M, reads cost $0.001/M — writes are **1000x more expensive**
- Cloudflare docs say "every row update of an index counts as an additional row [written]" but don't answer key questions
- These questions come up frequently on the DO Discord
- Findings directly inform the `@lumenize/nebula-auth` registry schema (see `tasks/nebula-auth.md`)

## Phases

This task is executed in three serial phases:

1. **Phase 1: Experiments** — Build test harness, run all experiments, record results ✅
2. **Phase 2: Nebula-auth schema updates** — Apply findings to registry schema in `tasks/nebula-auth.md` ✅
3. **Phase 3: Blog post** — Write up findings as a practical guide for DO developers ✅
4. **Phase 4: Codify guidance** — After the blog post is edited and published, update CLAUDE.md and/or `.claude/skills/` with schema design guidance for future DO work (new skill or extend `do-conventions`) ✅

## Questions to Answer

Each question should be answered with a concrete test case showing the `cursor.rowsWritten` value.

### Q1: Compound index write count
Does a compound index `CREATE INDEX idx ON t(a, b)` count as 1 row written or 2?

### Q2: Implicit rowid, INTEGER PRIMARY KEY alias, and WITHOUT ROWID
- Does an INSERT into a regular table (with implicit `rowid`) count the rowid as a row written?
- Does `WITHOUT ROWID` change the write count?
- Does `INTEGER PRIMARY KEY` (which aliases the rowid) behave differently from `TEXT PRIMARY KEY` (which creates a separate index)?
- Compare all three:
  - `CREATE TABLE t(a TEXT PRIMARY KEY, b TEXT)` — TEXT PK with implicit rowid
  - `CREATE TABLE t(a TEXT PRIMARY KEY, b TEXT) WITHOUT ROWID` — TEXT PK, no rowid
  - `CREATE TABLE t(id INTEGER PRIMARY KEY, b TEXT)` — INTEGER PK aliasing rowid

### Q3: UNIQUE constraint cost
Does `UNIQUE` on a column add a write beyond the index it implies?
- Compare: `CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT UNIQUE)` vs `CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT)` + `CREATE INDEX idx ON t(email)`

### Q4: Compound PK leftmost prefix
For a table with compound PK `(a, b)`, does adding a separate index on `a` increase writes? (In standard SQLite, the PK index already covers `a`-first lookups via leftmost prefix.)

### Q5: UPDATE write costs — indexed vs non-indexed columns
- Does updating a non-indexed column rewrite index rows?
- Does updating an indexed column cost more than updating a non-indexed column?
- Test with a table that has multiple indexes: update a column covered by an index vs a column covered by no index

### Q6: DELETE write costs with multiple indexes
- Does a DELETE on a table with N indexes count as 1 + N rowsWritten?
- Test with tables having 0, 1, 2, and 3 indexes

### Q7: Batch INSERT
- Does `INSERT INTO t VALUES (?),(?),(?)` with 3 rows report 3 rowsWritten (plus per-row index costs), or is there a batching discount?

### Q8: Real-world schema measurements
Measure actual write counts for the nebula-auth registry schema:

```sql
-- Instances table (minimal)
CREATE TABLE Instances(
  instanceName TEXT PRIMARY KEY,
  createdAt INTEGER
) WITHOUT ROWID;   -- test with and without

-- Emails table
CREATE TABLE Emails(
  email TEXT NOT NULL,
  instanceName TEXT NOT NULL,
  isAdmin INTEGER,
  createdAt INTEGER,
  PRIMARY KEY (email, instanceName)
) WITHOUT ROWID;   -- test with and without

CREATE INDEX idx_Emails_instanceName ON Emails(instanceName);
```

Measure `rowsWritten` for:
- `INSERT INTO Instances`
- `INSERT INTO Emails`
- `UPDATE Emails SET isAdmin = 1 WHERE email = ? AND instanceName = ?`
- `DELETE FROM Emails WHERE email = ? AND instanceName = ?`

### Q9: Additional questions
- Does a filtered/partial index (`CREATE INDEX idx ON t(col) WHERE col = 1`) only write when the filter matches?
- Does `INSERT OR REPLACE` count as 1 write or 2 (delete + insert)?
- Does the number of columns in a row affect write count, or is it always 1 per table row + 1 per index?

## Method

1. Create a test DO with `ctx.storage.sql` access
2. For each question, create the relevant table(s), run the operation, and read `cursor.rowsWritten`
3. Use `vitest-pool-workers` for the test harness (consistent with the rest of the monorepo)
4. Each test case should be a separate test with a fresh table (use unique table names or drop/recreate)

### Reading rowsWritten

```typescript
const cursor = ctx.storage.sql.exec(`INSERT INTO Instances (instanceName, createdAt) VALUES (?, ?)`, 'acme-corp', Date.now());
// Consume the cursor (even for writes, to finalize)
cursor.toArray();
console.log(cursor.rowsWritten); // This is the billing-relevant number
```

## Deliverables

1. **Experiment code**: `experiments/do-write-costs/` — standalone test package in the experiments directory
2. **Results table**: Markdown table summarizing all findings (in this task file, updated after Phase 1)
3. **Schema recommendations**: Update `tasks/nebula-auth.md` with findings (Phase 2)
4. **Blog post draft**: `/website/blog/YYYY-MM-DD-do-sqlite-write-costs.mdx` — practical guide for DO developers optimizing write costs (Phase 3)
5. **Codified guidance**: CLAUDE.md and/or `.claude/skills/` updated with write-cost-aware schema design rules (Phase 4)

## Phase 1 Results

All experiments run via `experiments/do-write-costs/test/write-costs.test.ts` (36 tests, all passing).

### Complete Results Table

| Question | Scenario | `rowsWritten` |
|----------|----------|:-------------:|
| **Q1** | INSERT, no indexes | 1 |
| | INSERT, 1 single-column index | 2 |
| | INSERT, 1 compound index `(a, b)` | 2 |
| | INSERT, 2 separate single-column indexes | 3 |
| **Q2** | INSERT, `TEXT PRIMARY KEY` (implicit rowid) | 2 |
| | INSERT, `TEXT PRIMARY KEY` `WITHOUT ROWID` | 1 |
| | INSERT, `INTEGER PRIMARY KEY` (rowid alias) | 1 |
| | INSERT, no PK (implicit rowid only) | 1 |
| **Q3** | INSERT, `UNIQUE` constraint on column | 2 |
| | INSERT, explicit `CREATE INDEX` on column | 2 |
| | INSERT, `CREATE UNIQUE INDEX` on column | 2 |
| **Q4** | INSERT, compound PK `(a, b)` `WITHOUT ROWID` | 1 |
| | INSERT, compound PK `(a, b)` + redundant index on `(a)` | 2 |
| **Q5** | UPDATE non-indexed column (1 extra index) | 1 |
| | UPDATE indexed column (1 extra index) | 2 |
| | UPDATE 1-of-3 indexed columns | 2 |
| | UPDATE non-indexed column (3 indexes on other cols) | 1 |
| **Q6** | DELETE, 0 extra indexes | 1 |
| | DELETE, 1 extra index | 1 |
| | DELETE, 2 extra indexes | 1 |
| | DELETE, 3 extra indexes | 1 |
| **Q7** | 3 separate INSERTs (1 index each) | 2+2+2 = 6 |
| | Batch INSERT of 3 rows (1 index) | 6 |
| **Q8** | INSERT Instances WITH rowid | 2 |
| | INSERT Instances `WITHOUT ROWID` | 1 |
| | INSERT Emails WITH rowid (+ 1 index) | 3 |
| | INSERT Emails `WITHOUT ROWID` (+ 1 index) | 2 |
| | UPDATE Emails.isAdmin `WITHOUT ROWID` | 1 |
| | DELETE Emails `WITHOUT ROWID` | 1 |
| **Q9** | Partial index, filter MATCHES | 2 |
| | Partial index, filter DOES NOT match | 1 |
| | `INSERT OR REPLACE`, new row | 1 |
| | `INSERT OR REPLACE`, existing row | 1 |
| | INSERT, 2 columns (no extra indexes) | 1 |
| | INSERT, 5 columns (no extra indexes) | 1 |
| | INSERT, 10 columns (no extra indexes) | 1 |

### Key Findings

**The formula for INSERT**: `rowsWritten = 1 (table row) + 1 per index that needs updating`

1. **Compound index = 1 write** (Q1). A compound index `(a, b)` costs the same as a single-column index. Two separate indexes cost 2.

2. **`TEXT PRIMARY KEY` creates a hidden index** (Q2). Without `WITHOUT ROWID`, a `TEXT PRIMARY KEY` table has both a rowid _and_ a separate PK index — costing 2 writes per INSERT. `INTEGER PRIMARY KEY` aliases the rowid, so no extra index. `WITHOUT ROWID` eliminates the rowid, so the PK _is_ the table — only 1 write.

3. **`UNIQUE` = index, nothing more** (Q3). `UNIQUE` constraint, `CREATE INDEX`, and `CREATE UNIQUE INDEX` all cost exactly the same.

4. **Redundant leftmost-prefix indexes cost real money** (Q4). A compound PK `(a, b)` already covers `a`-first lookups. Adding a separate index on `(a)` doubles the write cost for zero query benefit.

5. **UPDATEs only rewrite affected indexes** (Q5). Updating a non-indexed column costs 1 write even if the table has many indexes. Updating an indexed column costs 1 (table) + 1 (that index). Other indexes on unchanged columns are NOT rewritten.

6. **DELETEs always cost 1 write** (Q6). Regardless of how many indexes exist, a single-row DELETE reports `rowsWritten = 1`. This is surprising — index cleanup appears to NOT be counted in `rowsWritten`.

7. **No batch INSERT discount** (Q7). Batch and separate INSERTs produce identical total `rowsWritten`.

8. **Partial indexes save writes** (Q9). A partial index `WHERE status = 1` only costs a write when the filter matches. Rows that don't match the filter skip the index write entirely.

9. **`INSERT OR REPLACE` = 1 write** (Q9). Even when replacing an existing row, it counts as 1 write (not delete + insert).

10. **Column count doesn't matter** (Q9). 2 columns and 10 columns both cost 1 write per table row.

### Nebula-Auth Schema Impact (Q8)

With `WITHOUT ROWID`:
- **INSERT Instances**: 1 write (was 2 without)
- **INSERT Emails**: 2 writes (was 3 without) — 1 table + 1 for `idx_Emails_instanceName`
- **UPDATE Emails.isAdmin**: 1 write — `isAdmin` is not indexed, so only the table row is rewritten
- **DELETE Emails**: 1 write — consistent with Q6 findings

**Recommendation**: Always use `WITHOUT ROWID` for tables with `TEXT PRIMARY KEY` or compound text PKs. The nebula-auth registry saves 1 write per INSERT by using `WITHOUT ROWID` on both tables.

## Context

- Cloudflare pricing docs: https://developers.cloudflare.com/durable-objects/platform/pricing/#sqlite-storage-backend
- SQLite storage API docs: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- The `cursor.rowsWritten` property is the billing metric
- The nebula-auth registry is a singleton DO — every unnecessary write on the hot path (email→scope registration) multiplies across all tenants
