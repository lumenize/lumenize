# Experiment — R2 OLAP latency vs Durable Object SQLite

Spike for [`tasks/spike-r2-olap-latency.md`](../../tasks/spike-r2-olap-latency.md). **Not a maintained artifact** — results land in `RESULTS.md`; the code may break after the source it depends on changes (that's fine, per the experiments convention).

**Question:** is querying unbounded history on **R2** (via R2 SQL over Data Catalog/Iceberg) acceptable latency vs. keeping it in a **Durable Object's SQLite**? Sub-second ideal; the fear is several seconds. Closes `nebula-resource-history-r2.md` **D4**.

## Two arms (R2 or a DO — nothing else)
1. **DO SQLite** — `HistoryStoreDO` (`src/index.ts`), queried through the **real mesh path** (`lmz.call`) so `lmz.call` + auth overhead is in the number. Develops/measures under `wrangler dev`.
   - ⚠️ **Faithful-path TODO:** upgrade the fixture from `LumenizeDO` → **`NebulaDO`** (+ `@mesh(requireAdmin)` + scope-isolation) and wire the mesh **entrypoint + Gateway + client** so the harness issues real mesh calls — this is the auth-harness cost the spike calls out. The shipped stub is `LumenizeDO` (the "or at least LumenizeDO" fallback: captures core mesh overhead, not the Nebula scope-check delta).
2. **R2 SQL over R2 Data Catalog (Iceberg)** — queried from **Node → R2 SQL REST API** directly (no Worker binding exists; a Worker would only proxy the same HTTP call). Deployed-only.

## Measurement
External **Node.js** observer (`test/measure.mjs`), reusing the `experiments/dag-sql-perf/test/measure.mjs` pattern (`node:perf_hooks`, p50/p95/p99, warmup, cold+warm). Headline = true end-to-end latency; paired-noop baseline only to isolate the mesh+auth floor from SQL cost.

## Run order
1. `npm run gen` — generate deterministic rows (`scripts/gen-data.mjs <count>` → `data/rows-<count>.ndjson`). Staged: 5k → 100k → 1M → 10M.
2. **Account gate (one-time):** enable R2 Data Catalog on the bucket; mint an R2 API token with R2 SQL Read; `export WRANGLER_R2_SQL_AUTH_TOKEN=...`. Set `ACCOUNT_ID` + `WAREHOUSE`/`BUCKET` env.
3. Load Iceberg (arm 2): `scripts/load-iceberg` (TODO — PyIceberg via the Iceberg REST catalog, or Cloudflare Pipelines). *PyIceberg is a Python dep — flag before adopting.*
4. Arm 1: `npm run dev` (terminal 1) + `npm run measure:do` (terminal 2).
5. Arm 2: `npm run measure:r2` (Node → R2 SQL REST).
6. Record p50/p95/p99 × query × scale × arm into `RESULTS.md`; write the tiering recommendation back to ADR-004 / D4.

## Step-0 facts (verified 2026-06-22)
- R2 SQL / Data Catalog / Pipelines = **open beta, free now, no plan gating**.
- R2 SQL = `wrangler r2 sql query` CLI **+** REST `POST https://api.sql.cloudflarestorage.com/api/v1/accounts/{ACCOUNT_ID}/r2-sql/query/{BUCKET}` (auth: R2 API token). **No Worker binding.**
- R2 SQL is **full analytical SQL** (WHERE/ORDER BY/GROUP BY+ROLLUP/aggregates/JOINs/CTE/window), **SELECT-only**, default `LIMIT 500`.
- Iceberg load = standard Iceberg REST catalog (PyIceberg/Spark) or Pipelines.

## Build checklist (the actual work)
- [ ] `NebulaDO` upgrade + auth harness + mesh entrypoint/Gateway/client (arm 1 faithful path)
- [ ] Iceberg loader (arm 2) + the account gate
- [ ] R2 SQL REST query runner in `measure.mjs` (arm 2)
- [ ] DO point-GET latency measurement (D4's original narrow ask → D2 spill threshold)
- [ ] scale tiers 1M / 10M (only if the floor at 100k looks promising)
