# Spike — R2 OLAP query latency vs Durable Object SQLite

**Status**: Active — exploratory spike. **Not for hand-review** (spike convention; the approach will deviate as we learn). Deliverable = `experiments/r2-olap-latency/RESULTS.md`.

**Closes**: the **R2 latency** open question for unbounded history — [ADR-004](../docs/adr/004-snodgrass-temporal-resources.md)-adjacent, and specifically **D4 ("R2 latency benchmark")** in [`on-hold/nebula-resource-history-r2.md`](on-hold/nebula-resource-history-r2.md). Secondary: confirms the storage philosophy that also covers the Studio turn-recorder corpus.

**Refs**: Cloudflare [R2 SQL docs](https://developers.cloudflare.com/r2-sql/) · [R2 Data Catalog (Iceberg)](https://developers.cloudflare.com/r2/data-catalog/) · [R2 SQL deep dive](https://blog.cloudflare.com/r2-sql-deep-dive/). Node measurement harness template: `experiments/dag-sql-perf/test/measure.mjs`. Clock gotcha: memory `cf-clock-traps`.

## The question

Resources history is **tiered** (ADR-004): hot, queryable metadata rows in the Star's SQLite (eTag source of truth) + cold snapshot **blobs** in R2 (fetched by key — a GET, not a query). The open worry: when we need **analytical queries across cold history**, is R2 acceptable? **Sub-second is acceptable; the fear is several seconds.** R2 SQL is built for *petabyte-scale* scans, so it likely carries a **fixed per-query overhead floor** that won't shrink with fewer rows — i.e. "a few thousand rows" mostly measures that floor. So the real questions are the **floor**, the **latency-vs-scale curve**, and the **crossover** where the DO stops being viable.

**R2 is the only acceptable unbounded store.** No D1, no DuckDB, no third data store — same reasoning both times: don't introduce a new store unless it's R2 (or a DO we already run).

## Pin first — the real query workload (may dissolve half the worry)

Before benchmarking, enumerate the queries that **actually** need to hit cold R2 history vs. those served by hot DO SQLite + R2 point-GETs:
- "All versions of resource X over time" / "snapshot as-of T" → DO-SQLite metadata + R2 point-GET → **fast, no R2 OLAP.**
- "Writes per day/type across all history", "top-N most-revised", cross-tenant analytics → **the R2-SQL scan question.** Plausibly an *offline/rare* workload where multi-second is fine.

Benchmark the queries we'll really run; don't optimize a path we won't use.

## Hypothesis (to confirm/refute, not assume)

Hot/interactive → **DO SQLite** (sub-ms–few-ms at thousands–low-millions of rows; mesh-for-free; bounded by per-DO size + single-DO throughput + $1/M-row writes). Cold/unbounded/analytical → **R2 SQL** (unbounded, egress-free, cheap; multi-second floor; ingest via Pipelines + compaction). The spike measures the floor and the crossover so the tiering boundary is evidence-based.

## Arms (two stores only)

1. **DO SQLite** — a **`NebulaDO`** fixture (Star-like: this is how resource history would really be queried). **Queried via the real mesh path** (`lmz.call` / `callRaw` through the Gateway), NOT raw DO access — so the measurement includes the `lmz.call` + `onBeforeCall` scope-check + `@mesh(requireAdmin)` overhead. *(Larry: 95% sure mesh overhead is negligible; a 5% surprise is cheaper to find now. Fall back to `LumenizeDO` only if the Nebula auth harness proves disproportionate — that still captures the core mesh overhead, just not the Nebula scope-check delta.)*
2. **R2 SQL over R2 Data Catalog (Iceberg)** — data ingested to an Iceberg table in R2; queried via the R2 SQL surface (binding from a Worker and/or HTTP API/CLI — pin in step 0). For client-vantage parity with arm 1 (client → CF edge → query → client), run the R2 query through a thin deployed Worker rather than only the raw API.

## Datasets

Representative resource-history rows: `resourceId`, `validFrom`, `validTo`, `type`, `tenant`, `payloadBytes`. **Deterministic generation** (no `Math.random`/`Date.now` for IDs in CF — seed by index, or generate offline and load). **Staged — floor first:** start at **5k** and **100k** (cheap; gives the floor + early curve fast); extend to **1M / 10M** only if the floor looks promising and we need the DO ceiling + the crossover. Don't pre-invest in loading 10M if 100k already answers it.

## Queries (representative)

Point ("versions of resource X"), range ("snapshots in a window"), group-by aggregate ("writes per day / per type"), top-N ("most-revised resources"). Same query set on both arms.

## Measurement — external Node.js observer

Reuse the `experiments/dag-sql-perf/test/measure.mjs` pattern: a **Node.js harness** times each op client-side with `node:perf_hooks` `performance.now()`, collects **p50/p95/p99** (+ avg/min/max), runs **warmup** then **cold and warm** passes. Timing is **client-side from Node on purpose** — a DO's clock is frozen during synchronous SQL (`cf-clock-traps`), so in-DO timing is unreliable; an external Node observer measures true end-to-end latency as a client experiences it.

- **Headline metric:** raw end-to-end latency from Node, per (arm × query × scale tier), cold + warm.
- **Mesh/auth overhead (the 5% worry):** the DO arm exposes a trivial `noop` `@mesh` method; the Node-measured `noop` round-trip is the `lmz.call`+Gateway+auth+transport floor. The `query − noop` paired delta (as in the dag-sql-perf harness) isolates the SQL cost from that floor. Report both; don't over-rotate on noop — end-to-end is the decision metric.
- **Arm 1 transport:** issue **real mesh calls** from Node via a `NebulaClient` / `@lumenize/testing` client over WS+Gateway — not a raw WS protocol — so the mesh path is exercised.

## Auth (the accepted downside of arm 1)

A `NebulaDO` enforces scope isolation (`onBeforeCall`: instanceName → `authScopePattern` → `matchAccess`) + `@mesh(requireAdmin)`. So the Node harness must present a valid JWT with the matching **`activeScope` (`aud`)** for the fixture's instance + admin claims (the two-scope model). Use the established test path — minted `activeScope` per the browser-harness pattern + `LUMENIZE_AUTH_TEST_MODE` / bootstrap-admin binding in `miniflare.bindings` (memory `lumenize-auth-bootstrap-email-for-tests`). This setup is the cost of measuring the faithful path.

## Step 0 — findings (verified 2026-06-22, all green)

- **All open beta, free now, no plan gating** — R2 SQL, R2 Data Catalog, Pipelines are open beta; not currently billed (future: R2 SQL bills on *data scanned*; Data Catalog ~$9/M catalog ops + $0.005/GB compaction). Any account with an R2 subscription can use them.
- **R2 SQL has NO Worker binding** — two surfaces: the `wrangler r2 sql query <WAREHOUSE> "<SQL>"` CLI, and the REST API `POST https://api.sql.cloudflarestorage.com/api/v1/accounts/{ACCOUNT_ID}/r2-sql/query/{BUCKET}` (auth = R2 API token w/ R2 SQL Read, in `WRANGLER_R2_SQL_AUTH_TOKEN`). **So arm 2 = Node → R2 SQL REST API directly** — a Worker would only proxy the same HTTP call (no parity gain), so skip the Worker hop for arm 2.
- **R2 SQL is a full analytical engine** (not retrieval-only): `WHERE`, `ORDER BY`, `GROUP BY` (+ ROLLUP/CUBE/GROUPING SETS), `HAVING`, aggregates (COUNT/SUM/AVG/MIN/MAX), JOINs, subqueries, CTEs, window functions, set ops. **SELECT-only** (rows load via Iceberg, not SQL DML); **default `LIMIT 500`** (set explicitly for scans). Our whole query set is supported.
- **Iceberg load = the standard Iceberg REST catalog (batch)** via **PyIceberg** (or Spark) from a script; Pipelines is the streaming alternative. PyIceberg is a *Python* loader dep (outside the npm graph) — the only possible new tool; Pipelines avoids it but is its own setup. Decide at load time.
- **Deployed for arm 2** (real R2 + Catalog + R2 SQL). Arm 1 (`NebulaDO` via mesh) develops/measures under `wrangler dev`. **No new npm deps** on the CF path (CLI/REST + `fetch`).

**One account-side gate remains:** enable R2 Data Catalog on the experiment's bucket + mint an R2 API token with R2 SQL Read (a dashboard/CLI action — can't verify the account from here).

> Sources: [R2 SQL](https://developers.cloudflare.com/r2-sql/) · [R2 SQL reference](https://developers.cloudflare.com/r2-sql/sql-reference/) · [R2 Data Catalog](https://developers.cloudflare.com/r2/data-catalog/) · [Data Platform announcement](https://blog.cloudflare.com/cloudflare-data-platform/).

## Mechanics

`experiments/r2-olap-latency/` — own `package.json` + `wrangler.jsonc` (bindings: the `NebulaDO` fixture; an R2 bucket + Data Catalog; Pipelines), added as an **individual** entry to root `package.json` `workspaces`, then `npm install` at the repo root (workflow.md § Experiments). Contents: deterministic data-gen, the Iceberg loader, the Node measurement harness (adapted from `dag-sql-perf`), and `RESULTS.md`.

## Success criteria / stop condition

- p50/p95/p99 (cold + warm) for each **query × scale tier × arm**.
- The **R2 SQL fixed-overhead floor** is known (smallest query).
- The **DO-SQLite ceiling** is known (where it degrades / hits per-DO limits).
- The **`lmz.call` + auth overhead delta** is quantified (the 5% worry — resolved or flagged).
- `RESULTS.md` states a clear **tiering recommendation** (hot=DO / cold=R2 boundary) → folds into ADR-004 + `nebula-resource-history-r2.md` D4.

## Out of scope

DuckDB; D1; any non-R2/non-DO store; the actual resource-history implementation (this only measures); a production ingest pipeline (only enough to load test data).

## Downstream

Updates [ADR-004](../docs/adr/004-snodgrass-temporal-resources.md) + [`on-hold/nebula-resource-history-r2.md`](on-hold/nebula-resource-history-r2.md) D4. **The Studio turn recorder does not wait on this** — it's tiny and dev-only; build it on Galaxy/Universe DO SQLite regardless (the spike only informs whether the *unbounded* substrate could ever be R2, which the recorder corpus will never need).
