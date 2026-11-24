<!-- from run-2026-11-23T16-59-52-600Z-swap.json, run 2026-11-23T16:59:52.600Z to 2026-11-23T17:01:41.842Z -->

### Q2 whole read, filter `stage`

Rows read:

| Nodes in subtree | Results | (swap) | (swap-node) |
| --- | --- | --- | --- |
| 1 | 0 | 8 | 7 |
| 4 | 1 | 25 | 24 |
| 41 | 22 | 258 | 236 |
| 411 | 242 | 2,794 | 2,552 |
| 4,111 | 2,416 | 26,520 | 24,104 |

CPU:

| Nodes in subtree | Results | (swap) | (swap-node) |
| --- | --- | --- | --- |
| 1 | 0 | 45 µs | 50 µs |
| 4 | 1 | 77 µs | 73 µs |
| 41 | 22 | 1.2 ms | 1.3 ms |
| 411 | 242 | 15 ms | 15 ms |
| 4,111 | 2,416 | 136 ms | 136 ms |

### Q2 whole read, filter `owner`

Rows read:

| Nodes in subtree | Results | (swap) | (swap-node) |
| --- | --- | --- | --- |
| 1 | 0 | 8 | 7 |
| 4 | 0 | 25 | 24 |
| 41 | 0 | 237 | 236 |
| 411 | 1 | 2,553 | 2,552 |
| 4,111 | 54 | 24,158 | 24,104 |

CPU:

| Nodes in subtree | Results | (swap) | (swap-node) |
| --- | --- | --- | --- |
| 1 | 0 | 57 µs | 47 µs |
| 4 | 0 | 64 µs | 62 µs |
| 41 | 0 | 1.2 ms | 1.3 ms |
| 411 | 1 | 14 ms | 14 ms |
| 4,111 | 54 | 125 ms | 171 ms |

### Q2 whole read, filter `all`

Rows read:

| Nodes in subtree | Results | (swap) | (swap-node) |
| --- | --- | --- | --- |
| 1 | 4 | 11 | 7 |
| 4 | 12 | 36 | 24 |
| 41 | 116 | 352 | 236 |
| 411 | 1,312 | 3,864 | 2,552 |
| 4,111 | 12,000 | 36,104 | 24,104 |

CPU:

| Nodes in subtree | Results | (swap) | (swap-node) |
| --- | --- | --- | --- |
| 1 | 4 | 30 µs | 40 µs |
| 4 | 12 | 50 µs | 40 µs |
| 41 | 116 | 1.3 ms | 1.3 ms |
| 411 | 1,312 | 17 ms | 16 ms |
| 4,111 | 12,000 | 153 ms | 140 ms |

### Q2 first read in pages

| Filter | Nodes | Page | Arm | Results | Statements | Pages | Rows read, all pages | Rows read, first three pages | CPU, all pages |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 411 | 2000 kB | (swap-rest) | 1,312 | 1 | 1 | 2,552 | 2,552 | 22 ms |
| all | 411 | 250 kB | (swap-rest) | 1,312 | 2 | 2 | 2,747 | 1,576, 1,171 | 17 ms |
| all | 4,111 | 2000 kB | (swap-rest) | 12,000 | 3 | 3 | 26,649 | 13,281, 11,539, 1,829 | 141 ms |
| all | 4,111 | 250 kB | (swap-rest) | 12,000 | 18 | 18 | 57,661 | 5,292, 5,032, 4,742 | 165 ms |
| stage | 411 | 2000 kB | (swap-rest) | 242 | 1 | 1 | 2,552 | 2,552 | 17 ms |
| stage | 411 | 250 kB | (swap-rest) | 242 | 1 | 1 | 2,552 | 2,552 | 16 ms |
| stage | 4,111 | 2000 kB | (swap-rest) | 2,416 | 1 | 1 | 24,104 | 24,104 | 138 ms |
| stage | 4,111 | 250 kB | (swap-rest) | 2,416 | 4 | 4 | 29,306 | 9,943, 8,854, 7,117 | 147 ms |

### Query plans

**q2.whole.stage.n1.swap, q2.whole.stage.n4.swap, q2.whole.stage.n41.swap and 2 more** (object `swap`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeNode (typeName=? AND nodeId=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
```

**q2.whole.stage.n1.swap-node, q2.whole.stage.n4.swap-node, q2.whole.stage.n41.swap-node and 2 more** (object `swap`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_typeNode WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeNode (typeName=? AND nodeId=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.whole.owner.n1.swap, q2.whole.owner.n4.swap, q2.whole.owner.n41.swap and 2 more** (object `swap`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.owner') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeNode (typeName=? AND nodeId=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
```

**q2.whole.owner.n1.swap-node, q2.whole.owner.n4.swap-node, q2.whole.owner.n41.swap-node and 2 more** (object `swap`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_typeNode WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.owner') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeNode (typeName=? AND nodeId=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.whole.all.n1.swap, q2.whole.all.n4.swap, q2.whole.all.n41.swap and 2 more** (object `swap`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeNode (typeName=? AND nodeId=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
```

**q2.whole.all.n1.swap-node, q2.whole.all.n4.swap-node, q2.whole.all.n41.swap-node and 2 more** (object `swap`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_typeNode WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeNode (typeName=? AND nodeId=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.paged.all.n411.2000k.swap-rest, q2.paged.all.n411.250k.swap-rest, q2.paged.all.n4111.2000k.swap-rest and 1 more** (object `swap`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_typeNode WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND nodeId IN (SELECT value FROM json_each(?)) AND (nodeId, resourceId) > (?, ?) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeNode (typeName=? AND nodeId=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

**q2.paged.stage.n411.2000k.swap-rest, q2.paged.stage.n411.250k.swap-rest, q2.paged.stage.n4111.2000k.swap-rest and 1 more** (object `swap`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_typeNode WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) AND (nodeId, resourceId) > (?, ?) ORDER BY nodeId, resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_typeNode (typeName=? AND nodeId=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
```

### Timing notes

- Cases with a joined timing: 38 of 38; with every round joined: 38.
- Slowest round over fastest, per case: median 1.22, worst 2.02.
- An empty invocation's cpuTimeMs: 0, 0, 0, 0, 0.
- Cases whose timed rows differed from the first call's: none.
