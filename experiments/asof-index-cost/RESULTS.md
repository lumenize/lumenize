# asof-index-cost: what an index over every version costs a write, and what it buys a read as of a moment

**Question.** `tasks/nebula-query-upgrade.md` pages a query's first read by scanning current rows through the filter's index, which is partial on current rows, and then reading by key the earlier version of any row written since the read began. Would an index over every version be better, so the scan itself can ask what matched at the moment the read began, `validFrom <= M0 AND validTo > M0`? The unknown was what such an index costs a write.

**Answers.** Measured on a deployed Worker, 2026-11-24, in objects holding 4,000 resources at about 1, 10 and 100 versions each.

- **An index over every version that includes `validTo` costs one more row written on every update, per index.** With one `@index`, an update of a Deal wrote 4 rows today and 5 with that index. With three, 6 today and 9 with them. A create costs the same in every arm.
- **The task file's claim about today's shape holds.** A partial index added one row to the insert and none to the `UPDATE` that closes the row before it, at one index and at three, at every depth.
- **An index over every version without `validTo` costs a write exactly what today's does,** and it cannot serve a current query: it walks every version that ever held the value.
- **For the first-read case the two designs cost the same CPU, and only the index over every version returns the whole answer.** With 20 writes since the read began, today's scan and lookups took 5.7 ms and the as-of scan 5.0 ms at depth 100. Today's returned 420 of the 422 results that matched at that moment, having no way to find the two that had left. With 1,000 writes since, today's took 10 ms and returned 356 of 441, and the as-of scan took 6.7 ms and returned all 441.
- **A read as of a moment far in the past is not cheap through any of these indexes.** At depth 100, as of the midpoint of the history, the scan walked 20,616 index entries to return 389 results and took 225 ms, about what the arm without `validTo` took (201 ms) and over half of a scan of the whole table (394 ms).
- **Not in the brief: an index on `json_extract(value, …)` seeks the table row for every entry it passes, even when the plan says `COVERING INDEX`.** That is what makes the far read slow, about 10 µs an entry. A walk of the same index by its plain columns alone cost about 0.15 µs an entry.

The sections below give the method, the arms, the writes, the reads with their plans, the sizes, and what was not measured.

## Method

`experiment-asof-index-cost`, compatibility date 2026-10-01, wrangler 4.147.0, deployed only. It follows [`query-subtree-and-catchup`](../query-subtree-and-catchup/RESULTS.md), whose RESULTS.md has the reasons for each choice.

- **Each arm is a table.** A table is a copy of `Snapshots` as `packages/resources/src/snapshots.ts` creates it, `WITHOUT ROWID` with primary key `(resourceId, validFrom)` and `idx_…_current` on `(resourceId, validTo)` over current rows, under the arm's own name, such as `S_B3` for arm B with three indexes. Its indexes go on before its data, so each row is written as a live host would write it.
- **One object per history depth,** named `d1`, `d10` and `d100`. Every arm of a depth sits in one object, so arms are compared on one host, as the template found necessary.
- **The data** is 4,000 resources: 2,000 `Deal`, 1,200 `Contact`, 800 `Task`. The first 4,000 writes create them, and each later write updates one picked at random, one moment per write, 1 ms apart. Depth 10 is 40,000 writes and depth 100 is 400,000. A Deal's `stage` is one of five and every write picks it anew, so `stage = 'open'` matches about a fifth of the type at any moment and about a fifth of every version. A row is about 0.8 kB. No resource is deleted or moved.
- **A write** is what `Snapshots.#write` runs: a read of the current row by key, the `UPDATE` that sets its `validTo`, and the `INSERT`. The object answers each statement's `rowsWritten` from the sql cursor.
- **CPU** is `cpuTimeMs` of the object's invocation in Workers Logs, joined by a `{ probe, seq }` line. A timed call runs one case `reps` times and nothing else, sized for about 250 ms. Each case ran five rounds in a new random order, and the tables give the median with the lowest and highest round. Every timed call joined: 215 of 215 in each depth's run and 330 of 330 in the extra run.
- **Plans** are `EXPLAIN QUERY PLAN` run with the same parameters. Each as-of statement's rows were hashed, and every arm returned the same rows for the same moment.

## The arms

Each statement below is for the field `stage`. An arm with three indexes has the same statement for `owner` and `amount` as well.

| Arm | `CREATE INDEX` |
|---|---|
| A, today | `CREATE INDEX "idx_S_A1_q_Deal:stage" ON S_A1(json_extract(value, '$.stage')) WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0` |
| B, every version, with `validTo` | `CREATE INDEX "idx_S_B1_q_Deal:stage" ON S_B1(json_extract(value, '$.stage'), validTo) WHERE typeName = 'Deal' AND deleted = 0` |
| C, every version, without `validTo` | `CREATE INDEX "idx_S_C1_q_Deal:stage" ON S_C1(json_extract(value, '$.stage')) WHERE typeName = 'Deal' AND deleted = 0` |
| F, B with no `WHERE` at all | `CREATE INDEX "idx_S_F1_q_Deal:stage" ON S_F1(typeName, json_extract(value, '$.stage'), validTo)` |
| Z, no `@index` | none |

- **A is `compileIndex`'s statement,** from `packages/resources/src/query/indexes.ts`, with the table renamed.
- **B and C stay partial on the type and on `deleted = 0`, and drop only the `validTo` term.** They hold every version of a Deal that is not a tombstone. That is the reading of "over every row" a real `@index` would take, since an index on a Deal's field has nothing to say about a Contact.
- **B orders the field first and `validTo` second,** so `field = ? AND validTo > ?` is one range of the index, and `field = ? AND validTo = '<sentinel>'` is the current rows, in resource-id order. The other order, `validTo` first, would make a current query a seek too and would spread one field value across the whole index for a past moment.
- **F is the literal reading,** every row of every type. It was measured for writes and size only, at depth 10.
- **Z shows what the schema costs by itself.**

Depth 10 holds A, B and C with one index and with three, plus F with one and three and Z. Depths 1 and 100 hold A, B and C with one index.

## What a write costs

Rows written by each statement, ten creates and ten updates of each type on every table. An update is shown as close + insert. Every one of the ten agreed in every cell.

| Write of a `Deal` | Z | A | B | C | F |
|---|---|---|---|---|---|
| Create, one index | 2 | 3 | 3 | 3 | 3 |
| Update, one index | 1 + 2 | 1 + 3 | 2 + 3 | 1 + 3 | 2 + 3 |
| Create, three indexes | | 5 | 5 | 5 | 5 |
| Update, three indexes | | 1 + 5 | 4 + 5 | 1 + 5 | 4 + 5 |

| Write of a `Contact` or `Task`, which has no index | Z | A | B | C | F |
|---|---|---|---|---|---|
| Create, one index on Deal | 2 | 2 | 2 | 2 | 3 |
| Update, one index on Deal | 1 + 2 | 1 + 2 | 1 + 2 | 1 + 2 | 2 + 3 |
| Create, three indexes on Deal | | 2 | 2 | 2 | 5 |
| Update, three indexes on Deal | | 1 + 2 | 1 + 2 | 1 + 2 | 4 + 5 |

Measured facts:

- **A, today: one row per index on the insert, and the close is one row whatever the index count.** Closing takes the row out of each partial index and out of `idx_…_current`, and none of that counted.
- **B: one row per index on the insert, and one more per index on the close.** The close changes `validTo`, which is a column of the index, so each index's entry is rewritten.
- **C: the same as A.** The close changes no column of the index.
- **F: every write of every type pays for every index,** on the insert and on the close.
- **Depth changes nothing.** A, B and C with one index wrote the same counts at depths 1, 10 and 100.
- **Seeding agrees with the ten.** Depth 10's 40,000 writes wrote 116,000 rows to Z, 136,177 to A with one index, 154,354 to B and 136,177 to C. B's extra 18,177 is one per update of a Deal.
- **Building an index over history writes one row per entry.** `CREATE INDEX` on depth 100's 400,061 rows reported 400,061 rows written for an index with no `WHERE`, and 200,474 for one over every version of a Deal. Today's shape over depth 10 reported 2,011, one per current Deal.

Inferences:

- **Per update of a Deal, B costs 5 rows against today's 4 with one index, and 9 against 6 with three.** Each `@index` a type declares adds two rows to its update under B and one under A.
- **The node index and the catch-up index the task file adds are plain indexes outside these arms.** The template measured them at one row per insert each, the same in any arm.

## What a read costs

The filter is `stage = 'open'` on Deal, selecting `resourceId, nodeId, validFrom, value`. Every arm's statement names its index with `INDEXED BY`, and a second statement that named none got the same plan in every case.

### A current query

| Depth | Results | A, today | B | C |
|---|---|---|---|---|
| 1 | 444 | 1.9 ms, 445 read | 2.1 ms, 445 read | 2.6 ms, 445 read |
| 10 | 392 | 5.0 ms, 393 read | 6.6 ms, 393 read | 18 ms, 4,081 read |
| 100 | 424 | 5.1 ms, 425 read | 5.4 ms, 425 read | 127 ms, 40,381 read |

- **A:** `SEARCH … USING INDEX idx_S_A1_q_Deal:stage (<expr>=?)`, in resource-id order with no sort.
- **B:** `SEARCH … USING INDEX idx_S_B1_q_Deal:stage (<expr>=? AND validTo=?)`, the same rows in the same order with no sort. Depth does not reach it. The rounds of A and B overlap at every depth.
- **C:** `SEARCH … USING INDEX idx_S_C1_q_Deal:stage (<expr>=?)`. It reads every version that ever had the value and opens each row to learn its `validTo`, so it grows with depth.

### The first-read case, and a query as of a moment

Three moments: 20 writes before the last, 1,000 writes before the last, and the midpoint of the history. The first is the first-read case.

- **Today** is the scan of current rows through A, then for each row whose `validFrom` is after M0 a read by key, `WHERE resourceId = ? AND validFrom <= ? ORDER BY validFrom DESC LIMIT 1`, with the filter tested on the row it finds.
- **B and C** run `stage = ? AND validTo > ? AND validFrom <= ?`, both bound to M0, with `ORDER BY resourceId`.
- **No index over history** is the same statement on arm A's table, where nothing serves it.

CPU is the median per read, with the lowest and highest round. "Truth" is the count every as-of arm agreed on.

**20 writes since M0:**

| Depth | Truth | Today | B | B, no `ORDER BY` | C | No index over history |
|---|---|---|---|---|---|---|
| 1 | 441 | 2.1 ms (1.9 – 3.3), 441 returned, 3 lookups | 2.7 ms (1.5 – 3.3) | 2.2 ms | 2.7 ms | 7.6 ms, 4,000 read |
| 10 | 389 | 5.7 ms (4.8 – 9.6), 389 returned, 4 lookups | 5.7 ms (4.8 – 8.2) | 4.7 ms | 18 ms | 55 ms, 40,000 read |
| 100 | 422 | 5.7 ms (5.3 – 5.9), 420 returned, 4 lookups | 5.0 ms (4.5 – 11) | 5.0 ms | 124 ms | 396 ms, 400,000 read |

**1,000 writes since M0:**

| Depth | Truth | Today | B | C |
|---|---|---|---|---|
| 1 | 322 | 8.9 ms, 322 returned, 122 lookups | 1.9 ms | 1.8 ms |
| 10 | 396 | 11 ms, 325 returned, 86 lookups | 6.5 ms | 25 ms |
| 100 | 441 | 10 ms, 356 returned, 90 lookups | 6.7 ms | 121 ms |

**M0 at the midpoint of the history:**

| Depth | Truth | Today | B | C | No index over history |
|---|---|---|---|---|---|
| 1 | 217 | 14 ms, 217 returned, 227 lookups | 1.5 ms, 662 read | 1.2 ms | 9.3 ms |
| 10 | 407 | 30 ms, 70 returned, 390 lookups | 22 ms, 2,842 read | 17 ms, 4,081 read | 55 ms |
| 100 | 389 | 24 ms, 96 returned, 424 lookups | 225 ms, 21,005 read | 201 ms, 40,381 read | 394 ms |

Plans:

- **Today:** the scan is `SEARCH S_A1 USING INDEX idx_S_A1_q_Deal:stage (<expr>=?)` and each lookup is `SEARCH S_A1 USING PRIMARY KEY (resourceId=? AND validFrom<?)`.
- **B:** `SEARCH S_B1 USING INDEX idx_S_B1_q_Deal:stage (<expr>=? AND validTo>?)`, then `USE TEMP B-TREE FOR ORDER BY`. The range comes back in `validTo` order, so resource-id order takes a sort, which is why B's `rowsRead` is its entries plus its results.
- **C:** `SEARCH S_C1 USING INDEX idx_S_C1_q_Deal:stage (<expr>=?)`, in resource-id order with no sort.
- **No index over history:** `SCAN S_A1`.

Measured facts:

- **In the first-read case today's design and B cost the same.** Their rounds overlap at every depth, and neither grows with depth.
- **Today's design returns fewer rows than matched at M0 once writes have happened.** It missed 2 of 422 after 20 writes and 85 of 441 after 1,000, at depth 100. Those are Deals that matched at M0 and do not match now, which the scan of current rows never meets. This is the case D29 accepts. Depth 1 shows no miss because its only writes are creates.
- **A lookup by key cost about 55 to 70 µs here,** from the difference between today's read and the plain current query over the lookups made, including the JavaScript around each statement. At depth 1 a lookup finds nothing, since the resource did not exist at M0, and costs the same.
- **B's cost follows the entries it walks, not the results.** At the midpoint of depth 100 it walked 20,616 entries for 389 results. Every version of an open Deal closed after M0 is in the range, and the range has no bound on `validFrom`.
- **C's cost follows every version that ever held the value,** whatever the moment: 40,381 read at depth 100 for any M0.
- **The sort is small at this result size.** B with `ORDER BY` and without differed by under 1 ms at 400 results.

### Why B's far read is slow: the expression index seeks the table for every entry

B's far read cost about 10 µs for each entry it walked, and asking only for `resourceId, validFrom` cost the same as asking for the value (205 ms against 219 ms at depth 100). Two more indexes on `S_B1` were built to find out why, after the write counts were taken:

- **X1:** `CREATE INDEX idx_S_B1_x1 ON S_B1(typeName, json_extract(value, '$.stage'), validTo, deleted)`, no `WHERE`, so every column the scan tests is in the index.
- **X2:** `CREATE INDEX idx_S_B1_x2 ON S_B1(json_extract(value, '$.stage'), validTo, validFrom) WHERE typeName = 'Deal' AND deleted = 0`, which is B with `validFrom` named.

| Depth 100, M0 at the midpoint, 389 results from 20,622 entries | CPU (median) | Plan |
|---|---|---|
| B, value selected | 202 ms | `USING INDEX` |
| B, ids only | 197 ms | `USING INDEX` |
| X1, value selected | 198 ms | `USING INDEX` |
| X1, ids only | 213 ms | `USING COVERING INDEX` |
| X2, value selected | 200 ms | `USING INDEX` |
| X2, ids only | 204 ms | `USING INDEX` |

- **Neither index helped,** and X1's ids-only read, whose plan says `COVERING INDEX`, cost what the others did.
- **`EXPLAIN`'s bytecode shows why.** After each index entry the program runs `NotFound` on the table's cursor, a seek of the row by its primary key, before it tests `deleted` or `validFrom`. It does so in the plan labelled covering as well.
- **The same index walked by its plain columns has no such seek.** `scripts/diagnose.mjs` counted `typeName = 'Contact' AND validTo > ? AND deleted = 0` through X1: 119,505 entries in about 19 ms a run, with no table seek in the bytecode. Counting `typeName = 'Deal' AND json_extract(value, '$.stage') = 'open' AND validTo > ?` through the same index walked 20,622 entries in about 200 to 225 ms. These two figures are the Worker's clock around its call to the object, not `cpuTimeMs`, and include one round trip. `results/diagnose.txt` has the output.

So, measured: on this SQLite a statement that reaches an index through `json_extract(value, …)` seeks the table row for every index entry, and no arrangement of the other columns avoids it. Inferred: the cost of a past read through an `@index` is about 10 µs for every version of a matching value closed after M0, and a filter's index cannot be read index-only as the catch-up index on `(typeName, validFrom)` can.

## Storage

`dbstat` is not there (`no such table: dbstat`), so an index's size is what `databaseSize` grew by when it was built on a table already holding its rows.

| Index | Rows in the table | Entries | Size | Per entry |
|---|---|---|---|---|
| A on `stage`, depth 10 | 40,061 | 2,011 | 0.16 MB | 77 B |
| B on `stage`, depth 10 | 40,061 | 20,198 | 2.0 MB | 99 B |
| C on `stage`, depth 10 | 40,061 | 20,198 | 1.5 MB | 74 B |
| F on `stage`, depth 10 | 40,061 | 40,061 | 4.1 MB | 103 B |
| X2 (B plus `validFrom`), depth 100 | 400,061 | 200,474 | 19.9 MB | 99 B |
| X1 (no `WHERE`), depth 100 | 400,061 | 400,061 | 41.3 MB | 103 B |

Depth 100's object was 932 MB for three tables before the extra indexes, about 310 MB a table. So, inferred from X2, B's index on one field is about 6% of the table it indexes when the type is half the rows, and it grows with every version where A's grows with resources.

## What follows for the design

These are inferences from the numbers above.

- **B answers the question the first read needs, at today's read cost, for one more row written per index on every update.** It also serves the current query at today's cost, so it would replace A, not join it.
- **B does not give a paged first read its order.** The range comes back by `validTo`, and a page that resumes past a resource id cannot seek into it. The current rows inside the index are in resource-id order, under `validTo = '<sentinel>'`, and the rows closed since M0 are a second, short range. A paged read through B would be those two ranges, which was not measured.
- **B does not make a query as of a far moment cheap.** That read walks every version of the value closed since, at 10 µs each because of the table seek. A chart of six months would need something else, and the task file already sends that to R2.
- **C is ruled out by its current query.**
- **The write cost of B falls on every update of an indexed type, and the read it improves is one too long for one page that also overlaps a write.** The first-read case showed no CPU difference, so the whole benefit is the rows D29 accepts missing.

## What was not measured

- **A paged read.** Every read here is whole. How B pages, by the two ranges above or by sorting, is unmeasured.
- **Deletes and moves.** No tombstone was written, so `deleted = 0` never excluded a row.
- **Filters other than one equality,** including ranges, `$in`, and an index on several fields.
- **The CPU of a write.** Only rows written were counted.
- **The index order `(validTo, field)` and an index on `(field, validFrom)`.**
- **A generated column or any other way to index the field without `json_extract` in the statement,** which might avoid the table seek.
- **The real `Snapshots` class.** The object runs the same statements against a copy of the table.
- **The SQLite version.** `sqlite_version()` is not authorized.
- **Host-to-host variation.** Each depth is one object, so a depth's arms are comparable and two depths are less so. Rounds of one case differed by up to about 2×, and a handful of the empty invocations used to anchor the join reported CPU of up to 51 ms where the median was 0.
- **A stage that changes less often.** Every write picks a new `stage`, which is the most churn the index can see. With less, fewer results leave between M0 and now, and fewer entries sit in B's range.

## Running it

```sh
cd experiments/asof-index-cost
npx wrangler deploy
export BASE=https://experiment-asof-index-cost.<account>.workers.dev
node scripts/seed.mjs                                   # about ten minutes
MODE=reads node scripts/measure.mjs                     # ONLY='^d100\.' runs one depth
node scripts/logs.mjs results/reads-<time>.json
node scripts/tables.mjs results/reads-<time>.json
MODE=writes node scripts/measure.mjs                    # after the reads: it adds rows
MODE=sizes node scripts/measure.mjs                     # builds each arm's index on S_Z0
MODE=extra node scripts/measure.mjs                     # builds X1 and X2 on S_B1, then times them
node scripts/diagnose.mjs
```

`BENCH_TOKEN` is a Worker secret, and the driver reads it from this folder's `.dev.vars`. `results/` holds each run's JSON, with every statement and plan, and a `.md` of its tables beside each reads run. The reads ran one depth per file. `MODE=sizes` and `MODE=extra` add indexes to depth 10's `S_Z0` and to `S_B1`, so write counts taken after them on those tables would differ.
