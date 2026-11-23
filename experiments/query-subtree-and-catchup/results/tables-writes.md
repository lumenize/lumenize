<!-- from run-2026-11-23T17-13-50-597Z-writes.json, run 2026-11-23T17:13:50.597Z to 2026-11-23T17:13:55.187Z -->

### Q2 first read in pages

| Filter | Nodes | Page | Arm | Results | Statements | Pages | Rows read, all pages | Rows read, first three pages | CPU, all pages |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Rows written per write

| Write | base (close + insert) | node (close + insert) | tm (close + insert) | m (close + insert) | swap (close + insert) |
| --- | --- | --- | --- | --- | --- |
| Deal create | 0 + 4 | 0 + 5 | 0 + 5 | 0 + 5 | 0 + 4 |
| Deal update | 1 + 4 | 1 + 5 | 1 + 5 | 1 + 5 | 1 + 4 |
| Contact create | 0 + 3 | 0 + 4 | 0 + 4 | 0 + 4 | 0 + 3 |
| Contact update | 1 + 3 | 1 + 4 | 1 + 4 | 1 + 4 | 1 + 3 |
| Task create | 0 + 2 | 0 + 3 | 0 + 3 | 0 + 3 | 0 + 2 |
| Task update | 1 + 2 | 1 + 3 | 1 + 3 | 1 + 3 | 1 + 2 |
| Note create | 0 + 2 | 0 + 3 | 0 + 3 | 0 + 3 | 0 + 2 |
| Note update | 1 + 2 | 1 + 3 | 1 + 3 | 1 + 3 | 1 + 2 |

### Query plans

### Timing notes

- Cases with a joined timing: 0 of 0; with every round joined: 0.
- Slowest round over fastest, per case: median NaN, worst -Infinity.
- An empty invocation's cpuTimeMs: .
- Cases whose timed rows differed from the first call's: none.
