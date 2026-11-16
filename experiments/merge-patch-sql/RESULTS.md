# merge-patch-sql: JSON Merge Patch in JavaScript, or in the Durable Object's SQLite?

**Question.** A stored value lives in SQLite as text (`Snapshots.value`). Applying an RFC 7396 merge patch to it, or generating one between two stored versions, can happen in JavaScript, which means moving the whole value out of SQLite and back in, or inside SQLite with JSON1, where only the patch crosses. Does moving a big value across that boundary cost more than SQLite saves, or less? The largest case is a 10,000-node org tree with one node moved to a new parent.

**Answer.** It depends on which half of the job, and the winner is clear for each.

- **Applying a small patch is cheaper in SQLite, about 2× on text and 3.5× on JSONB.** On the 10,000-node tree (2.16 MB), moving one node costs 28 ms of CPU in JavaScript and 15 ms as one `INSERT … SELECT json_patch(…)`, or 9 ms with the value stored as JSONB. Every one-record change at every size went the same way, 1.3–3.5× on text.
- **The SQL lead disappears when the write needs the merged value back in JavaScript.** A write that validates or broadcasts the result reads it back with `RETURNING` and parses it, and that costs about what the JavaScript round trip does: 1.1× on the 10,000-node move, 0.7–2.0× across one-record changes.
- **`json_patch` gets slow as a patch touches many keys of one big object, and JavaScript doesn't.** SQLite searches the target object linearly for each key in the patch and moves the rest of the value in memory on each edit (§ *What the source says*). Break-even was about 100 changed labels in the 10,000-node tree and 300 in the 3,000-node one. With every label changed, SQLite took 637 ms against JavaScript's 31 ms.
- **Generating a patch is cheaper in JavaScript, in all 30 conditions.** SQLite has no diff, and the two built from JSON1 both lost. On the 10,000-node move, `diff` from `@lumenize/structured-clone` took 52 ms, the best SQL version 86 ms, and a one-statement `json_tree` diff 345 ms. The SQL version that comes closest needs one statement per changed object, so a change spread across a hundred nodes took it over a second.
- **Moving the value across the boundary is not the expensive part.** At 3,000 nodes, reading the 650 KB value into JavaScript and writing it back costs 0.45 ms. What the JavaScript path pays is V8 parsing and re-stringifying the whole value, 4.1 ms, against 1.5 ms for all of `json_patch` on text and 0.24 ms on JSONB.
- **At 10,000 nodes the value outgrows SQLite's page cache, and both paths slow down for it.** Per byte, reading and writing the value cost 4–6× what they did at 3,000 nodes, while V8's parse and stringify scaled with size. Both arms pay that I/O, so SQL's apply lead narrows from 3.5× at 3,000 nodes to 1.9× at 10,000.

## What the source says

Read in SQLite 3.53.0's [`src/json.c`](https://github.com/sqlite/sqlite/blob/version-3.53.0/src/json.c). workerd builds 3.53.4 ([`do-read-cache`](../do-read-cache/RESULTS.md) § *What the source says*).

- **`jsonMergePatch` is a nested loop.** For each label in the patch object, it scans the target object's labels from the first until one matches (the `while( iTCursor<iTEnd )` loop inside `while( iPCursor<iPEnd )`). A patch with p keys against an object with t members costs up to p × t label comparisons. JavaScript's `applyMergePatch` looks each key up in a hash.
- **Each edit can move the whole tail of the value.** The target is edited in place as one JSONB buffer. `jsonBlobEdit` `memmove`s everything after the edited spot whenever the new value's size differs from the old, so relabelling every node of a 2 MB tree moves on the order of 10,000 × 1 MB.
- **On text, `json_patch` converts first.** It parses the text into JSONB, patches, and renders text again. `jsonb_patch` on a JSONB column skips both conversions, which is the gap between the `sql` and `sqlb` arms.
- **There is no diff in JSON1.** `json_tree` and `json_each` enumerate a value, so a diff has to pair two enumerations by path.

## Method

`experiment-merge-patch-sql`, deployed 2026-11-15 with compatibility date 2026-10-01, wrangler 4.147.0. It ran deployed only. The object's own clock can't time synchronous work, and Workers Logs, which can, exists only deployed ([`do-read-cache`](../do-read-cache/RESULTS.md) § *The object's clock can't time its own work*).

- **The value.** An org tree in the shape `#buildState` in `packages/resources/src/org-tree.ts` returns: `{ nodes: Map, edges: Set<"parent:child">, permissions: Map<nodeId, Map<sub, tier>> }`. nodeIds and subs are UUIDs, as in the product. Each node's parent is drawn uniformly from the nodes before it, about 2% of nodes get a second parent, and about 10% carry 1–3 grants. It is encoded with the real `stringify` from `@lumenize/structured-clone`, so the stored text is what Resources would store: about 216 bytes per node, **2.16 MB at 10,000 nodes**. A JSONB copy is about 8% smaller.
- **The mutations.**
  - `move` deletes one edge and adds another, the headline case. Its patch is 181 bytes at every size.
  - `rename` (one label) and `add` (one node and its edge) are the other one-record changes.
  - `relabel-1pct`, `relabel-10pct` and `relabel-100pct` change that share of node labels, so the patch grows with the tree, to 834 KB at 10,000 nodes.
- **Storage.** `S (id, vf, value TEXT) WITHOUT ROWID`, the shape of `Snapshots`, holds `v0` (before) and `v1` (after). `SB` is the same table storing JSONB. A write goes to a third row, `out`, with `INSERT OR REPLACE`, so the database stays one condition big. Every arm writes the same bytes, so write costs cancel between arms.
- **The patch** reaches each call as a JS object, which is how Mesh would deliver it. A SQL arm pays `JSON.stringify` of it on every rep; a JS arm doesn't.

### The arms

| op | arm | what one rep does |
|---|---|---|
| apply | `js` | `SELECT value` → `JSON.parse` → `applyMergePatch` → `JSON.stringify` → `INSERT` |
| | `sql` | `INSERT … SELECT json_patch(value, ?)`: the value never leaves SQLite |
| | `jsb`, `sqlb` | the same on JSONB storage (`json(value)` out, `jsonb(?)` in; `jsonb_patch`) |
| applyRead | `sql`, `sqlb` | `apply`, plus `RETURNING` the merged value and `JSON.parse` it, for a write that must validate or broadcast the result. A JS arm already holds it, so its cost is `apply`'s. |
| diff | `js`, `jsb` | read both values, `JSON.parse` both, `diff` from `@lumenize/structured-clone`, stringify the patch |
| | `sqltree` | one statement: `json_tree` over both values, paired by path with `GROUP BY`; only changed leaves come back ([`src/sql-diff.ts`](src/sql-diff.ts)) |
| | `sqlwalk` | one statement per changed container: `json_each` lists its children in both values and returns those that differ, comparing a container whole by its text; JS descends. It mirrors `diff`, which compares a subtree whole before descending. Capped at 300 statements a patch. |
| | `sqlbtree`, `sqlbwalk` | the same on JSONB storage |
| part | each | one component alone, to explain the totals |

Both SQL diffs hand JS only the changed rows, which JS turns into the patch object. Before timing, every arm's output on every object was checked: the applied value byte-equal to the stored `after`, and each patch equal to `diff`'s and producing `after` when applied.

### Timing

- Each timed call does one arm `reps` times, calibrated so the call does about 150 ms of work. It logs `{ probe, seq }` first, and `scripts/logs.mjs` joins that line to the invocation's `cpuTimeMs` and `wallTimeMs` in Workers Logs. All 6,060 calls joined.
- Per rep = (the call's `cpuTimeMs` − the `ping` just before it) ÷ reps. A one-rep warm call precedes each timed call, so the condition's pages are in SQLite's cache, as they would be for a value written moments ago.
- **Hosts differ, so ratios are paired.** Two objects in the same colo ran every arm 1.5–2× apart, so each ratio is taken within one object and the tables give the median across objects with their range. Absolute times are the median across objects.
- **Objects.** Each condition ran on 2 objects (`locationHint: 'enam'`; they landed in IAD, EWR, ORD, ATL and MIA), 3 rounds each, arms shuffled. The 10,000-node move ran on 8 (6 in IAD, 2 in MIA), the last 6 for 5 rounds. The 10,000-node `relabel-100pct` has one object: Cloudflare reset the second during its verify call, while the 300-statement walk was running (§ *Generating a patch*).

## Results

### The headline: 10,000 nodes, one node moved

CPU ms per operation, 8 objects. Wall time tracked CPU within 10% on every apply arm (the full wall tables are in [`results/tables.md`](results/tables.md)).

| op | `js` | `jsb` | `sql` | `sqlb` | paired ratio |
|---|---:|---:|---:|---:|---|
| apply | 28.3 | 31.0 | 15.3 | 8.90 | js ÷ sql 1.9× (1.5–2.1); jsb ÷ sqlb 3.5× (3.0–3.8) |
| apply, value back in JS | = apply | = apply | 27.0 | 21.9 | js ÷ sql 1.1× (0.8–1.2); jsb ÷ sqlb 1.4× (1.2–1.5) |

| op | `js` | `jsb` | `sqltree` | `sqlwalk` | `sqlbtree` | `sqlbwalk` | paired ratio |
|---|---:|---:|---:|---:|---:|---:|---|
| diff | 52.1 | 56.4 | 345 | 95.5 | 353 | 85.8 | sqlwalk ÷ js 1.9× (1.0–2.0); sqlbwalk ÷ jsb 1.5× (1.3–1.7); sqltree ÷ js 6.7× (3.2–7.7) |

### Where the time goes

CPU ms for one component, from the `part` arms. 3,000 nodes is the largest size whose value fits SQLite's cache.

| nodes | value | read into JS | write from JS | `JSON.parse` | `JSON.stringify` | `applyMergePatch` | `diff` | `json_patch` (text) | `jsonb_patch` |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 214 KB | 0.10 | 0.08 | 0.82 | 0.63 | 0.28 | 1.78 | 0.76 | 0.09 |
| 3,000 | 649 KB | 0.25 | 0.20 | 2.13 | 1.96 | 1.38 | 7.19 | 1.51 | 0.24 |
| 10,000 | 2.16 MB | 3.83 | 3.73 | 8.13 | 9.27 | 4.34 | 35.8 | 8.84 | 3.38 |

- **The boundary is cheap while the value is cached.** At 3,000 nodes, 650 KB out and back costs 0.45 ms. Parsing and stringifying it costs 4.1 ms, nine times as much.
- **SQLite's own JSON is faster than V8's for this job.** `json_patch` on text, which reads the value, parses it, patches and renders it, costs 1.51 ms against 4.1 ms for V8's parse and stringify alone. On JSONB there is nothing to parse, and it costs 0.24 ms.
- **Past the cache, I/O dominates both arms.** From 3,000 to 10,000 nodes the value grows 3.3×. Reading it into JS grows 15×, writing 18× and `jsonb_patch` 14×, while `JSON.parse` grows 3.8× and `applyMergePatch` 3.1×. That fits SQLite's default page cache of about 2000 KiB ([`do-read-cache`](../do-read-cache/RESULTS.md)): an apply touches both the 2.16 MB `v0` and the 2.16 MB `out`.
- **`diff` costs more than parsing both values.** At 10,000 nodes it takes 35.8 ms against 8.1 ms per parse, and is most of the `js` diff arm. It wasn't the question here.

### Applying a patch

CPU ms per write. The ratios are paired, `js ÷ sql` and `jsb ÷ sqlb`, so above 1× SQLite is cheaper.

| nodes | change | patch | `js` | `sql` | `sqlb` | js ÷ sql | jsb ÷ sqlb |
|---:|---|---:|---:|---:|---:|---:|---:|
| 10 | move | 181 B | 0.045 | 0.021 | 0.016 | 2.1× | 3.0× |
| 100 | move | 181 B | 0.29 | 0.12 | 0.07 | 2.4× | 4.2× |
| 1,000 | move | 181 B | 2.05 | 0.67 | 0.24 | 3.1× | 13.7× |
| 3,000 | move | 181 B | 6.03 | 1.72 | 0.57 | 3.5× | 13.0× |
| 10,000 | move | 181 B | 28.3 | 15.3 | 8.90 | 1.9× | 3.5× |
| 10,000 | rename | 102 B | 33.4 | 19.0 | 13.2 | 1.8× | 3.0× |
| 10,000 | add | 215 B | 27.6 | 11.9 | 9.33 | 2.3× | 3.3× |
| 1,000 | relabel 1% | 847 B | 2.60 | 1.07 | 0.62 | 2.6× | 7.8× |
| 1,000 | relabel 10% | 8.3 KB | 2.34 | 1.37 | 0.94 | 1.7× | 2.8× |
| 1,000 | relabel 100% | 82 KB | 4.55 | 12.2 | 9.95 | 0.4× | 0.4× |
| 3,000 | relabel 1% | 2.5 KB | 5.35 | 2.09 | 1.09 | 2.6× | 6.1× |
| 3,000 | relabel 10% | 25 KB | 9.88 | 9.99 | 8.07 | 1.0× | 1.4× |
| 3,000 | relabel 100% | 249 KB | 5.71 | 56.5 | 51.8 | 0.1× | 0.1× |
| 10,000 | relabel 1% | 8.4 KB | 40.1 | 35.4 | 25.4 | 1.2× | 1.9× |
| 10,000 | relabel 10% | 83 KB | 32.8 | 92.0 | 87.0 | 0.4× | 0.4× |
| 10,000 | relabel 100% | 834 KB | 31.0 | 637 | 623 | 0.05× | 0.06× |

Every one-record change, at every size, favored SQLite: 1.3–3.5× on text, 2.5–16× on JSONB ([`results/tables.md`](results/tables.md) has all 30 rows). The JavaScript cost barely moves with the patch, because it parses and stringifies the whole value either way. SQLite's grows with the number of keys the patch changes in one object.

**When the merged value has to come back to JavaScript**, SQL's lead is gone. Across the one-record changes, `apply js ÷ applyRead sql` ran 0.7–2.0× and was 1.1× on the 10,000-node move. JSONB kept a little more, 1.1–2.2×. On the wide relabels JavaScript won by the same margins as above.

### Generating a patch

CPU ms per patch. The ratios are paired, against the JS arm on the same storage, so above 1× JavaScript is cheaper.

| nodes | change | `js` | `sqltree` | `sqlwalk` | `sqlbwalk` | sqltree ÷ js | sqlwalk ÷ js | sqlbwalk ÷ jsb |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 100 | move | 0.32 | 3.34 | 2.15 | 1.18 | 10.5× | 6.6× | 2.3× |
| 1,000 | move | 3.74 | 38.8 | 8.21 | 6.03 | 10.1× | 2.1× | 1.4× |
| 3,000 | move | 16.9 | 106 | 20.3 | 16.4 | 6.2× | 1.2× | 1.2× |
| 10,000 | move | 52.1 | 345 | 95.5 | 85.8 | 6.7× | 1.9× | 1.5× |
| 10,000 | rename | 73.3 | 404 | 126 | 115 | 5.8× | 1.8× | 1.6× |
| 10,000 | add | 44.0 | 279 | 142 | 116 | 6.4× | 3.2× | 2.6× |
| 10,000 | relabel 1% | 61.8 | 624 | 2,084 | 1,324 | 9.8× | 34× | 16× |
| 10,000 | relabel 10% | 47.0 | 372 | over budget | over budget | 7.9× | — | — |
| 10,000 | relabel 100% | 49.0 | 285 | over budget | over budget | 5.8× | — | — |

- **JavaScript won all 30 conditions.** The closest SQL came, by median, was the walk at 1.2× on the 3,000-node move. On one of the eight 10,000-node objects the walk tied.
- **The tree diff costs 6–17× JavaScript whatever changed.** It enumerates every node of both values, about 55,000 rows each at 10,000 nodes, and pairs them with a sort.
- **The walk is close on a one-record change and collapses on a spread one.** It runs one statement per changed object, and each statement re-reads both values. A one-node move needs three statements; relabelling 100 nodes needs about 103, which took 1.3–2.1 s. Past 300 it stops, and the verify call that ran it to 300 on the 10,000-node `relabel-100pct` was reset by Cloudflare: *"Durable Object storage operation exceeded timeout which caused object to be reset."*

## What this says about Item 14

`tasks/nebula-pre-alpha-fast-follow.md` § *Item 14* asks for exactly this: SQLite's `json_patch` against `applyMergePatch` where the server applies a patch it receives, against a write path that may decode the merged value anyway to validate it.

- **`diff` stays in JavaScript.** SQLite has none, and the ones JSON1 can build lose everywhere.
- **`json_patch` saves about 13 ms per write on a 10,000-node tree, but only in a narrow case.** The write must never need the merged value in JavaScript, which validation does, and the patch must be narrow, since a wide one costs up to 20× more. `applyMergePatch`'s cost tracks the size of the value and nothing else.
- **JSONB storage is the lever that widens SQL's lead.** It makes `jsonb_patch` 3.5× cheaper than the JavaScript round trip on the same storage at 10,000 nodes, and 13× at 3,000. It also makes every JavaScript read pay a `json()` conversion, 3× the plain read at 1,000 nodes and 1.3× at 10,000.

## Files

- [`src/index.ts`](src/index.ts) — the Worker and the object; every arm is one `case` in `#once`.
- [`src/sql-diff.ts`](src/sql-diff.ts) — the two SQL diffs.
- [`src/fixture.ts`](src/fixture.ts) — the org tree and its mutations.
- [`scripts/probe.mjs`](scripts/probe.mjs), [`scripts/logs.mjs`](scripts/logs.mjs), [`scripts/analyze.mjs`](scripts/analyze.mjs) — drive, join Workers Logs, tabulate.
- [`results/`](results/) — the four runs, logs joined, and [`tables.md`](results/tables.md), every condition.

The `experiment-merge-patch-sql` Worker is still deployed and waits for the periodic sweep of `experiment-*` Workers.
