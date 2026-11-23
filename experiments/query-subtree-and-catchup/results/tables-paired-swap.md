<!-- from run-2026-11-23T17-01-41-902Z-paired-swap.json, run 2026-11-23T17:01:41.902Z to 2026-11-23T17:11:39.809Z -->

### Q2 whole read, filter `stage`

Rows read:

| Nodes in subtree | Results | (a) | (b-node-nodeorder) | (swap-node) |
| --- | --- | --- | --- | --- |
| 1 | 0 | 2,418 | 7 | 7 |
| 4 | 1 | 2,421 | 24 | 24 |
| 41 | 22 | 2,458 | 236 | 236 |
| 411 | 242 | 2,836 | 2,552 | 2,552 |
| 4,111 | 2,416 | 6,528 | 24,104 | 24,104 |

CPU:

| Nodes in subtree | Results | (a) | (b-node-nodeorder) | (swap-node) |
| --- | --- | --- | --- | --- |
| 1 | 0 | 17 ms | 57 µs | 60 µs |
| 4 | 1 | 19 ms | 85 µs | 88 µs |
| 41 | 22 | 19 ms | 1.5 ms | 1.5 ms |
| 411 | 242 | 18 ms | 18 ms | 18 ms |
| 4,111 | 2,416 | 26 ms | 153 ms | 158 ms |

### Q2 whole read, filter `owner`

Rows read:

| Nodes in subtree | Results | (a) | (b-node-nodeorder) | (swap-node) |
| --- | --- | --- | --- | --- |
| 1 | 0 | 56 | 7 | 7 |
| 4 | 0 | 59 | 24 | 24 |
| 41 | 0 | 96 | 236 | 236 |
| 411 | 1 | 474 | 2,552 | 2,552 |
| 4,111 | 54 | 4,166 | 24,104 | 24,104 |

CPU:

| Nodes in subtree | Results | (a) | (b-node-nodeorder) | (swap-node) |
| --- | --- | --- | --- | --- |
| 1 | 0 | 104 µs | 56 µs | 95 µs |
| 4 | 0 | 119 µs | 77 µs | 82 µs |
| 41 | 0 | 123 µs | 1.4 ms | 1.5 ms |
| 411 | 1 | 256 µs | 18 ms | 18 ms |
| 4,111 | 54 | 1.5 ms | 154 ms | 161 ms |

### Q2 whole read, filter `all`

Rows read:

| Nodes in subtree | Results | (a) | (b-node-nodeorder) | (swap-node) |
| --- | --- | --- | --- | --- |
| 1 | 4 | 30,001 | 7 | 7 |
| 4 | 12 | 30,004 | 24 | 24 |
| 41 | 116 | 30,041 | 236 | 236 |
| 411 | 1,312 | 30,419 | 2,552 | 2,552 |
| 4,111 | 12,000 | 34,111 | 24,104 | 24,104 |

CPU:

| Nodes in subtree | Results | (a) | (b-node-nodeorder) | (swap-node) |
| --- | --- | --- | --- | --- |
| 1 | 4 | 104 ms | 35 µs | 30 µs |
| 4 | 12 | 102 ms | 50 µs | 55 µs |
| 41 | 116 | 105 ms | 1.5 ms | 1.5 ms |
| 411 | 1,312 | 105 ms | 18 ms | 19 ms |
| 4,111 | 12,000 | 135 ms | 161 ms | 163 ms |

### Q2 first read in pages

| Filter | Nodes | Page | Arm | Results | Statements | Pages | Rows read, all pages | Rows read, first three pages | CPU, all pages |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 411 | 2000 kB | (a) | 1,312 | 1 | 1 | 30,419 | 30,419 | 106 ms |
| all | 411 | 2000 kB | (b-node-nodeorder) | 1,312 | 1 | 1 | 2,552 | 2,552 | 19 ms |
| all | 411 | 2000 kB | (b-node-rest) | 1,312 | 1 | 1 | 2,552 | 2,552 | 18 ms |
| all | 411 | 2000 kB | (swap-rest) | 1,312 | 1 | 1 | 2,552 | 2,552 | 18 ms |
| all | 411 | 250 kB | (a) | 1,312 | 2 | 2 | 30,853 | 15,822, 15,031 | 121 ms |
| all | 411 | 250 kB | (b-node-nodeorder) | 1,312 | 2 | 2 | 4,128 | 1,576, 2,552 | 26 ms |
| all | 411 | 250 kB | (b-node-rest) | 1,312 | 2 | 2 | 2,747 | 1,576, 1,171 | 19 ms |
| all | 411 | 250 kB | (swap-rest) | 1,312 | 2 | 2 | 2,747 | 1,576, 1,171 | 19 ms |
| all | 4,111 | 2000 kB | (a) | 12,000 | 3 | 3 | 42,337 | 17,820, 18,075, 6,442 | 142 ms |
| all | 4,111 | 2000 kB | (b-node-nodeorder) | 12,000 | 3 | 3 | 59,968 | 13,281, 22,583, 24,104 | 340 ms |
| all | 4,111 | 2000 kB | (b-node-rest) | 12,000 | 3 | 3 | 26,649 | 13,281, 11,539, 1,829 | 162 ms |
| all | 4,111 | 2000 kB | (swap-rest) | 12,000 | 3 | 3 | 26,649 | 13,281, 11,539, 1,829 | 166 ms |
| all | 4,111 | 250 kB | (a) | 12,000 | 18 | 18 | 104,052 | 5,767, 5,742, 5,824 | 172 ms |
| all | 4,111 | 250 kB | (b-node-nodeorder) | 12,000 | 18 | 18 | 270,688 | 5,292, 6,452, 7,574 | 1389 ms |
| all | 4,111 | 250 kB | (b-node-rest) | 12,000 | 18 | 18 | 57,661 | 5,292, 5,032, 4,742 | 176 ms |
| all | 4,111 | 250 kB | (swap-rest) | 12,000 | 18 | 18 | 57,661 | 5,292, 5,032, 4,742 | 192 ms |
| stage | 411 | 2000 kB | (a) | 242 | 1 | 1 | 2,836 | 2,836 | 18 ms |
| stage | 411 | 2000 kB | (b-node-nodeorder) | 242 | 1 | 1 | 2,552 | 2,552 | 18 ms |
| stage | 411 | 2000 kB | (b-node-rest) | 242 | 1 | 1 | 2,552 | 2,552 | 27 ms |
| stage | 411 | 2000 kB | (swap-rest) | 242 | 1 | 1 | 2,552 | 2,552 | 17 ms |
| stage | 411 | 250 kB | (a) | 242 | 1 | 1 | 2,836 | 2,836 | 18 ms |
| stage | 411 | 250 kB | (b-node-nodeorder) | 242 | 1 | 1 | 2,552 | 2,552 | 18 ms |
| stage | 411 | 250 kB | (b-node-rest) | 242 | 1 | 1 | 2,552 | 2,552 | 18 ms |
| stage | 411 | 250 kB | (swap-rest) | 242 | 1 | 1 | 2,552 | 2,552 | 17 ms |
| stage | 4,111 | 2000 kB | (a) | 2,416 | 1 | 1 | 6,528 | 6,528 | 25 ms |
| stage | 4,111 | 2000 kB | (b-node-nodeorder) | 2,416 | 1 | 1 | 24,104 | 24,104 | 157 ms |
| stage | 4,111 | 2000 kB | (b-node-rest) | 2,416 | 1 | 1 | 24,104 | 24,104 | 154 ms |
| stage | 4,111 | 2000 kB | (swap-rest) | 2,416 | 1 | 1 | 24,104 | 24,104 | 161 ms |
| stage | 4,111 | 250 kB | (a) | 2,416 | 4 | 4 | 18,864 | 4,818, 4,810, 4,805 | 29 ms |
| stage | 4,111 | 250 kB | (b-node-nodeorder) | 2,416 | 4 | 4 | 71,218 | 9,943, 15,874, 21,297 | 387 ms |
| stage | 4,111 | 250 kB | (b-node-rest) | 2,416 | 4 | 4 | 29,306 | 9,943, 8,854, 7,117 | 157 ms |
| stage | 4,111 | 250 kB | (swap-rest) | 2,416 | 4 | 4 | 29,306 | 9,943, 8,854, 7,117 | 158 ms |

### Query plans

**q2.whole.stage.n1.a, q2.whole.stage.n4.a, q2.whole.stage.n41.a and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY "idx_Snapshots_q_Deal:stage" WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:stage (<expr>=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q2.whole.stage.n1.b-node-nodeorder, q2.whole.stage.n4.b-node-nodeorder, q2.whole.stage.n41.b-node-nodeorder and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.whole.stage.n1.swap-node, q2.whole.stage.n4.swap-node, q2.whole.stage.n41.swap-node and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_typeNode WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeNode (typeName=? AND nodeId=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.whole.owner.n1.a, q2.whole.owner.n4.a, q2.whole.owner.n41.a and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY "idx_Snapshots_q_Deal:owner" WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.owner') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:owner (<expr>=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q2.whole.owner.n1.b-node-nodeorder, q2.whole.owner.n4.b-node-nodeorder, q2.whole.owner.n41.b-node-nodeorder and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.owner') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.whole.owner.n1.swap-node, q2.whole.owner.n4.swap-node, q2.whole.owner.n41.swap-node and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_typeNode WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.owner') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeNode (typeName=? AND nodeId=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.whole.all.n1.a, q2.whole.all.n4.a, q2.whole.all.n41.a and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_current WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SCAN Snapshots USING INDEX idx_Snapshots_current
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q2.whole.all.n1.b-node-nodeorder, q2.whole.all.n4.b-node-nodeorder, q2.whole.all.n41.b-node-nodeorder and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.whole.all.n1.swap-node, q2.whole.all.n4.swap-node, q2.whole.all.n41.swap-node and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_typeNode WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeNode (typeName=? AND nodeId=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.paged.all.n411.2000k.a, q2.paged.all.n411.250k.a, q2.paged.all.n4111.2000k.a and 1 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_current WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) AND resourceId > ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_current (resourceId>?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q2.paged.all.n411.2000k.b-node-nodeorder, q2.paged.all.n411.2000k.b-node-rest, q2.paged.all.n411.250k.b-node-nodeorder and 5 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) AND (nodeId, resourceId) > (?, ?) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.paged.all.n411.2000k.swap-rest, q2.paged.all.n411.250k.swap-rest, q2.paged.all.n4111.2000k.swap-rest and 1 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_typeNode WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) AND (nodeId, resourceId) > (?, ?) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeNode (typeName=? AND nodeId=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.paged.stage.n411.2000k.a, q2.paged.stage.n411.250k.a, q2.paged.stage.n4111.2000k.a and 1 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY "idx_Snapshots_q_Deal:stage" WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) AND resourceId > ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:stage (<expr>=? AND resourceId>?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q2.paged.stage.n411.2000k.b-node-nodeorder, q2.paged.stage.n411.2000k.b-node-rest, q2.paged.stage.n411.250k.b-node-nodeorder and 5 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) AND (nodeId, resourceId) > (?, ?) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.paged.stage.n411.2000k.swap-rest, q2.paged.stage.n411.250k.swap-rest, q2.paged.stage.n4111.2000k.swap-rest and 1 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_typeNode WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) AND (nodeId, resourceId) > (?, ?) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeNode (typeName=? AND nodeId=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

### Timing notes

- Cases with a joined timing: 77 of 77; with every round joined: 77.
- Slowest round over fastest, per case: median 1.58, worst 3.77.
- An empty invocation's cpuTimeMs: 1, 0, 0, 0, 0.
- Cases whose timed rows differed from the first call's: none.
