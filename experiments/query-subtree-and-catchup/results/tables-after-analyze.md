<!-- from run-2026-11-23T16-46-05-962Z-analyzed.json, run 2026-11-23T16:46:05.962Z to 2026-11-23T16:46:34.619Z -->

### Q2 whole read, filter `stage`

Rows read:

| Nodes in subtree | Results | (b) |
| --- | --- | --- |
| 1 | 0 | 8 |
| 4 | 1 | 25 |
| 41 | 22 | 258 |
| 411 | 242 | 2,794 |
| 4,111 | 2,416 | 26,520 |

CPU:

| Nodes in subtree | Results | (b) |
| --- | --- | --- |
| 1 | 0 | ? |
| 4 | 1 | ? |
| 41 | 22 | ? |
| 411 | 242 | ? |
| 4,111 | 2,416 | ? |

### Q2 whole read, filter `owner`

Rows read:

| Nodes in subtree | Results | (b) |
| --- | --- | --- |
| 1 | 0 | 56 |
| 4 | 0 | 59 |
| 41 | 0 | 96 |
| 411 | 1 | 474 |
| 4,111 | 54 | 4,166 |

CPU:

| Nodes in subtree | Results | (b) |
| --- | --- | --- |
| 1 | 0 | ? |
| 4 | 0 | ? |
| 41 | 0 | ? |
| 411 | 1 | ? |
| 4,111 | 54 | ? |

### Q2 whole read, filter `all`

Rows read:

| Nodes in subtree | Results | (b) |
| --- | --- | --- |
| 1 | 4 | 11 |
| 4 | 12 | 36 |
| 41 | 116 | 352 |
| 411 | 1,312 | 3,864 |
| 4,111 | 12,000 | 36,104 |

CPU:

| Nodes in subtree | Results | (b) |
| --- | --- | --- |
| 1 | 4 | ? |
| 4 | 12 | ? |
| 41 | 116 | ? |
| 411 | 1,312 | ? |
| 4,111 | 12,000 | ? |

### Q2 first read in pages

| Filter | Nodes | Page | Arm | Results | Statements | Pages | Rows read, all pages | Rows read, first three pages | CPU, all pages |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Query plans

**q2.whole.stage.n1.b, q2.whole.stage.n4.b, q2.whole.stage.n41.b and 2 more** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_node (nodeId=? AND typeName=?)
LIST SUBQUERY 1
  SCAN json_each VIRTUAL TABLE INDEX 1:
USE TEMP B-TREE FOR ORDER BY
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

### Timing notes

- Cases with a joined timing: 0 of 15; with every round joined: 0.
- Slowest round over fastest, per case: median NaN, worst -Infinity.
- An empty invocation's cpuTimeMs: .
- Cases whose timed rows differed from the first call's: none.
