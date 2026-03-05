# DAG SQL Performance Experiment

Measures real-world latency of DAG tree operations using SQLite inside a Durable Object.

**Task file**: `tasks/nebula-dag-tree.md` (Phase 3.0)

## Question

Can we use simple N+1 iterative SQL queries (JS loops + one query per hop) for DAG permission resolution, or do we need CTE / in-memory alternatives?

## Decision Gate

`resolvePermission` p95 < 5ms (after subtracting WebSocket baseline).

## Tree Shape

- ~500 nodes, max depth 8
- 5 DAG edges (diamonds — nodes with multiple parents)
- Permission grants at depths 0, 2, 4, and 6

## Operations Measured

| Operation | Description |
|-----------|-------------|
| `resolvePermission` | BFS up from target, check Permissions at each node, early-exit on highest tier |
| `findAncestors` | Full ancestor set via BFS up |
| `findDescendants` | Full descendant set via BFS down |
| `detectCycle` | Would adding an edge create a cycle? (BFS up looking for target) |
| `noop` | WebSocket round-trip baseline (no SQL) |

## How to Run

```bash
# Terminal 1: Start the DO
npm run dev

# Terminal 2: Run measurements (default: 100 iterations per operation)
npm test

# Or with custom iteration count
npm test 200
```

## How It Works

1. Node.js client connects via WebSocket to the DO
2. Sends `seed` command — DO creates tables and inserts ~500 nodes
3. For each operation, sends individual commands and times the round-trip
4. DO clock is frozen during synchronous SQL, so timing is client-side
5. No-op baseline is subtracted to isolate SQL processing time
6. Reports avg / p50 / p95 / max for each operation
