# query-subtree-and-catchup: how a query reads its node's subtree, and how a catch-up finds what changed

**Questions.** `tasks/nebula-query-upgrade.md` tabled Q2 and Q6 on one experiment.

- **Q2.** Every query will name a node and answer what sits at or beneath it. How should the statement read only that subtree: (a) the subtree bound as one JSON array, (b) the same plus an index on `Snapshots(nodeId, typeName)` over current rows, or (c) one statement per node with (b)'s index?
- **Q6.** A catch-up names the moment a client holds. How does the plane find what was written since: (a) an index on `Snapshots(typeName, validFrom)` over every row, (b) no index and a scan, or (d) an index on `Snapshots(validFrom)` alone?

**Answers.** Measured on a deployed Worker, in objects holding 30,000 resources in 120,000 versions under a tree of 4,111 nodes.

- **Each added index costs one more row written on every write, create or update alike.** Closing the row before a write counted one row in every configuration, whatever indexes it left. So Q2's (b) costs a write what Q6's (a) or (d) does, one row each.
- **Q2: (a) is right whenever the filter has an index, at any subtree size.** It reads what the filter's index finds across the type, already in resource-id order, so it needs no sort and a page resumes by a seek. A filter on `stage` cost 18 to 27 ms of CPU from a one-node subtree to the root, and one on `owner` 0.1 to 1.4 ms.
- **Q2: (a) is slow for a filter of `{}`.** It walks every current row of every type on the host, 30,000 here, whatever the node: about 100 ms of CPU to answer 12 results under a 4-node subtree.
- **Q2: the node index fixes `{}` and must not be used for a filtered query at a large subtree.** `{}` under 4 nodes drops from 106 ms to 55 µs. A filter on `owner` at the root goes the other way, from 1.4 ms to 152 ms. SQLite makes that split by itself when the index is ordered `(nodeId, typeName)`: the filter's index when there is one, the node index for `{}`.
- **Q2: (c) is never the cheapest in CPU.** It reads the fewest rows and costs about twice (b) at every size past a few nodes, 370 ms against 164 ms at the root.
- **Q2, not in the brief: the node index can replace `idx_Snapshots_current` instead of joining it, and then costs a write nothing.** The only reader of `idx_Snapshots_current` these statements showed is (a)'s walk for `{}`, which the node index serves better. An object built that way wrote exactly as many rows as today's schema and read as (b) does.
- **Q6: (a).** A one-type catch-up that missed 10,000 writes found its 4,048 in 5.2 ms from the index alone. (d) took 134 ms for the same answer, because it has to open the row of every type's write to learn its type. (b) scanned all 120,000 rows on every catch-up, 84 ms even when one write was missed, and that grows with the host's whole history.
- **Larry's suspicion holds, by the plan and by CPU, and `rowsRead` cannot show it.** The range read over `(typeName, validFrom)` is a covering-index search and cost 5.2 ms for 4,048 writes. Selecting the row's columns cost 63 ms, and a `WHERE` over the value's fields and the node 52 ms. `rowsRead` was 4,049 for the covering read and for the one that opens each row, because the cursor counts an index entry and the row it leads to as one.
- **Finding the writes is a small part of a catch-up.** Reading each changed resource at both moments by its key cost about 30 µs a read, so the catch-up above cost 222 ms in all, of which the find was 5 ms.

The sections that follow give the method, what a write costs, then each question's tables and plans, and end with the recommendations.

## Method

`experiment-query-subtree-and-catchup`, deployed 2026-11-23 with compatibility date 2026-10-01, wrangler 4.147.0. It ran deployed only: the object's own clock cannot time synchronous work, and Workers Logs, which can, exists nowhere else.

- **The schema** is `Snapshots`, `Nodes` and `Edges` as `packages/resources` creates them, with `idx_Snapshots_current`, and `@index`-style indexes written as `compileIndex` writes them: `Deal` on `stage`, `Deal` on `owner`, `Contact` on `company`. `Task` and `Note` have none.
- **The tree** has 4,111 nodes: a root, 10 children, 100 beneath those, 1,000 beneath those and 3,000 leaves, with twenty nodes given a second parent. A subtree is 1, 4, 41, 411 or 4,111 nodes.
- **The data** is 120,000 writes, one moment each, 1 ms apart. Every fourth creates a resource and the rest update one picked at random, so 30,000 resources hold about four versions each: 12,000 `Deal`, 9,000 `Contact`, 6,000 `Task`, 3,000 `Note`. Each resource sits at one node picked at random over the whole tree, about three `Deal`s a node. A value is 200 to 1,100 bytes of structured-clone text and a row about 1.2 kB, so an object is about 150 MB. `src/fixture.js` derives all of it from an index, so every object holds the same rows.
- **One object per index configuration,** so each row is written as a live host would write it:

  | Object | Indexes beyond the schema's | Serves |
  |---|---|---|
  | `base` | none | Q2 (a), Q6 (b) |
  | `node` | `idx_Snapshots_node` on `(nodeId, typeName)` where `validTo` is the end of time and `deleted = 0` | Q2 (b), (c) |
  | `tm` | `idx_Snapshots_typeMoment` on `(typeName, validFrom)` | Q6 (a) |
  | `m` | `idx_Snapshots_moment` on `(validFrom)` | Q6 (d) |
  | `swap` | `idx_Snapshots_node`, and no `idx_Snapshots_current` | the variant in § *Q2* |
  | `all` | every index above | paired timing |

- **Counts** come from the sql cursor: `rowsRead` and `rowsWritten` of each statement, and `EXPLAIN QUERY PLAN` run with the same parameters.
- **CPU** is `cpuTimeMs` of the object's invocation in Workers Logs. A timed call runs one case `reps` times and nothing else, sized for about 250 ms of work since `cpuTimeMs` is whole milliseconds, and logs `{ probe, seq }` first so `scripts/logs.mjs` can join it. Every one of the 2,196 timed calls joined. An empty invocation read 0 ms.
- **CPU is compared within one object.** Two objects ran the same statement by the same plan up to 2× apart: a range read of 2,417 rows took 22 ms on `base`, 20 on `node`, 40 on `tm` and 34 on `m`. So every CPU figure below is from `all`, with each arm's index named in its statement by `INDEXED BY`, five rounds in a new random order each, and the median taken. Rounds of one case differed by a median of 1.6×, 3.5× at worst. The one-object-per-configuration run supplies the plans SQLite picks when no index is named, and `rowsRead` and each plan were the same in both runs.
- **Q6's (b) has no paired form.** `NOT INDEXED` did not stop SQLite using a secondary index on a `WITHOUT ROWID` table: the plan still named `idx_Snapshots_typeMoment`. Its CPU is from `base`, whose host ran the control statements at `all`'s speed (22 against 23 ms, 10 against 9.2 ms).
- **Row reads here are mostly cache misses.** A SQLite-backed object caches 2,000 KiB of pages and each object is 150 MB, so a read by key cost about 30 µs, against 9 to 20 µs for a cached one in [`do-read-cache`](../do-read-cache/RESULTS.md). A smaller host reads rows more cheaply, and the index-only reads change least.

### What `rowsRead` counts

The plans and counts together show what the cursor adds up, which matters for reading every table below.

- **An index entry and the row it leads to count as one.** A covering read and one that opens each row report the same number.
- **Each element of a `json_each` array counts as a row, once per statement.** Binding the root's subtree adds 4,111 to every statement that names it.
- **Each row through a sort counts again.** A plan with `USE TEMP B-TREE FOR ORDER BY` reads its results twice.
- **Each seek into an index counts about one more,** so one statement per node reads fewer rows than one statement with an `IN`.

## What a write costs

Rows written by each statement of a write, on the seeded objects, ten creates and ten updates of each type. An update is `UPDATE … SET validTo` on the row before it, then the `INSERT`.

| Write | `base` | `node` | `tm` | `m` | `swap` |
|---|---|---|---|---|---|
| `Deal` create (two `@index`es) | 4 | 5 | 5 | 5 | 4 |
| `Deal` update | 1 + 4 | 1 + 5 | 1 + 5 | 1 + 5 | 1 + 4 |
| `Contact` create (one `@index`) | 3 | 4 | 4 | 4 | 3 |
| `Contact` update | 1 + 3 | 1 + 4 | 1 + 4 | 1 + 4 | 1 + 3 |
| `Task` or `Note` create (none) | 2 | 3 | 3 | 3 | 2 |
| `Task` or `Note` update | 1 + 2 | 1 + 3 | 1 + 3 | 1 + 3 | 1 + 2 |

- **An index adds one row to the insert and nothing to the close,** partial or not. The task file expected (b) to pay again when a write closes the row before it. It does not: the close counted one row on every object, though it takes the old row out of up to four partial indexes.
- **Seeding agrees.** The 120,000 writes wrote 462,275 rows on `base` and on `swap`, and 582,275 on each of `node`, `tm` and `m`: 120,000 more, one per write.
- **In money,** one more row per write is $1 per million writes at $1.00 per million rows written. On this data a write averaged 3.85 rows before, so it is about a quarter more.
- **In storage,** the node index added 3.7 MB to 147.3 MB, and each moment index about 9.5 MB, about 80 bytes per version.

## Q2: how a query reads only its node's subtree

Every statement selects `resourceId, nodeId, validFrom, value` for `Deal`, opens with the text `currentRowsSql` writes, and returns each result's whole value, as the upgraded query will. The filters are `{ stage: 'open' }`, which an index serves and 2,416 `Deal`s match, `{ owner: 'u0042' }`, which an index serves and 54 match, and `{}`.

### The plans

**(a)**, on `base`, with a filter:

```sql
SELECT … FROM Snapshots
WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0
  AND json_extract(value, '$.stage') = ?
  AND nodeId IN (SELECT value FROM json_each(?))
ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:stage (<expr>=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

No sort: the table is `WITHOUT ROWID`, so the index carries `resourceId` after the field, and one `stage` is already in resource-id order. With `AND resourceId > ?` for a page, the plan becomes `(<expr>=? AND resourceId>?)`, a seek to where the last page stopped.

**(a)**, on `base`, with `{}`:

```text
SCAN Snapshots USING INDEX idx_Snapshots_current
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

Every current row of every type, in resource-id order, each opened to test its type and node. A page seeks, `SEARCH … idx_Snapshots_current (resourceId>?)`.

**(b)**, on `node`, the same statements with no index named. With a filter SQLite keeps the filter's index, the plan above. With `{}`:

```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
```

The sort is for `ORDER BY resourceId`. Written `ORDER BY nodeId, resourceId`, the same search needs none.

**(c)**, on `node`, once per node:

```sql
SELECT … FROM Snapshots WHERE nodeId = ? AND typeName = 'Deal' AND validTo = '…' AND deleted = 0 ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
```

### One whole read

`(b) by node` is (b)'s index named in the statement, ordered by node then resource id. (c)'s rows are merged and sorted by resource id in JavaScript. CPU is paired, on `all`.

Filter `{ stage: 'open' }`:

| Nodes in subtree | Results | Rows read (a) | (b) by node | (c) | CPU (a) | (b) by node | (c) |
|---|---|---|---|---|---|---|---|
| 1 | 0 | 2,418 | 7 | 5 | 18 ms | 55 µs | 44 µs |
| 4 | 1 | 2,421 | 24 | 16 | 18 ms | 82 µs | 164 µs |
| 41 | 22 | 2,458 | 236 | 154 | 18 ms | 1.5 ms | 3.2 ms |
| 411 | 242 | 2,836 | 2,552 | 1,714 | 19 ms | 19 ms | 38 ms |
| 4,111 | 2,416 | 6,528 | 24,104 | 15,882 | 27 ms | 170 ms | 368 ms |

Filter `{ owner: 'u0042' }`:

| Nodes in subtree | Results | Rows read (a) | (b) by node | (c) | CPU (a) | (b) by node | (c) |
|---|---|---|---|---|---|---|---|
| 1 | 0 | 56 | 7 | 5 | 111 µs | 52 µs | 42 µs |
| 4 | 0 | 59 | 24 | 16 | 104 µs | 75 µs | 146 µs |
| 41 | 0 | 96 | 236 | 154 | 113 µs | 1.4 ms | 5.1 ms |
| 411 | 1 | 474 | 2,552 | 1,714 | 232 µs | 20 ms | 40 ms |
| 4,111 | 54 | 4,166 | 24,104 | 15,882 | 1.4 ms | 147 ms | 323 ms |

Filter `{}`:

| Nodes in subtree | Results | Rows read (a) | (b) by node | (c) | CPU (a) | (b) by node | (c) |
|---|---|---|---|---|---|---|---|
| 1 | 4 | 30,001 | 7 | 5 | 101 ms | 38 µs | 44 µs |
| 4 | 12 | 30,004 | 24 | 16 | 106 ms | 55 µs | 161 µs |
| 41 | 116 | 30,041 | 236 | 154 | 101 ms | 1.6 ms | 3.2 ms |
| 411 | 1,312 | 30,419 | 2,552 | 1,714 | 109 ms | 18 ms | 37 ms |
| 4,111 | 12,000 | 34,111 | 24,104 | 15,882 | 146 ms | 164 ms | 370 ms |

- **(a)'s cost is set by the filter and not by the node.** It reads every row the filter's index finds across the type and drops those outside the subtree, so a small subtree costs what the root does. That is cheap when the filter is selective and 100 ms when the filter is `{}`.
- **The node index's cost is set by the subtree and not by the filter.** It reads every current `Deal` under the subtree and tests the filter on each, about 13 µs a row. It wins below about 400 nodes against `stage` and below about 4 against `owner`.
- **At the root the two meet for `{}`,** 146 against 164 ms for 12,000 results, since both read every current `Deal`.
- **(c) costs a statement per node,** about 40 µs each before any row, so it trails (b) at every size past a few nodes and reads fewer rows only because it has no array to count.
- **With (b)'s index ordered by resource id instead, the sort costs little CPU** (171 ms at the root for `{}`) but holds the whole result, which a page cannot (below).

### A first read cut into pages

`{}` at the root, 12,000 results and 4.3 MB of values, read to the end in one invocation. A page ends once its values pass the budget. CPU is paired.

| Arm | Rows read, 2 MB pages (3) | CPU | Rows read, 250 kB pages (18) | CPU |
|---|---|---|---|---|
| (a): by resource id, `resourceId > ?` | 42,337 | 141 ms | 104,052 | 170 ms |
| (b): by resource id, `resourceId > ?`, a sort per page | 68,419 | 265 ms | 344,220 | 1,471 ms |
| (b): by node then resource id, the whole subtree bound each page | 59,968 | 352 ms | 270,688 | 1,524 ms |
| (b): by node then resource id, only the nodes not yet finished bound | 26,649 | 161 ms | 57,661 | 192 ms |
| (c): node by node, `resourceId > ?` within the node | 16,113 | 364 ms | 16,128 | 340 ms |

`{ stage: 'open' }` at the root, 2,416 results, in 250 kB pages (4): (a) read 18,864 rows in 33 ms, (b) with only the unfinished nodes bound 29,306 in 162 ms, (c) 16,117 in 343 ms.

- **(a) pages for almost nothing.** Each page seeks to the last resource id. Its rows read grow with the page count only because every statement counts the 4,111 node ids again.
- **(b) pages well only one way:** ordered by node then resource id, with a cursor of both, and with the array holding only the nodes from the cursor's node on. The plane holds the tree, so it can drop the nodes a page has finished.
- **(b) ordered by resource id sorts the rest of the result on every page,** 1.5 s for 18 pages, and the sort holds every remaining value, which DI18 rules out.
- **(b) with the whole subtree bound re-reads every finished node on every page.** The cursor `(nodeId, resourceId) > (?, ?)` is tested on each row and does not bound the search.

### Which index SQLite picks

Nothing in a statement tells SQLite how big the subtree is, so its choice does not change with it.

- **With (b)'s index, ordered `(nodeId, typeName)`,** SQLite kept the filter's index for `stage` and `owner` and used the node index for `{}`, at every subtree size. That is the right choice at the root and the wrong one for `stage` under a few nodes, 18 ms where the node index takes 82 µs.
- **`ANALYZE` is allowed and does not help.** It read 450,741 rows and wrote 10. After it, SQLite used the node index for `stage` at every size, the root included (26,520 rows read where the filter's index reads 6,528), and the filter's index for `owner` at every size. `results/tables-after-analyze.md` has the plans.
- **Ordered `(typeName, nodeId)`, the index is chosen over the filter's own, always.** `owner` at the root then read 24,158 rows in about 125 ms where the filter's index reads 4,166 in 1.4 ms. `results/tables-swap-type-first.md` has that run.

### The node index in place of `idx_Snapshots_current`

`idx_Snapshots_current` is `(resourceId, validTo)` over current rows. In these statements its one use is (a)'s walk for `{}`. `#getCurrentSnapshot`'s own comment says SQLite reads the primary key there instead.

The `swap` object drops it and creates `idx_Snapshots_node` in its place.

- **It costs a write nothing:** the table in § *What a write costs*, and the same 462,275 rows as `base` over the seed.
- **SQLite picks as it does for (b):** the filter's index for `stage` and `owner`, the node index for `{}`, at 4 nodes and at 4,111. Rows read matched (b)'s in every case.
- **A statement with no node clause loses its index.** `SELECT … WHERE typeName = 'Deal' AND validTo = '…' AND deleted = 0` with no filter became `SCAN Snapshots`, 120,000 rows where `idx_Snapshots_current` gave 30,000. After the upgrade every query names a node, so every such statement has the `IN`.
- **`Snapshots`' own `WHERE validTo = ? AND deleted = 0 LIMIT ?`** read 100 rows for 100 results through either index.

## Q6: how a catch-up finds what was written since a moment

A catch-up that missed N writes holds the moment of write 120,000 − N. Of 10,000 missed writes, 4,048 were to a `Deal`, 961 to a `Note`, and 9,039 to a `Deal`, `Contact` or `Task`. The find is:

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```

### The plans

| | One type | Every type, no type test |
|---|---|---|
| (a) `(typeName, validFrom)` | `SEARCH … USING COVERING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)` | `SCAN … USING COVERING INDEX idx_Snapshots_typeMoment`, then a sort |
| (b) no index | `SCAN Snapshots`, then a sort | `SCAN Snapshots`, then a sort |
| (d) `(validFrom)` | `SEARCH … USING INDEX idx_Snapshots_moment (validFrom>?)`, each row opened for its type | `SEARCH … USING COVERING INDEX idx_Snapshots_moment (validFrom>?)` |

Under (a), selecting `nodeId`, `deleted` and `value` as well turns `COVERING INDEX` into `INDEX`: each row is opened. `typeName IN (?, ?, ?)` stays covering and adds `USE TEMP B-TREE FOR ORDER BY`.

### The measurements

CPU for (a) and (d) is paired, on `all`. (b) is from `base`. `Rows read` is the find, then the reads by key where the row has them.

Missed 10,000 writes:

| Types | What is read | Found | Rows read (a) | (b) | (d) | CPU (a) | (b) | (d) |
|---|---|---|---|---|---|---|---|---|
| `Deal` | ids and moments | 4,048 | 4,049 | 124,048 | 10,000 | 5.2 ms | 106 ms | 134 ms |
| `Deal` | the rows too | 4,048 | 4,049 | 124,048 | 10,000 | 63 ms | 116 ms | 138 ms |
| `Deal` | ids, `WHERE` over `stage` and the node | 855 | 8,160 | 124,966 | 14,111 | 52 ms | 93 ms | 137 ms |
| `Deal` | ids, then both versions by key | 4,048 | 4,049 + 7,136 | 124,048 + 7,136 | 10,000 + 7,136 | 222 ms | 345 ms | 337 ms |
| `Deal` | rows, then the earlier version by key | 4,048 | 4,049 + 3,568 | 124,048 + 3,568 | 10,000 + 3,568 | 205 ms | 369 ms | 276 ms |
| `Note` | ids and moments | 961 | 962 | 120,961 | 10,000 | 1.4 ms | 83 ms | 134 ms |
| `Note` | ids, then both versions by key | 961 | 962 + 1,698 | 120,961 + 1,698 | 10,000 + 1,698 | 59 ms | 154 ms | 170 ms |
| several | ids, one statement per type | 9,039 | 9,041 | 369,039 | 30,000 | 14 ms | 297 ms | 415 ms |
| several | ids, one statement, `typeName IN` | 9,039 | 18,083 | 129,039 | 10,000 | 22 ms | 193 ms | 150 ms |
| every type | ids, no type test | 10,000 | 130,000 | 130,000 | 10,000 | 54 ms | 125 ms | 15 ms |
| every type | ids and `typeName`, no type test | 10,000 | 130,000 | 130,000 | 10,000 | 65 ms | 116 ms | 164 ms |

Missed 100 writes:

| Types | What is read | Found | Rows read (a) | (b) | (d) | CPU (a) | (b) | (d) |
|---|---|---|---|---|---|---|---|---|
| `Deal` | ids and moments | 42 | 43 | 120,042 | 100 | 82 µs | 79 ms | 235 µs |
| `Deal` | the rows too | 42 | 43 | 120,042 | 100 | 194 µs | 83 ms | 264 µs |
| `Deal` | ids, then both versions by key | 42 | 43 + 84 | 120,042 + 84 | 100 + 84 | 1.8 ms | 89 ms | 2.2 ms |
| `Note` | ids and moments | 10 | 11 | 120,010 | 100 | 36 µs | 81 ms | 154 µs |
| several | ids, one statement per type | 90 | 92 | 360,090 | 300 | 211 µs | 272 ms | 602 µs |
| several | ids, one statement, `typeName IN` | 90 | 185 | 120,090 | 100 | 161 µs | 91 ms | 271 µs |
| every type | ids, no type test | 100 | 120,100 | 120,100 | 100 | 15 ms | 85 ms | 141 µs |

Missed 1 write, a `Deal`:

| Types | What is read | Found | Rows read (a) | (b) | (d) | CPU (a) | (b) | (d) |
|---|---|---|---|---|---|---|---|---|
| `Deal` | ids and moments | 1 | 2 | 120,001 | 1 | 21 µs | 84 ms | 23 µs |
| `Deal` | ids, then both versions by key | 1 | 2 + 2 | 120,001 + 2 | 1 + 2 | 65 µs | 83 ms | 64 µs |
| several | ids, one statement per type | 1 | 4 | 360,003 | 3 | 58 µs | 234 ms | 69 µs |
| several | ids, one statement, `typeName IN` | 1 | 8 | 120,001 | 1 | 43 µs | 87 ms | 31 µs |
| every type | ids, no type test | 1 | 120,001 | 120,001 | 1 | 15 ms | 80 ms | 13 µs |

- **(a) reads in proportion to this type's missed writes,** about 1.3 µs each, and touches no row.
- **(d) reads in proportion to every type's missed writes, and opens each row** unless the statement tests no type, about 13 µs each. A `Note` catch-up that missed 10,000 writes costs what a `Deal` one does, 134 ms, to find 961. It is the cheapest only for a read across every type that needs nothing but ids, 15 ms against (a)'s 54.
- **(b) costs a scan of the whole history however little was missed:** 84 ms and 120,001 rows read to find one write. It is about 0.7 µs a row, so it grows with every version the host has ever written, and ADR-004 never deletes one.
- **The index-only read is real and `rowsRead` hides it.** Under (a), reading ids and reading whole rows report the same `rowsRead`, 4,049. The plan says `COVERING INDEX` for the ids and `INDEX` for the rows, and CPU says 5.2 ms against 63.
- **A `WHERE` over the value's fields costs what opening the rows costs,** 52 ms, and still cannot find a result that left, since the newer version it tests no longer matches.
- **Reading both versions is where a catch-up's time goes.** 7,136 reads by key cost about 217 ms, 30 µs each, forty times the find. Fetching the newer version in the find statement and only the earlier by key came to the same, 205 against 222 ms.
- **Several types: one statement per type, merged in JavaScript, is the cheapest,** 14 ms for 9,039 writes, each statement a covering search already in write order. `typeName IN` sorts and took 22 ms. Both are small beside the reads by key that follow.

## Recommendations

### Q6: (a), an index on `Snapshots(typeName, validFrom)`

- **It costs one more row written on every write of every type,** create or update, and about 80 bytes a version.
- **It makes a catch-up's find proportional to what its own type missed,** read from the index alone and in the order DI16 cuts pages in.
- **Read ids and moments from the index, then each changed resource by its key.** Nothing is saved by selecting the row's columns in the find, and reading by key is what lets the plane stop at a page's budget without opening rows past it.
- **(d) is the same price for a worse read,** unless a query across every type with no type test is wanted, which nothing in the task file asks for.
- **(b) saves the row per write and charges every catch-up a scan of the host's whole history.** At $0.001 per million rows read the scan is nearly free in money. What it costs is the Durable Object's time, 84 ms at 120,000 versions and more with every write, during which the object serves nothing else.

### Q2: (a) for a filter an index serves, and the node index for a query that scans

- **Keep (a) as the statement for every query whose filter has an index.** It costs a write nothing, needs no sort, and pages by a seek on resource id.
- **Add the node index for the queries that would otherwise walk every current row,** `{}` and any filter read with `allowScan`. A list queried at one person's node is that case, and D6 sends pages there.
- **Create it in place of `idx_Snapshots_current`, ordered `(nodeId, typeName)`.** Beside it, it is (b) and costs one row per write. In its place it costs nothing, and SQLite picks between it and the filter's index as it does for (b).
- **A query that scans pages by node, then resource id,** with a cursor of both and only the unfinished nodes bound. A first read then has a second order, and `compileQuery`'s `scans` already says which one a query takes. The cursor is the server's, so no caller sees the order, but DI17 says "ordered by resource id" and would need the second order named.
- **Do not use (c),** and do not order the index `(typeName, nodeId)` or run `ANALYZE`.
- **If a second page order is more than this is worth,** (a) alone is the fallback: correct everywhere, and 100 ms per 30,000 resources on the host for each first read of a `{}` query.

## What this did not measure

- **Other shapes of data.** Resources are spread evenly over the tree. A host with most of a type under one node moves where (a) and the node index cross, and not which reads what.
- **Moves and tombstones.** No resource changes node and none is deleted. The node index excludes a tombstone, so a delete would write one row fewer than an update.
- **A first read as of the moment it began.** DI17 reads a result written since by its key at that moment. That is one more read by key, about 30 µs here, for each such result.
- **A catch-up that reads nothing.** DI15 has the plane store each live query's last push moment. A catch-up naming a moment at or after it has nothing to find, whichever answer Q6 takes. That is a design note, and no run here tests it.
- **Statements outside these.** The swap was checked against the statements above and the one `Snapshots` statement that reads current rows without a type. A grep of `packages/resources/src` for other readers of current rows found none.

## Reproduce

```bash
npx wrangler deploy
```
```bash
BASE=https://experiment-query-subtree-and-catchup.<account>.workers.dev node scripts/seed.mjs
```
```bash
BASE=… node scripts/measure.mjs
```
```bash
BASE=… PAIRED=1 ROUNDS=5 LABEL=paired node scripts/measure.mjs
```
```bash
node scripts/logs.mjs results/run-<time>.json
```
```bash
node scripts/tables.mjs results/run-<time>.json
```

`BENCH_TOKEN` is a Worker secret, and the driver reads it from this folder's `.dev.vars`. `results/` holds each run's JSON, with every plan and statement, and a `tables-*.md` beside it: `unpaired` and `paired` are the main runs, `paired-swap` and `swap-type-first` the swap variant, `after-analyze` the `ANALYZE` probe, `controls` the same statement on each object, and `writes` the rows written. The `swap` object was seeded with the type-first index and then switched to `idx_Snapshots_node` by hand, and `all` gained the type-first index the same way, so a fresh seed needs those steps repeated to match.
