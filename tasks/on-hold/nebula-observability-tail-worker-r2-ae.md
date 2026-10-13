# Queryable observability: Tail Worker → R2 (and/or Analytics Engine)

**Status**: On hold. Thinking captured 2026-06-14; rescoped 2026-10-13, when Workers Issues took the error half of the goal (§ *What Workers Issues covers*). What remains is speculative until a trend Issues cannot answer is wanted again and again (§ *Pickup signal*).
**Packages**: none changed by the core decision — `@lumenize/debug` stays as-is. New work lands in a Tail Worker (likely `apps/nebula/` or a small dedicated package) + Cloudflare Pipelines/R2 config.
**Related**:
- [experiments/workers-issues/RESULTS.md](../../experiments/workers-issues/RESULTS.md) — what Workers Issues makes of our log lines, measured 2026-10-13.
- [tasks/nebula-tenant-ai-billing.md](nebula-tenant-ai-billing.md) — already plans a **Tail Worker** for cpuTime/wallTime keyed by `durableObjectId`. Same Tail Worker should be the single egress point for *all* telemetry, including these logs.
- [tasks/on-hold/nebula-resource-history-r2.md](./nebula-resource-history-r2.md) — separate R2 use (resource history); don't conflate the buckets/datasets.
- [tasks/icebox/debug-production-transport.md](../icebox/debug-production-transport.md) — the in-process transport, iceboxed (§ *The transport task*).
**Relevant code**:
- [packages/debug/src/logger.ts](../../packages/debug/src/logger.ts) — `defaultOutput` writes `console.debug(JSON.stringify(log, ...))`. This is the harvest point, and the line Workers Issues reads; **nothing here changes**.
- [packages/debug/src/types.ts](../../packages/debug/src/types.ts) — `DebugLogOutput` shape: `{ type:'debug', level, namespace, message, timestamp, data?, stack? }`, where `stack` appears only on an error-level line carrying an Error.

## Goal

Make `@lumenize/debug` output **queryable** for automated alerting ("nightly: which namespaces are spiking warn/error?") **without** adding latency to the logging hot path and **without** baking a storage binding into the package. The motivating use case: wake up to a digest of "3,000 of X failed last night," computed by a cron over real telemetry — not discovered by a customer.

## What Workers Issues covers (2026-10-13)

Workers Issues, which `apps/nebula/wrangler.jsonc` turns on, answers the error half of that goal with no Tail Worker and no store:

- **Every error-level line and uncaught exception is recorded and grouped.** An issue is one message and top stack frame, with a count, first and last seen, and each occurrence's stack. It reads `@lumenize/debug`'s JSON line as written, and is free in its beta.
- **A script can read it.** `GET …/workers/observability/issues?orderBy=lastObserved&order=desc` lists issues with their counts, and `…/issues/{id}/occurrences` gives each one's Error, so "which errors spiked overnight" is that list against yesterday's counts. A push comes only by webhook, from an Issues automation or Cloudflare's MCP Events.
- **What it leaves to this task:** warn- and info-level trends, rates of product events such as turns per day by stop reason, `GROUP BY` over `data` fields, and retention past what Issues keeps.

The rest of this file is about that remainder.

## Settled thinking (do not re-litigate)

### 1. Two complementary destinations, not one
- **console → Workers Logs** — full fidelity incl. nested `data`, what a human reads when investigating, auto-extracts/indexes JSON fields, with **3-day (free) / 7-day (paid) retention**. ⚠️ Two facts changed by 2026-10-13. It **does** have a public query API: `POST …/workers/observability/telemetry/query`, with an events view and a calculations view, answered with the observability token in `.dev.vars`. And Nebula runs with Workers Logs **off**, since its config turns on Issues alone, so this destination costs a decision and per-line pricing rather than nothing.
- **a queryable store (R2 and/or Analytics Engine)** — for *programmatic* aggregation past what Workers Logs keeps, or at volume. This is the new piece.

### 2. The reframe — route via a Tail Worker; do NOT bind the store into `@lumenize/debug`
This **reverses** an earlier lean (2026-06-14, same session) to bake an Analytics Engine binding into the package. The Tail Worker is cleaner on every axis:

`@lumenize/debug` already does `console.debug(JSON.stringify(envelope))`. A **Tail Worker** harvests that console output out-of-band, parses the `{level, namespace, message, data}` envelope, and routes to R2 and/or AE.

- **Package needs zero changes** — no AE binding, no R2 binding; stays zero-dep and multi-runtime (no workerd-only path to tree-shake out of the browser / `@lumenize/mesh/client` bundle).
- **Zero hot-path latency** — tail events are delivered out-of-band by the platform; the Tail Worker runs separately, **billed by CPU time, not request count**. Critically, this avoids a DO writing to the store directly, which would open the input gate **and** incur wall-clock billing (per `durable-objects.md`).
- **Schema mapping lives in ONE place** (the Tail Worker), not every call site — dissolves the "would every `log.*()` call site change?" worry, and lets us swap R2↔AE later without touching any producer.
- **Consistent with the roadmap** — `nebula-tenant-ai-billing` already needs a Tail Worker; make it the one egress point for all telemetry. Caveat to carry into that task: **tail delivery is best-effort / at-least-once** — fine for log analytics, but billing that needs exactness must reconcile.

### 3. R2 vs Analytics Engine — pick at query time, not now
| Axis | Analytics Engine | R2 (Pipelines → Iceberg → R2 SQL / DuckDB) |
|---|---|---|
| **Semi-structured `data: any`** | ❌ flat, positional, no field names, no nesting — `data` collapses to a stringified blob (the positional-collision problem). | ✅ columnar Parquet/Iceberg with **named, nested, schema-evolving** fields — `GROUP BY data.errorCode` works properly. **R2 wins decisively here.** |
| **Write latency (direct)** | ✅ `writeDataPoint()` non-blocking, in-process, ~0 latency. | ❌ direct PUT-per-log = network + wall-clock + gate. Never do per-line. Must batch (Pipelines). |
| **Write latency (via Tail Worker)** | ✅ ~0 to producer | ✅ ~0 to producer — **the Tail Worker neutralizes this axis for both.** |
| **Cost @ low volume** | ✅ 10M writes/mo free, then $0.25/M — effectively free where we are. | adds Pipelines + storage + R2 SQL scan; more moving parts. |
| **Cost @ scale / retention** | capped 90-day retention, **samples at volume**. | ✅ $0.015/GB-mo, **zero egress**, arbitrary retention; R2 SQL bills on data *scanned* (partition by time/namespace). |
| **Counts** | estimates — must `SUM(_sample_interval)`, not `count()`. | exact (no sampling). |

**Conclusion**: R2 for fidelity + long retention; AE for cheap real-time counters. Because routing is in the Tail Worker, the choice is deferrable and swappable.

### 4. Verified CF facts (2026-06-14)
- **Analytics Engine `writeDataPoint` limits**: 20 blobs (strings), 20 doubles (numbers), **exactly 1 index** (≤96 bytes, the sampling key), ≤16 KB total blob size/point, ≤250 points/invocation, **90-day** retention. Non-blocking. ([get-started](https://developers.cloudflare.com/analytics/analytics-engine/get-started/), [limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/))
- **R2 query stack** ("Cloudflare Data Platform", open beta): **Pipelines** (ingest via Workers/HTTP → transform with SQL → write R2 as Iceberg/Parquet/JSON) → **R2 Data Catalog** (managed Apache Iceberg, standard REST catalog; Spark/Snowflake/PyIceberg/DuckDB) → **R2 SQL** (serverless distributed query engine, pitched explicitly for logs/events/time-series). ([Data Platform](https://blog.cloudflare.com/cloudflare-data-platform/), [R2 SQL deep dive](https://blog.cloudflare.com/r2-sql-deep-dive/), [R2 Data Catalog](https://developers.cloudflare.com/r2/data-catalog/), [Pipelines](https://developers.cloudflare.com/pipelines/))
- **Tail Workers**: out-of-band, billed by CPU time (not request count), Workers Paid/Enterprise. ([docs](https://developers.cloudflare.com/workers/observability/logs/tail-workers/))
- **R2 trap**: one PUT per log line = Class A op explosion + millions of tiny query-hostile objects. Must batch — Pipelines does this; never hand-roll a buffer in a DO (mutable instance state dies on eviction).

## Reference artifacts

**Envelope → AE mapping** (zero call-site change; `timestamp` dropped — AE auto-stamps; `type` dropped — constant):
```js
env.DEBUG_AE.writeDataPoint({
  indexes: [namespace.slice(0, 96)],                              // sampling key
  blobs:   [level, namespace, message, JSON.stringify(data ?? null)], // blob1..4
  doubles: [],
});
```

**Nightly "high error counts" query (AE)** — note `SUM(_sample_interval)`, not `count()`:
```sql
SELECT blob2 AS namespace, blob1 AS level, SUM(_sample_interval) AS approx_count
FROM debug_events
WHERE timestamp > NOW() - INTERVAL '1' DAY AND blob1 IN ('warn','error')
GROUP BY namespace, level
HAVING approx_count > 100
ORDER BY approx_count DESC
```

**Same, over R2 (R2 SQL / DuckDB)** — keeps nested `data` queryable:
```sql
SELECT namespace, level, data.errorCode, count(*) AS n
FROM debug_events
WHERE timestamp > NOW() - INTERVAL '1' DAY AND level IN ('warn','error')
GROUP BY namespace, level, data.errorCode
HAVING n > 100 ORDER BY n DESC
```

## Phased path (recommendation)

- **Now:** nothing to build. Error spikes are Workers Issues' list, read by API, as `live.md` already has a deployed pass do.
- **When a warn-level or product-rate trend is wanted within a week's window:** turn Workers Logs on and query its calculations view through the API. Still no Tail Worker and no store.
- **When retention past Workers Logs, or `data`-field querying at volume, actually bites:** stand up Tail Worker → Pipelines → R2 (Iceberg), query with R2 SQL/DuckDB. Add AE counters from the same Tail Worker if cheap real-time dashboards are wanted.
- **Then:** the nightly digest cron (see `nebula-nightly-loop` for the loop harness this would feed), reading Issues for errors and this task's store for the rest.

## Open design decisions (when picked up)
- **AE level threshold independent of `DEBUG`**: AE/R2 should capture `warn`+ regardless of the console `DEBUG` filter (else turning `DEBUG` off silently blinds alerting; `error()` already always outputs).
- **250-points/invocation AE cap**: a chatty request could exceed it — guard/counter so writes degrade gracefully. (Less relevant via Tail Worker batching, but note it.)
- **Tail Worker sampling**: at very high log volume, sample in the Tail Worker rather than forwarding everything.
- **Iceberg schema for `data: any`**: how much schema to declare vs. land as a JSON column + extract on read. DuckDB/R2 SQL JSON-path keeps it flexible; Iceberg wants *some* schema.
- **One dataset vs per-namespace**: partitioning strategy for R2 SQL scan cost.

- **Consider rates, not events, as the first numbers (2026-09-06, from the crash-only discussion).** Every turn failure is loud one at a time now — the stop reason rides the reply, and a red scenario keeps its output. What has no home until this lands is the aggregate the article says is the only thing that catches a regression: turns per day by stop reason (`complete`, `max-depth`, `build-unavailable`, `error`), turn restarts once leases exist, dist-arrival misses, container-step failures. Four counters off markers that already exist; consider emitting them first. Since 2026-10-13, Workers Logs' calculations view could count them within its window before any store exists.

## The transport task
[debug-production-transport.md](../icebox/debug-production-transport.md), the in-process `addDebugTransport(fn)` push API, is iceboxed: Workers Issues reading our JSON lines is the production sink we need for now (Larry, 2026-10-13). If both ever revive, the June split still holds: AE and R2 destinations go through the Tail Worker, and an in-process transport is for synchronous error forwarders only.

## Out of scope
- Changing `@lumenize/debug`'s default `console.debug` output. It is the harvest point, and its JSON line is what Workers Issues and the `/live` harness read.
- Error-level alerting, which Workers Issues does (§ *What Workers Issues covers*).
- Replacing Workers Logs for human investigation (keep it).
- The nightly digest/alerting logic itself (lives in `nebula-nightly-loop`).

## Pickup signal
A trend Workers Issues cannot answer is wanted again and again — warn-level spikes, or product rates such as turns per day by stop reason — and Workers Logs' query API over its 7-day window is not enough, either for retention or for a `data`-field query (`GROUP BY errorCode`) at volume. Spiking errors alone are no longer a signal: Issues answers them.
