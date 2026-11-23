<!-- from run-2026-11-23T16-45-48-783Z-paired.json, run 2026-11-23T16:45:48.784Z to 2026-11-23T16:58:20.528Z -->

### Q2 whole read, filter `stage`

Rows read:

| Nodes in subtree | Results | (a) | (b-node) | (b-node-nodeorder) | (c) |
| --- | --- | --- | --- | --- | --- |
| 1 | 0 | 2,418 | 8 | 7 | 5 |
| 4 | 1 | 2,421 | 25 | 24 | 16 |
| 41 | 22 | 2,458 | 258 | 236 | 154 |
| 411 | 242 | 2,836 | 2,794 | 2,552 | 1,714 |
| 4,111 | 2,416 | 6,528 | 26,520 | 24,104 | 15,882 |

CPU:

| Nodes in subtree | Results | (a) | (b-node) | (b-node-nodeorder) | (c) |
| --- | --- | --- | --- | --- | --- |
| 1 | 0 | 18 ms | 52 µs | 55 µs | 44 µs |
| 4 | 1 | 18 ms | 89 µs | 82 µs | 164 µs |
| 41 | 22 | 18 ms | 1.5 ms | 1.5 ms | 3.2 ms |
| 411 | 242 | 19 ms | 18 ms | 19 ms | 38 ms |
| 4,111 | 2,416 | 27 ms | 164 ms | 170 ms | 368 ms |

### Q2 whole read, filter `owner`

Rows read:

| Nodes in subtree | Results | (a) | (b-node) | (b-node-nodeorder) | (c) |
| --- | --- | --- | --- | --- | --- |
| 1 | 0 | 56 | 8 | 7 | 5 |
| 4 | 0 | 59 | 25 | 24 | 16 |
| 41 | 0 | 96 | 237 | 236 | 154 |
| 411 | 1 | 474 | 2,553 | 2,552 | 1,714 |
| 4,111 | 54 | 4,166 | 24,158 | 24,104 | 15,882 |

CPU:

| Nodes in subtree | Results | (a) | (b-node) | (b-node-nodeorder) | (c) |
| --- | --- | --- | --- | --- | --- |
| 1 | 0 | 111 µs | 59 µs | 52 µs | 42 µs |
| 4 | 0 | 104 µs | 81 µs | 75 µs | 146 µs |
| 41 | 0 | 113 µs | 1.4 ms | 1.4 ms | 5.1 ms |
| 411 | 1 | 232 µs | 18 ms | 20 ms | 40 ms |
| 4,111 | 54 | 1.4 ms | 152 ms | 147 ms | 323 ms |

### Q2 whole read, filter `all`

Rows read:

| Nodes in subtree | Results | (a) | (b-node) | (b-node-nodeorder) | (c) |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 | 30,001 | 11 | 7 | 5 |
| 4 | 12 | 30,004 | 36 | 24 | 16 |
| 41 | 116 | 30,041 | 352 | 236 | 154 |
| 411 | 1,312 | 30,419 | 3,864 | 2,552 | 1,714 |
| 4,111 | 12,000 | 34,111 | 36,104 | 24,104 | 15,882 |

CPU:

| Nodes in subtree | Results | (a) | (b-node) | (b-node-nodeorder) | (c) |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 | 101 ms | 34 µs | 38 µs | 44 µs |
| 4 | 12 | 106 ms | 62 µs | 55 µs | 161 µs |
| 41 | 116 | 101 ms | 2.9 ms | 1.6 ms | 3.2 ms |
| 411 | 1,312 | 109 ms | 21 ms | 18 ms | 37 ms |
| 4,111 | 12,000 | 146 ms | 171 ms | 164 ms | 370 ms |

### Q2 first read in pages

| Filter | Nodes | Page | Arm | Results | Statements | Pages | Rows read, all pages | Rows read, first three pages | CPU, all pages |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 411 | 2000 kB | (a) | 1,312 | 1 | 1 | 30,419 | 30,419 | 105 ms |
| all | 411 | 2000 kB | (b-node-sort) | 1,312 | 1 | 1 | 3,881 | 3,881 | 21 ms |
| all | 411 | 2000 kB | (b-node-nodeorder) | 1,312 | 1 | 1 | 2,552 | 2,552 | 29 ms |
| all | 411 | 2000 kB | (b-node-rest) | 1,312 | 1 | 1 | 2,552 | 2,552 | 19 ms |
| all | 411 | 2000 kB | (c) | 1,312 | 419 | 1 | 1,731 | 1,731 | 38 ms |
| all | 411 | 250 kB | (a) | 1,312 | 2 | 2 | 30,853 | 15,822, 15,031 | 106 ms |
| all | 411 | 250 kB | (b-node-sort) | 1,312 | 2 | 2 | 5,759 | 3,262, 2,497 | 28 ms |
| all | 411 | 250 kB | (b-node-nodeorder) | 1,312 | 2 | 2 | 4,128 | 1,576, 2,552 | 28 ms |
| all | 411 | 250 kB | (b-node-rest) | 1,312 | 2 | 2 | 2,747 | 1,576, 1,171 | 20 ms |
| all | 411 | 250 kB | (c) | 1,312 | 420 | 2 | 1,732 | 933, 799 | 38 ms |
| all | 4,111 | 2000 kB | (a) | 12,000 | 3 | 3 | 42,337 | 17,820, 18,075, 6,442 | 141 ms |
| all | 4,111 | 2000 kB | (b-node-sort) | 12,000 | 3 | 3 | 68,419 | 29,852, 24,362, 14,205 | 265 ms |
| all | 4,111 | 2000 kB | (b-node-nodeorder) | 12,000 | 3 | 3 | 59,968 | 13,281, 22,583, 24,104 | 352 ms |
| all | 4,111 | 2000 kB | (b-node-rest) | 12,000 | 3 | 3 | 26,649 | 13,281, 11,539, 1,829 | 161 ms |
| all | 4,111 | 2000 kB | (c) | 12,000 | 4,113 | 3 | 16,113 | 7,397, 7,489, 1,227 | 364 ms |
| all | 4,111 | 250 kB | (a) | 12,000 | 18 | 18 | 104,052 | 5,767, 5,742, 5,824 | 170 ms |
| all | 4,111 | 250 kB | (b-node-sort) | 12,000 | 18 | 18 | 344,220 | 25,024, 24,316, 23,673 | 1471 ms |
| all | 4,111 | 250 kB | (b-node-nodeorder) | 12,000 | 18 | 18 | 270,688 | 5,292, 6,452, 7,574 | 1524 ms |
| all | 4,111 | 250 kB | (b-node-rest) | 12,000 | 18 | 18 | 57,661 | 5,292, 5,032, 4,742 | 192 ms |
| all | 4,111 | 250 kB | (c) | 12,000 | 4,128 | 18 | 16,128 | 947, 934, 915 | 340 ms |
| stage | 411 | 2000 kB | (a) | 242 | 1 | 1 | 2,836 | 2,836 | 27 ms |
| stage | 411 | 2000 kB | (b-node-sort) | 242 | 1 | 1 | 2,811 | 2,811 | 19 ms |
| stage | 411 | 2000 kB | (b-node-nodeorder) | 242 | 1 | 1 | 2,552 | 2,552 | 19 ms |
| stage | 411 | 2000 kB | (b-node-rest) | 242 | 1 | 1 | 2,552 | 2,552 | 19 ms |
| stage | 411 | 2000 kB | (c) | 242 | 419 | 1 | 1,731 | 1,731 | 38 ms |
| stage | 411 | 250 kB | (a) | 242 | 1 | 1 | 2,836 | 2,836 | 19 ms |
| stage | 411 | 250 kB | (b-node-sort) | 242 | 1 | 1 | 2,811 | 2,811 | 19 ms |
| stage | 411 | 250 kB | (b-node-nodeorder) | 242 | 1 | 1 | 2,552 | 2,552 | 20 ms |
| stage | 411 | 250 kB | (b-node-rest) | 242 | 1 | 1 | 2,552 | 2,552 | 19 ms |
| stage | 411 | 250 kB | (c) | 242 | 419 | 1 | 1,731 | 1,731 | 39 ms |
| stage | 4,111 | 2000 kB | (a) | 2,416 | 1 | 1 | 6,528 | 6,528 | 25 ms |
| stage | 4,111 | 2000 kB | (b-node-sort) | 2,416 | 1 | 1 | 26,749 | 26,749 | 156 ms |
| stage | 4,111 | 2000 kB | (b-node-nodeorder) | 2,416 | 1 | 1 | 24,104 | 24,104 | 156 ms |
| stage | 4,111 | 2000 kB | (b-node-rest) | 2,416 | 1 | 1 | 24,104 | 24,104 | 166 ms |
| stage | 4,111 | 2000 kB | (c) | 2,416 | 4,111 | 1 | 16,111 | 16,111 | 366 ms |
| stage | 4,111 | 250 kB | (a) | 2,416 | 4 | 4 | 18,864 | 4,818, 4,810, 4,805 | 33 ms |
| stage | 4,111 | 250 kB | (b-node-sort) | 2,416 | 4 | 4 | 79,139 | 25,040, 21,613, 18,170 | 358 ms |
| stage | 4,111 | 250 kB | (b-node-nodeorder) | 2,416 | 4 | 4 | 71,218 | 9,943, 15,874, 21,297 | 415 ms |
| stage | 4,111 | 250 kB | (b-node-rest) | 2,416 | 4 | 4 | 29,306 | 9,943, 8,854, 7,117 | 162 ms |
| stage | 4,111 | 250 kB | (c) | 2,416 | 4,114 | 4 | 16,117 | 4,703, 4,767, 4,385 | 343 ms |

### Q6 catch-up that missed 1 writes

| Types | Read | Writes found | Rows read (a) | Rows read (d) | CPU (a) | CPU (d) |
| --- | --- | --- | --- | --- | --- | --- |
| Deal | ids | 1 | 2 | 1 | 21 µs | 23 µs |
| Deal | ids, then both versions by key | 1 | 2 + 2 | 1 + 2 | 65 µs | 64 µs |
| Note | ids | 0 | 1 | 1 | 22 µs | 24 µs |
| Note | ids, then both versions by key | 0 | 1 | 1 | 20 µs | 22 µs |
| Deal | rows | 1 | 2 | 1 | 32 µs | 30 µs |
| Deal | rows, then the earlier version by key | 1 | 2 + 1 | 1 + 1 | 55 µs | 57 µs |
| Deal | ids, WHERE over value and node | 1 | 4,113 | 4,112 | 1.3 ms | 1.3 ms |
| several | ids, one statement per type | 1 | 4 | 3 | 58 µs | 69 µs |
| several | ids, one statement, typeName IN | 1 | 8 | 1 | 43 µs | 31 µs |
| every type | ids, one statement, no type test | 1 | 120,001 | 1 | 15 ms | 13 µs |
| every type | ids and typeName, one statement, no type test | 1 | 120,001 | 1 | 14 ms | 13 µs |

### Q6 catch-up that missed 100 writes

| Types | Read | Writes found | Rows read (a) | Rows read (d) | CPU (a) | CPU (d) |
| --- | --- | --- | --- | --- | --- | --- |
| Deal | ids | 42 | 43 | 100 | 82 µs | 235 µs |
| Deal | ids, then both versions by key | 42 | 43 + 84 | 100 + 84 | 1.8 ms | 2.2 ms |
| Note | ids | 10 | 11 | 100 | 36 µs | 154 µs |
| Note | ids, then both versions by key | 10 | 11 + 20 | 100 + 20 | 509 µs | 689 µs |
| Deal | rows | 42 | 43 | 100 | 194 µs | 264 µs |
| Deal | rows, then the earlier version by key | 42 | 43 + 42 | 100 + 42 | 1.4 ms | 1.3 ms |
| Deal | ids, WHERE over value and node | 9 | 4,154 | 4,211 | 1.6 ms | 1.7 ms |
| several | ids, one statement per type | 90 | 92 | 300 | 211 µs | 602 µs |
| several | ids, one statement, typeName IN | 90 | 185 | 100 | 161 µs | 271 µs |
| every type | ids, one statement, no type test | 100 | 120,100 | 100 | 15 ms | 141 µs |
| every type | ids and typeName, one statement, no type test | 100 | 120,100 | 100 | 14 ms | 322 µs |

### Q6 catch-up that missed 10,000 writes

| Types | Read | Writes found | Rows read (a) | Rows read (d) | CPU (a) | CPU (d) |
| --- | --- | --- | --- | --- | --- | --- |
| Deal | ids | 4,048 | 4,049 | 10,000 | 5.2 ms | 134 ms |
| Deal | ids, then both versions by key | 4,048 | 4,049 + 7,136 | 10,000 + 7,136 | 222 ms | 337 ms |
| Note | ids | 961 | 962 | 10,000 | 1.4 ms | 134 ms |
| Note | ids, then both versions by key | 961 | 962 + 1,698 | 10,000 + 1,698 | 59 ms | 170 ms |
| Deal | rows | 4,048 | 4,049 | 10,000 | 63 ms | 138 ms |
| Deal | rows, then the earlier version by key | 4,048 | 4,049 + 3,568 | 10,000 + 3,568 | 205 ms | 276 ms |
| Deal | ids, WHERE over value and node | 855 | 8,160 | 14,111 | 52 ms | 137 ms |
| several | ids, one statement per type | 9,039 | 9,041 | 30,000 | 14 ms | 415 ms |
| several | ids, one statement, typeName IN | 9,039 | 18,083 | 10,000 | 22 ms | 150 ms |
| every type | ids, one statement, no type test | 10,000 | 130,000 | 10,000 | 54 ms | 15 ms |
| every type | ids and typeName, one statement, no type test | 10,000 | 130,000 | 10,000 | 65 ms | 164 ms |

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

**q2.whole.stage.n1.b-node, q2.whole.stage.n4.b-node, q2.whole.stage.n41.b-node and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
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

**q2.whole.stage.n1.c, q2.whole.stage.n4.c, q2.whole.stage.n41.c and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE nodeId = ? AND typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
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

**q2.whole.owner.n1.b-node, q2.whole.owner.n4.b-node, q2.whole.owner.n41.b-node and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.owner') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
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

**q2.whole.owner.n1.c, q2.whole.owner.n4.c, q2.whole.owner.n41.c and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE nodeId = ? AND typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.owner') = ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
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

**q2.whole.all.n1.b-node, q2.whole.all.n4.b-node, q2.whole.all.n41.b-node and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
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

**q2.whole.all.n1.c, q2.whole.all.n4.c, q2.whole.all.n41.c and 2 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE nodeId = ? AND typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
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

**q2.paged.all.n411.2000k.b-node-sort, q2.paged.all.n411.250k.b-node-sort, q2.paged.all.n4111.2000k.b-node-sort and 1 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) AND resourceId > ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=? AND resourceId>?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
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

**q2.paged.all.n411.2000k.c, q2.paged.all.n411.250k.c, q2.paged.all.n4111.2000k.c and 1 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE nodeId = ? AND typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND resourceId > ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=? AND resourceId>?)
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

**q2.paged.stage.n411.2000k.b-node-sort, q2.paged.stage.n411.250k.b-node-sort, q2.paged.stage.n4111.2000k.b-node-sort and 1 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) AND resourceId > ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=? AND resourceId>?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
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

**q2.paged.stage.n411.2000k.c, q2.paged.stage.n411.250k.c, q2.paged.stage.n4111.2000k.c and 1 more** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE nodeId = ? AND typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND resourceId > ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=? AND resourceId>?)
```

**q6.a.1.Deal.ids, q6.a.1.Deal.flow-ids, q6.a.1.Note.ids and 9 more** (object `all`)

```sql
SELECT resourceId, validFrom FROM Snapshots INDEXED BY idx_Snapshots_typeMoment WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING COVERING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)
```

**q6.a.1.Deal.rows, q6.a.1.Deal.flow-rows, q6.a.100.Deal.rows and 3 more** (object `all`)

```sql
SELECT resourceId, validFrom, nodeId, deleted, value FROM Snapshots INDEXED BY idx_Snapshots_typeMoment WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)
```

**q6.a.1.Deal.where, q6.a.100.Deal.where, q6.a.10000.Deal.where** (object `all`)

```sql
SELECT resourceId, validFrom FROM Snapshots INDEXED BY idx_Snapshots_typeMoment WHERE typeName = ? AND validFrom > ? AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q6.a.1.several.per-type, q6.a.100.several.per-type, q6.a.10000.several.per-type** (object `all`)

```sql
SELECT resourceId, validFrom FROM Snapshots INDEXED BY idx_Snapshots_typeMoment WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
SELECT resourceId, validFrom FROM Snapshots INDEXED BY idx_Snapshots_typeMoment WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
SELECT resourceId, validFrom FROM Snapshots INDEXED BY idx_Snapshots_typeMoment WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING COVERING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)
SEARCH Snapshots USING COVERING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)
SEARCH Snapshots USING COVERING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)
```

**q6.a.1.several.in, q6.a.100.several.in, q6.a.10000.several.in** (object `all`)

```sql
SELECT resourceId, validFrom FROM Snapshots INDEXED BY idx_Snapshots_typeMoment WHERE typeName IN (?, ?, ?) AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING COVERING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)
USE TEMP B-TREE FOR ORDER BY
```

**q6.a.1.several.any-type, q6.a.100.several.any-type, q6.a.10000.several.any-type** (object `all`)

```sql
SELECT resourceId, validFrom FROM Snapshots INDEXED BY idx_Snapshots_typeMoment WHERE validFrom > ? ORDER BY validFrom, resourceId
```
```text
SCAN Snapshots USING COVERING INDEX idx_Snapshots_typeMoment
USE TEMP B-TREE FOR ORDER BY
```

**q6.a.1.several.any-type-named, q6.a.100.several.any-type-named, q6.a.10000.several.any-type-named** (object `all`)

```sql
SELECT resourceId, validFrom, typeName FROM Snapshots INDEXED BY idx_Snapshots_typeMoment WHERE validFrom > ? ORDER BY validFrom, resourceId
```
```text
SCAN Snapshots USING COVERING INDEX idx_Snapshots_typeMoment
USE TEMP B-TREE FOR ORDER BY
```

**q6.d.1.Deal.ids, q6.d.1.Deal.flow-ids, q6.d.1.Note.ids and 9 more** (object `all`)

```sql
SELECT resourceId, validFrom FROM Snapshots INDEXED BY idx_Snapshots_moment WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
```

**q6.d.1.Deal.rows, q6.d.1.Deal.flow-rows, q6.d.100.Deal.rows and 3 more** (object `all`)

```sql
SELECT resourceId, validFrom, nodeId, deleted, value FROM Snapshots INDEXED BY idx_Snapshots_moment WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
```

**q6.d.1.Deal.where, q6.d.100.Deal.where, q6.d.10000.Deal.where** (object `all`)

```sql
SELECT resourceId, validFrom FROM Snapshots INDEXED BY idx_Snapshots_moment WHERE typeName = ? AND validFrom > ? AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q6.d.1.several.per-type, q6.d.100.several.per-type, q6.d.10000.several.per-type** (object `all`)

```sql
SELECT resourceId, validFrom FROM Snapshots INDEXED BY idx_Snapshots_moment WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
SELECT resourceId, validFrom FROM Snapshots INDEXED BY idx_Snapshots_moment WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
SELECT resourceId, validFrom FROM Snapshots INDEXED BY idx_Snapshots_moment WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
```

**q6.d.1.several.in, q6.d.100.several.in, q6.d.10000.several.in** (object `all`)

```sql
SELECT resourceId, validFrom FROM Snapshots INDEXED BY idx_Snapshots_moment WHERE typeName IN (?, ?, ?) AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
```

**q6.d.1.several.any-type, q6.d.100.several.any-type, q6.d.10000.several.any-type** (object `all`)

```sql
SELECT resourceId, validFrom FROM Snapshots INDEXED BY idx_Snapshots_moment WHERE validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING COVERING INDEX idx_Snapshots_moment (validFrom>?)
```

**q6.d.1.several.any-type-named, q6.d.100.several.any-type-named, q6.d.10000.several.any-type-named** (object `all`)

```sql
SELECT resourceId, validFrom, typeName FROM Snapshots INDEXED BY idx_Snapshots_moment WHERE validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
```

### Timing notes

- Cases with a joined timing: 199 of 199; with every round joined: 199.
- Slowest round over fastest, per case: median 1.61, worst 3.51.
- An empty invocation's cpuTimeMs: 0, 0, 0, 0, 0.
- Cases whose timed rows differed from the first call's: none.
