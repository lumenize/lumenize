# Fanout Bench — Phase 1 (single-subscriber baseline, deployed)

- **baseUrl**: `https://nebula-browser-test.transformation.workers.dev`
- **galaxy scope**: `acme-e63b7e8c.app` (unique per run)
- **star**: `acme-e63b7e8c.app.tenant-fanout`
- **M**: 2 clients (1 originator + 1 subscriber)
- **iterations**: 3
- **bench source**: [fanout.benchmark.ts](fanout.benchmark.ts) · [harness-client.ts](harness-client.ts)

## Latency

| Metric | mean | p50 | p75 | p95 | p99 | min | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| commit duration (originator) | 51.82 | 52.37 | 53.56 | 53.56 | 53.56 | 49.53 | 53.56 |
| commit-to-arrival Δ | 0.16 | 0.22 | 0.38 | 0.38 | 0.38 | -0.12 | 0.38 |
| end-to-end (commit→see) | 51.98 | 52.75 | 53.77 | 53.77 | 53.77 | 49.42 | 53.77 |

All values in milliseconds.

**commit duration** is how long the originator's `client.resources.transaction()` took to resolve — proxy for client↔Star↔client round trip plus parse-validate work.

**commit-to-arrival Δ** is `t_arrived − t_after_commit`. Negative values are normal: the subscriber's same-DC fanout one-way is often shorter than the originator's full round trip, so the subscriber learns of the change before the originator gets confirmation.

**end-to-end** is `t_arrived − t_before_commit` — the wall-clock latency from "user pressed submit" to "other tab updated."

## How to re-run

```
cd apps/nebula && npm run bench:fanout
```

Deployed:
```
cd apps/nebula && BENCH_BASE_URL=https://nebula-browser-test.transformation.workers.dev npm run bench:fanout
```
