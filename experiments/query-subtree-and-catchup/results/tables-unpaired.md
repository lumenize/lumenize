<!-- from run-2026-11-23T16-28-55-861Z.json, run 2026-11-23T16:28:55.861Z to 2026-11-23T16:41:49.907Z -->

### Q2 whole read, filter `stage`

Rows read:

| Nodes in subtree | Results | (a) | (b) | (b-node) | (b-node-nodeorder) | (c) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 2,418 | 2,418 | 8 | 7 | 5 |
| 4 | 1 | 2,421 | 2,421 | 25 | 24 | 16 |
| 41 | 22 | 2,458 | 2,458 | 258 | 236 | 154 |
| 411 | 242 | 2,836 | 2,836 | 2,794 | 2,552 | 1,714 |
| 4,111 | 2,416 | 6,528 | 6,528 | 26,520 | 24,104 | 15,882 |

CPU:

| Nodes in subtree | Results | (a) | (b) | (b-node) | (b-node-nodeorder) | (c) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 17 ms | 16 ms | 48 µs | 49 µs | 44 µs |
| 4 | 1 | 17 ms | 16 ms | 73 µs | 78 µs | 158 µs |
| 41 | 22 | 16 ms | 17 ms | 1.3 ms | 1.5 ms | 3.2 ms |
| 411 | 242 | 18 ms | 17 ms | 16 ms | 17 ms | 33 ms |
| 4,111 | 2,416 | 25 ms | 24 ms | 149 ms | 151 ms | 330 ms |

### Q2 whole read, filter `owner`

Rows read:

| Nodes in subtree | Results | (a) | (b) | (b-node) | (b-node-nodeorder) | (c) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 56 | 56 | 8 | 7 | 5 |
| 4 | 0 | 59 | 59 | 25 | 24 | 16 |
| 41 | 0 | 96 | 96 | 237 | 236 | 154 |
| 411 | 1 | 474 | 474 | 2,553 | 2,552 | 1,714 |
| 4,111 | 54 | 4,166 | 4,166 | 24,158 | 24,104 | 15,882 |

CPU:

| Nodes in subtree | Results | (a) | (b) | (b-node) | (b-node-nodeorder) | (c) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 627 µs | 108 µs | 53 µs | 103 µs | 38 µs |
| 4 | 0 | 642 µs | 101 µs | 65 µs | 119 µs | 141 µs |
| 41 | 0 | 648 µs | 108 µs | 1.4 ms | 1.3 ms | 2.9 ms |
| 411 | 1 | 747 µs | 214 µs | 17 ms | 16 ms | 52 ms |
| 4,111 | 54 | 2.1 ms | 1.3 ms | 136 ms | 163 ms | 329 ms |

### Q2 whole read, filter `all`

Rows read:

| Nodes in subtree | Results | (a) | (b) | (b-node) | (b-node-nodeorder) | (c) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 4 | 30,001 | 11 | 11 | 7 | 5 |
| 4 | 12 | 30,004 | 36 | 36 | 24 | 16 |
| 41 | 116 | 30,041 | 352 | 352 | 236 | 154 |
| 411 | 1,312 | 30,419 | 3,864 | 3,864 | 2,552 | 1,714 |
| 4,111 | 12,000 | 34,111 | 36,104 | 36,104 | 24,104 | 15,882 |

CPU:

| Nodes in subtree | Results | (a) | (b) | (b-node) | (b-node-nodeorder) | (c) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 4 | 97 ms | 28 µs | 28 µs | 26 µs | 41 µs |
| 4 | 12 | 171 ms | 53 µs | 53 µs | 50 µs | 149 µs |
| 41 | 116 | 109 ms | 1.3 ms | 1.3 ms | 1.4 ms | 5.2 ms |
| 411 | 1,312 | 105 ms | 20 ms | 26 ms | 19 ms | 34 ms |
| 4,111 | 12,000 | 141 ms | 163 ms | 169 ms | 159 ms | 329 ms |

### Q2 first read in pages

| Filter | Nodes | Page | Arm | Results | Statements | Pages | Rows read, all pages | Rows read, first three pages | CPU, all pages |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 411 | 2000 kB | (a) | 1,312 | 1 | 1 | 30,419 | 30,419 | 102 ms |
| all | 411 | 2000 kB | (b-node-sort) | 1,312 | 1 | 1 | 3,881 | 3,881 | 18 ms |
| all | 411 | 2000 kB | (b-node-nodeorder) | 1,312 | 1 | 1 | 2,552 | 2,552 | 17 ms |
| all | 411 | 2000 kB | (b-node-rest) | 1,312 | 1 | 1 | 2,552 | 2,552 | 17 ms |
| all | 411 | 2000 kB | (c) | 1,312 | 419 | 1 | 1,731 | 1,731 | 35 ms |
| all | 411 | 250 kB | (a) | 1,312 | 2 | 2 | 30,853 | 15,822, 15,031 | 110 ms |
| all | 411 | 250 kB | (b-node-sort) | 1,312 | 2 | 2 | 5,759 | 3,262, 2,497 | 26 ms |
| all | 411 | 250 kB | (b-node-nodeorder) | 1,312 | 2 | 2 | 4,128 | 1,576, 2,552 | 26 ms |
| all | 411 | 250 kB | (b-node-rest) | 1,312 | 2 | 2 | 2,747 | 1,576, 1,171 | 18 ms |
| all | 411 | 250 kB | (c) | 1,312 | 420 | 2 | 1,732 | 933, 799 | 35 ms |
| all | 4,111 | 2000 kB | (a) | 12,000 | 3 | 3 | 42,337 | 17,820, 18,075, 6,442 | 148 ms |
| all | 4,111 | 2000 kB | (b-node-sort) | 12,000 | 3 | 3 | 68,419 | 29,852, 24,362, 14,205 | 247 ms |
| all | 4,111 | 2000 kB | (b-node-nodeorder) | 12,000 | 3 | 3 | 59,968 | 13,281, 22,583, 24,104 | 346 ms |
| all | 4,111 | 2000 kB | (b-node-rest) | 12,000 | 3 | 3 | 26,649 | 13,281, 11,539, 1,829 | 154 ms |
| all | 4,111 | 2000 kB | (c) | 12,000 | 4,113 | 3 | 16,113 | 7,397, 7,489, 1,227 | 575 ms |
| all | 4,111 | 250 kB | (a) | 12,000 | 18 | 18 | 104,052 | 5,767, 5,742, 5,824 | 174 ms |
| all | 4,111 | 250 kB | (b-node-sort) | 12,000 | 18 | 18 | 344,220 | 25,024, 24,316, 23,673 | 1251 ms |
| all | 4,111 | 250 kB | (b-node-nodeorder) | 12,000 | 18 | 18 | 270,688 | 5,292, 6,452, 7,574 | 1416 ms |
| all | 4,111 | 250 kB | (b-node-rest) | 12,000 | 18 | 18 | 57,661 | 5,292, 5,032, 4,742 | 171 ms |
| all | 4,111 | 250 kB | (c) | 12,000 | 4,128 | 18 | 16,128 | 947, 934, 915 | 369 ms |
| stage | 411 | 2000 kB | (a) | 242 | 1 | 1 | 2,836 | 2,836 | 18 ms |
| stage | 411 | 2000 kB | (b-node-sort) | 242 | 1 | 1 | 2,811 | 2,811 | 16 ms |
| stage | 411 | 2000 kB | (b-node-nodeorder) | 242 | 1 | 1 | 2,552 | 2,552 | 18 ms |
| stage | 411 | 2000 kB | (b-node-rest) | 242 | 1 | 1 | 2,552 | 2,552 | 19 ms |
| stage | 411 | 2000 kB | (c) | 242 | 419 | 1 | 1,731 | 1,731 | 39 ms |
| stage | 411 | 250 kB | (a) | 242 | 1 | 1 | 2,836 | 2,836 | 17 ms |
| stage | 411 | 250 kB | (b-node-sort) | 242 | 1 | 1 | 2,811 | 2,811 | 17 ms |
| stage | 411 | 250 kB | (b-node-nodeorder) | 242 | 1 | 1 | 2,552 | 2,552 | 16 ms |
| stage | 411 | 250 kB | (b-node-rest) | 242 | 1 | 1 | 2,552 | 2,552 | 17 ms |
| stage | 411 | 250 kB | (c) | 242 | 419 | 1 | 1,731 | 1,731 | 53 ms |
| stage | 4,111 | 2000 kB | (a) | 2,416 | 1 | 1 | 6,528 | 6,528 | 28 ms |
| stage | 4,111 | 2000 kB | (b-node-sort) | 2,416 | 1 | 1 | 26,749 | 26,749 | 145 ms |
| stage | 4,111 | 2000 kB | (b-node-nodeorder) | 2,416 | 1 | 1 | 24,104 | 24,104 | 139 ms |
| stage | 4,111 | 2000 kB | (b-node-rest) | 2,416 | 1 | 1 | 24,104 | 24,104 | 150 ms |
| stage | 4,111 | 2000 kB | (c) | 2,416 | 4,111 | 1 | 16,111 | 16,111 | 346 ms |
| stage | 4,111 | 250 kB | (a) | 2,416 | 4 | 4 | 18,864 | 4,818, 4,810, 4,805 | 29 ms |
| stage | 4,111 | 250 kB | (b-node-sort) | 2,416 | 4 | 4 | 79,139 | 25,040, 21,613, 18,170 | 332 ms |
| stage | 4,111 | 250 kB | (b-node-nodeorder) | 2,416 | 4 | 4 | 71,218 | 9,943, 15,874, 21,297 | 366 ms |
| stage | 4,111 | 250 kB | (b-node-rest) | 2,416 | 4 | 4 | 29,306 | 9,943, 8,854, 7,117 | 152 ms |
| stage | 4,111 | 250 kB | (c) | 2,416 | 4,114 | 4 | 16,117 | 4,703, 4,767, 4,385 | 349 ms |

### Q6 catch-up that missed 1 writes

| Types | Read | Writes found | Rows read (a) | Rows read (b) | Rows read (d) | CPU (a) | CPU (b) | CPU (d) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Deal | ids | 1 | 2 | 120,001 | 1 | 59 µs | 84 ms | 60 µs |
| Deal | ids, then both versions by key | 1 | 2 + 2 | 120,001 + 2 | 1 + 2 | 168 µs | 83 ms | 179 µs |
| Note | ids | 0 | 1 | 120,001 | 1 | 48 µs | 108 ms | 57 µs |
| Note | ids, then both versions by key | 0 | 1 | 120,001 | 1 | 49 µs | 81 ms | 87 µs |
| Deal | rows | 1 | 2 | 120,001 | 1 | 87 µs | 87 ms | 76 µs |
| Deal | rows, then the earlier version by key | 1 | 2 + 1 | 120,001 + 1 | 1 + 1 | 212 µs | 81 ms | 153 µs |
| Deal | ids, WHERE over value and node | 1 | 4,113 | 124,112 | 4,112 | 2.4 ms | 78 ms | 1.9 ms |
| several | ids, one statement per type | 1 | 4 | 360,003 | 3 | 167 µs | 234 ms | 176 µs |
| several | ids, one statement, typeName IN | 1 | 8 | 120,001 | 1 | 56 µs | 87 ms | 60 µs |
| every type | ids, one statement, no type test | 1 | 120,001 | 120,001 | 1 | 31 ms | 80 ms | 30 µs |
| every type | ids and typeName, one statement, no type test | 1 | 120,001 | 120,001 | 1 | 20 ms | 78 ms | 43 µs |

### Q6 catch-up that missed 100 writes

| Types | Read | Writes found | Rows read (a) | Rows read (b) | Rows read (d) | CPU (a) | CPU (b) | CPU (d) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Deal | ids | 42 | 43 | 120,042 | 100 | 165 µs | 79 ms | 398 µs |
| Deal | ids, then both versions by key | 42 | 43 + 84 | 120,042 + 84 | 100 + 84 | 4.9 ms | 89 ms | 7.2 ms |
| Note | ids | 10 | 11 | 120,010 | 100 | 80 µs | 81 ms | 285 µs |
| Note | ids, then both versions by key | 10 | 11 + 20 | 120,010 + 20 | 100 + 20 | 1.9 ms | 80 ms | 1.5 ms |
| Deal | rows | 42 | 43 | 120,042 | 100 | 354 µs | 83 ms | 517 µs |
| Deal | rows, then the earlier version by key | 42 | 43 + 42 | 120,042 + 42 | 100 + 42 | 2.9 ms | 84 ms | 3.3 ms |
| Deal | ids, WHERE over value and node | 9 | 4,154 | 124,120 | 4,211 | 2.8 ms | 84 ms | 3.4 ms |
| several | ids, one statement per type | 90 | 92 | 360,090 | 300 | 662 µs | 272 ms | 1.1 ms |
| several | ids, one statement, typeName IN | 90 | 185 | 120,090 | 100 | 402 µs | 91 ms | 461 µs |
| every type | ids, one statement, no type test | 100 | 120,100 | 120,100 | 100 | 22 ms | 85 ms | 216 µs |
| every type | ids and typeName, one statement, no type test | 100 | 120,100 | 120,100 | 100 | 25 ms | 77 ms | 510 µs |

### Q6 catch-up that missed 10,000 writes

| Types | Read | Writes found | Rows read (a) | Rows read (b) | Rows read (d) | CPU (a) | CPU (b) | CPU (d) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Deal | ids | 4,048 | 4,049 | 124,048 | 10,000 | 11 ms | 106 ms | 217 ms |
| Deal | ids, then both versions by key | 4,048 | 4,049 + 7,136 | 124,048 + 7,136 | 10,000 + 7,136 | 470 ms | 345 ms | 623 ms |
| Note | ids | 961 | 962 | 120,961 | 10,000 | 2.4 ms | 83 ms | 199 ms |
| Note | ids, then both versions by key | 961 | 962 + 1,698 | 120,961 + 1,698 | 10,000 + 1,698 | 125 ms | 154 ms | 409 ms |
| Deal | rows | 4,048 | 4,049 | 124,048 | 10,000 | 109 ms | 116 ms | 217 ms |
| Deal | rows, then the earlier version by key | 4,048 | 4,049 + 3,568 | 124,048 + 3,568 | 10,000 + 3,568 | 423 ms | 369 ms | 516 ms |
| Deal | ids, WHERE over value and node | 855 | 8,160 | 124,966 | 14,111 | 104 ms | 93 ms | 212 ms |
| several | ids, one statement per type | 9,039 | 9,041 | 369,039 | 30,000 | 39 ms | 297 ms | 627 ms |
| several | ids, one statement, typeName IN | 9,039 | 18,083 | 129,039 | 10,000 | 36 ms | 193 ms | 256 ms |
| every type | ids, one statement, no type test | 10,000 | 130,000 | 130,000 | 10,000 | 103 ms | 125 ms | 27 ms |
| every type | ids and typeName, one statement, no type test | 10,000 | 130,000 | 130,000 | 10,000 | 95 ms | 116 ms | 257 ms |

### Query plans

**q2.whole.stage.n1.a, q2.whole.stage.n4.a, q2.whole.stage.n41.a and 2 more** (object `base`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:stage (<expr>=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q2.whole.stage.n1.b, q2.whole.stage.n4.b, q2.whole.stage.n41.b and 2 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:stage (<expr>=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q2.whole.stage.n1.b-node, q2.whole.stage.n4.b-node, q2.whole.stage.n41.b-node and 2 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
```

**q2.whole.stage.n1.b-node-nodeorder, q2.whole.stage.n4.b-node-nodeorder, q2.whole.stage.n41.b-node-nodeorder and 2 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.whole.stage.n1.c, q2.whole.stage.n4.c, q2.whole.stage.n41.c and 2 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE nodeId = ? AND typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
```

**q2.whole.owner.n1.a, q2.whole.owner.n4.a, q2.whole.owner.n41.a and 2 more** (object `base`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.owner') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:owner (<expr>=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q2.whole.owner.n1.b, q2.whole.owner.n4.b, q2.whole.owner.n41.b and 2 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.owner') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:owner (<expr>=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q2.whole.owner.n1.b-node, q2.whole.owner.n4.b-node, q2.whole.owner.n41.b-node and 2 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.owner') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
```

**q2.whole.owner.n1.b-node-nodeorder, q2.whole.owner.n4.b-node-nodeorder, q2.whole.owner.n41.b-node-nodeorder and 2 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.owner') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.whole.owner.n1.c, q2.whole.owner.n4.c, q2.whole.owner.n41.c and 2 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE nodeId = ? AND typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.owner') = ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
```

**q2.whole.all.n1.a, q2.whole.all.n4.a, q2.whole.all.n41.a and 2 more** (object `base`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SCAN Snapshots USING INDEX idx_Snapshots_current
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q2.whole.all.n1.b, q2.whole.all.n4.b, q2.whole.all.n41.b and 2 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
```

**q2.whole.all.n1.b-node, q2.whole.all.n4.b-node, q2.whole.all.n41.b-node and 2 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
```

**q2.whole.all.n1.b-node-nodeorder, q2.whole.all.n4.b-node-nodeorder, q2.whole.all.n41.b-node-nodeorder and 2 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.whole.all.n1.c, q2.whole.all.n4.c, q2.whole.all.n41.c and 2 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE nodeId = ? AND typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
```

**q2.paged.all.n411.2000k.a, q2.paged.all.n411.250k.a, q2.paged.all.n4111.2000k.a and 1 more** (object `base`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) AND resourceId > ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_current (resourceId>?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q2.paged.all.n411.2000k.b-node-sort, q2.paged.all.n411.250k.b-node-sort, q2.paged.all.n4111.2000k.b-node-sort and 1 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) AND resourceId > ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=? AND resourceId>?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
```

**q2.paged.all.n411.2000k.b-node-nodeorder, q2.paged.all.n411.2000k.b-node-rest, q2.paged.all.n411.250k.b-node-nodeorder and 5 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) AND (nodeId, resourceId) > (?, ?) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.paged.all.n411.2000k.c, q2.paged.all.n411.250k.c, q2.paged.all.n4111.2000k.c and 1 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE nodeId = ? AND typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND resourceId > ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=? AND resourceId>?)
```

**q2.paged.stage.n411.2000k.a, q2.paged.stage.n411.250k.a, q2.paged.stage.n4111.2000k.a and 1 more** (object `base`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) AND resourceId > ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:stage (<expr>=? AND resourceId>?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q2.paged.stage.n411.2000k.b-node-sort, q2.paged.stage.n411.250k.b-node-sort, q2.paged.stage.n4111.2000k.b-node-sort and 1 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) AND resourceId > ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=? AND resourceId>?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
```

**q2.paged.stage.n411.2000k.b-node-nodeorder, q2.paged.stage.n411.2000k.b-node-rest, q2.paged.stage.n411.250k.b-node-nodeorder and 5 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_node WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) AND (nodeId, resourceId) > (?, ?) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.paged.stage.n411.2000k.c, q2.paged.stage.n411.250k.c, q2.paged.stage.n4111.2000k.c and 1 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE nodeId = ? AND typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND resourceId > ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=? AND resourceId>?)
```

**q6.a.1.Deal.ids, q6.a.1.Deal.flow-ids, q6.a.1.Note.ids and 9 more** (object `tm`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING COVERING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)
```

**q6.a.1.Deal.rows, q6.a.1.Deal.flow-rows, q6.a.100.Deal.rows and 3 more** (object `tm`)

```sql
SELECT resourceId, validFrom, nodeId, deleted, value FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)
```

**q6.a.1.Deal.where, q6.a.100.Deal.where, q6.a.10000.Deal.where** (object `tm`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q6.a.1.several.per-type, q6.a.100.several.per-type, q6.a.10000.several.per-type** (object `tm`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING COVERING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)
SEARCH Snapshots USING COVERING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)
SEARCH Snapshots USING COVERING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)
```

**q6.a.1.several.in, q6.a.100.several.in, q6.a.10000.several.in** (object `tm`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE typeName IN (?, ?, ?) AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING COVERING INDEX idx_Snapshots_typeMoment (typeName=? AND validFrom>?)
USE TEMP B-TREE FOR ORDER BY
```

**q6.a.1.several.any-type, q6.a.100.several.any-type, q6.a.10000.several.any-type** (object `tm`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE validFrom > ? ORDER BY validFrom, resourceId
```
```text
SCAN Snapshots USING COVERING INDEX idx_Snapshots_typeMoment
USE TEMP B-TREE FOR ORDER BY
```

**q6.a.1.several.any-type-named, q6.a.100.several.any-type-named, q6.a.10000.several.any-type-named** (object `tm`)

```sql
SELECT resourceId, validFrom, typeName FROM Snapshots WHERE validFrom > ? ORDER BY validFrom, resourceId
```
```text
SCAN Snapshots USING COVERING INDEX idx_Snapshots_typeMoment
USE TEMP B-TREE FOR ORDER BY
```

**q6.b.1.Deal.ids, q6.b.1.Deal.flow-ids, q6.b.1.Note.ids and 9 more** (object `base`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SCAN Snapshots
USE TEMP B-TREE FOR ORDER BY
```

**q6.b.1.Deal.rows, q6.b.1.Deal.flow-rows, q6.b.100.Deal.rows and 3 more** (object `base`)

```sql
SELECT resourceId, validFrom, nodeId, deleted, value FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SCAN Snapshots
USE TEMP B-TREE FOR ORDER BY
```

**q6.b.1.Deal.where, q6.b.100.Deal.where, q6.b.10000.Deal.where** (object `base`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY validFrom, resourceId
```
```text
SCAN Snapshots
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
USE TEMP B-TREE FOR ORDER BY
```

**q6.b.1.several.per-type, q6.b.100.several.per-type, q6.b.10000.several.per-type** (object `base`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SCAN Snapshots
USE TEMP B-TREE FOR ORDER BY
SCAN Snapshots
USE TEMP B-TREE FOR ORDER BY
SCAN Snapshots
USE TEMP B-TREE FOR ORDER BY
```

**q6.b.1.several.in, q6.b.100.several.in, q6.b.10000.several.in** (object `base`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE typeName IN (?, ?, ?) AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SCAN Snapshots
USE TEMP B-TREE FOR ORDER BY
```

**q6.b.1.several.any-type, q6.b.100.several.any-type, q6.b.10000.several.any-type** (object `base`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE validFrom > ? ORDER BY validFrom, resourceId
```
```text
SCAN Snapshots
USE TEMP B-TREE FOR ORDER BY
```

**q6.b.1.several.any-type-named, q6.b.100.several.any-type-named, q6.b.10000.several.any-type-named** (object `base`)

```sql
SELECT resourceId, validFrom, typeName FROM Snapshots WHERE validFrom > ? ORDER BY validFrom, resourceId
```
```text
SCAN Snapshots
USE TEMP B-TREE FOR ORDER BY
```

**q6.d.1.Deal.ids, q6.d.1.Deal.flow-ids, q6.d.1.Note.ids and 9 more** (object `m`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
```

**q6.d.1.Deal.rows, q6.d.1.Deal.flow-rows, q6.d.100.Deal.rows and 3 more** (object `m`)

```sql
SELECT resourceId, validFrom, nodeId, deleted, value FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
```

**q6.d.1.Deal.where, q6.d.100.Deal.where, q6.d.10000.Deal.where** (object `m`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
  CREATE BLOOM FILTER
```

**q6.d.1.several.per-type, q6.d.100.several.per-type, q6.d.10000.several.per-type** (object `m`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
SELECT resourceId, validFrom FROM Snapshots WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
```

**q6.d.1.several.in, q6.d.100.several.in, q6.d.10000.several.in** (object `m`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE typeName IN (?, ?, ?) AND validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
```

**q6.d.1.several.any-type, q6.d.100.several.any-type, q6.d.10000.several.any-type** (object `m`)

```sql
SELECT resourceId, validFrom FROM Snapshots WHERE validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING COVERING INDEX idx_Snapshots_moment (validFrom>?)
```

**q6.d.1.several.any-type-named, q6.d.100.several.any-type-named, q6.d.10000.several.any-type-named** (object `m`)

```sql
SELECT resourceId, validFrom, typeName FROM Snapshots WHERE validFrom > ? ORDER BY validFrom, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_moment (validFrom>?)
```

### Timing notes

- Cases with a joined timing: 214 of 214; with every round joined: 214.
- Slowest round over fastest, per case: median 1.29, worst 8.25.
- An empty invocation's cpuTimeMs: 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.
- Cases whose timed rows differed from the first call's: none.
