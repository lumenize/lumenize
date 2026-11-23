<!-- from run-2026-11-23T17-12-18-170Z-control2.json, run 2026-11-23T17:12:18.170Z to 2026-11-23T17:13:50.538Z -->

### Q2 first read in pages

| Filter | Nodes | Page | Arm | Results | Statements | Pages | Rows read, all pages | Rows read, first three pages | CPU, all pages |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Query plans

**control.range.base** (object `base`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY "idx_Snapshots_q_Deal:stage" WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:stage (<expr>=?)
```

**control.point.base** (object `base`)

```sql
SELECT resourceId, validFrom, value FROM Snapshots WHERE resourceId = ? ORDER BY validFrom DESC LIMIT 1
```
```text
SEARCH Snapshots USING PRIMARY KEY (resourceId=?)
```

**control.range.node** (object `node`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY "idx_Snapshots_q_Deal:stage" WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:stage (<expr>=?)
```

**control.point.node** (object `node`)

```sql
SELECT resourceId, validFrom, value FROM Snapshots WHERE resourceId = ? ORDER BY validFrom DESC LIMIT 1
```
```text
SEARCH Snapshots USING PRIMARY KEY (resourceId=?)
```

**control.range.tm** (object `tm`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY "idx_Snapshots_q_Deal:stage" WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:stage (<expr>=?)
```

**control.point.tm** (object `tm`)

```sql
SELECT resourceId, validFrom, value FROM Snapshots WHERE resourceId = ? ORDER BY validFrom DESC LIMIT 1
```
```text
SEARCH Snapshots USING PRIMARY KEY (resourceId=?)
```

**control.range.m** (object `m`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY "idx_Snapshots_q_Deal:stage" WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:stage (<expr>=?)
```

**control.point.m** (object `m`)

```sql
SELECT resourceId, validFrom, value FROM Snapshots WHERE resourceId = ? ORDER BY validFrom DESC LIMIT 1
```
```text
SEARCH Snapshots USING PRIMARY KEY (resourceId=?)
```

**control.range.swap** (object `swap`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY "idx_Snapshots_q_Deal:stage" WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:stage (<expr>=?)
```

**control.point.swap** (object `swap`)

```sql
SELECT resourceId, validFrom, value FROM Snapshots WHERE resourceId = ? ORDER BY validFrom DESC LIMIT 1
```
```text
SEARCH Snapshots USING PRIMARY KEY (resourceId=?)
```

**control.range.all** (object `all`)

```sql
SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY "idx_Snapshots_q_Deal:stage" WHERE typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0 AND json_extract(value, '$.stage') = ? ORDER BY resourceId
```
```text
SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:stage (<expr>=?)
```

**control.point.all** (object `all`)

```sql
SELECT resourceId, validFrom, value FROM Snapshots WHERE resourceId = ? ORDER BY validFrom DESC LIMIT 1
```
```text
SEARCH Snapshots USING PRIMARY KEY (resourceId=?)
```

### Controls: one statement, one plan, each object

| Statement | Rows read | CPU on `base` | CPU on `node` | CPU on `tm` | CPU on `m` | CPU on `swap` | CPU on `all` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| range | 2,417 | 22 ms | 20 ms | 40 ms | 34 ms | 20 ms | 23 ms |
| point | 200 | 10 ms | 7.4 ms | 16 ms | 15 ms | 6.0 ms | 9.2 ms |

### Timing notes

- Cases with a joined timing: 12 of 12; with every round joined: 12.
- Slowest round over fastest, per case: median 1.44, worst 2.41.
- An empty invocation's cpuTimeMs: 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.
- Cases whose timed rows differed from the first call's: none.
