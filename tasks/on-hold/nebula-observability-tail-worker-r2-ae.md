# Queryable observability: Tail Worker → R2 (and/or Analytics Engine)

**Status**: On hold — thinking captured (2026-06-14), not started. Speculative until we're running enough volume that "nightly check for high counts of common errors" is a real need (not there yet).
**Packages**: none changed by the core decision — `@lumenize/debug` stays as-is. New work lands in a Tail Worker (likely `apps/nebula/` or a small dedicated package) + Cloudflare Pipelines/R2 config.
**Related**:
- [tasks/icebox/debug-production-transport.md](../icebox/debug-production-transport.md) — the *in-process* transport API (`addDebugTransport`). **This task is the out-of-band alternative and partly tensions with it — see "Relationship to the transport task" below.**
- [tasks/nebula-tenant-ai-billing.md](../nebula-tenant-ai-billing.md) — already plans a **Tail Worker** for cpuTime/wallTime keyed by `durableObjectId`. Same Tail Worker should be the single egress point for *all* telemetry, including these logs.
- [tasks/on-hold/nebula-resource-history-r2.md](./nebula-resource-history-r2.md) — separate R2 use (resource history); don't conflate the buckets/datasets.
**Relevant code**:
- [packages/debug/src/logger.ts](../../packages/debug/src/logger.ts) — `defaultOutput` = `console.debug(JSON.stringify(log, ...))` (`:46`). This is the harvest point; **nothing here changes**.
- [packages/debug/src/types.ts](../../packages/debug/src/types.ts) — `DebugLogOutput` shape: `{ type:'debug', level, namespace, message, timestamp, data? }`.

## Goal

Make `@lumenize/debug` output **queryable** for automated alerting ("nightly: which namespaces are spiking warn/error?") **without** adding latency to the logging hot path and **without** baking a storage binding into the package. The motivating use case: wake up to a digest of "3,000 of X failed last night," computed by a cron over real telemetry — not discovered by a customer.

## Settled thinking (do not re-litigate)

### 1. Two complementary destinations, not one
- **console → Workers Logs** — full fidelity incl. nested `data`, what a human reads when investigating, auto-extracts/indexes JSON fields, but **no public query API** (dashboard Query Builder only, beta) and **3-day (free) / 7-day (paid) retention**. Keep this; it's already free and zero-effort.
- **a queryable store (R2 and/or Analytics Engine)** — for *programmatic* nightly aggregation. This is the new piece.

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

- **Now (low volume):** do nothing beyond console → Workers Logs. If a single queryable target is wanted with least friction, AE *could* be wired — but prefer to wait for the Tail Worker so we never put a binding in the package.
- **When `data`-field querying or >90-day retention actually bites:** stand up Tail Worker → Pipelines → R2 (Iceberg), query with R2 SQL/DuckDB. Add AE counters from the same Tail Worker if cheap real-time dashboards are wanted.
- **Then:** the nightly digest cron (see `nebula-nightly-loop` for the loop harness this would feed).

## Open design decisions (when picked up)
- **AE level threshold independent of `DEBUG`**: AE/R2 should capture `warn`+ regardless of the console `DEBUG` filter (else turning `DEBUG` off silently blinds alerting; `error()` already always outputs).
- **250-points/invocation AE cap**: a chatty request could exceed it — guard/counter so writes degrade gracefully. (Less relevant via Tail Worker batching, but note it.)
- **Tail Worker sampling**: at very high log volume, sample in the Tail Worker rather than forwarding everything.
- **Iceberg schema for `data: any`**: how much schema to declare vs. land as a JSON column + extract on read. DuckDB/R2 SQL JSON-path keeps it flexible; Iceberg wants *some* schema.
- **One dataset vs per-namespace**: partitioning strategy for R2 SQL scan cost.

## Relationship to the transport task (reconcile when either is picked up)
[debug-production-transport.md](../icebox/debug-production-transport.md) proposes an **in-process** `addDebugTransport(fn)` push API. This task proposes **out-of-band** harvest via Tail Worker. They are complementary, not redundant:
- **In-process transport** fits low-latency, fire-once forwarders where you want the entry *as it happens* (e.g. Sentry error capture) and are willing to pay the in-isolate cost.
- **Tail Worker harvest** fits high-volume, queryable, batched analytics (R2/AE) where hot-path latency and per-call-site bindings are unacceptable.
- **Decision to make later:** for AE/R2 specifically, prefer the Tail Worker (this task) over an in-process transport — so if both ship, document that AE/R2 destinations go through the Tail Worker, and `addDebugTransport` is for synchronous error forwarders, not bulk analytics.

## Out of scope
- Changing `@lumenize/debug`'s default `console.debug` output (it's the harvest point — leave it).
- Replacing Workers Logs for human investigation (keep it).
- The nightly digest/alerting logic itself (lives in `nebula-nightly-loop`).

## Pickup signal
We're running enough production volume that "I want a nightly query for spiking errors across all DOs" is a real, recurring need — or a `data`-field query (`GROUP BY errorCode`) is wanted that Workers Logs' 7-day window + dashboard-only Query Builder can't serve.
