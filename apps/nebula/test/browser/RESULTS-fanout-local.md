# Fanout Bench — Phase 1 (single-subscriber baseline, local)

- **baseUrl**: `https://127.0.0.1:56777`
- **galaxy scope**: `acme-067e523f.app` (unique per run)
- **star**: `acme-067e523f.app.tenant-fanout`
- **M**: 2 clients (1 originator + 1 subscriber)
- **iterations**: 3
- **bench source**: [fanout.benchmark.ts](fanout.benchmark.ts) · [harness-client.ts](harness-client.ts)

## Latency

| Metric | mean | p50 | p75 | p95 | p99 | min | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| commit duration (originator) | 1.06 | 1.05 | 1.12 | 1.12 | 1.12 | 1.00 | 1.12 |
| commit-to-arrival Δ | -0.06 | -0.06 | -0.06 | -0.06 | -0.06 | -0.06 | -0.06 |
| end-to-end (commit→see) | 0.99 | 0.99 | 1.06 | 1.06 | 1.06 | 0.93 | 1.06 |

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
