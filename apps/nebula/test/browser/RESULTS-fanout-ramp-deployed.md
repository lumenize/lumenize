# Fanout Bench — Phase 3 (N-subscriber ramp, Lumenize Gateway 1:1, deployed)

- **baseUrl**: `https://nebula-browser-test.transformation.workers.dev`
- **galaxy scope**: `acme-c76fbfc9.app`
- **clients pre-created**: 1001 (1 originator + 1000 subscribers)
- **N values**: 1000
- **commits per N**: 5
- **bench source**: [fanout.benchmark.ts](fanout.benchmark.ts) · [harness-client.ts](harness-client.ts)

## Latency vs N

| N | commits | errors | commit p50 (ms) | e2e p50 (ms) | e2e p99 (ms) | e2e max (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 | 5 | 16 | 566.90 | 2051.17 | 5702.09 | 20794.95 |

`commit p50` = `t_after_commit − t_before_commit` median across commits — the originator's transaction round-trip time, independent of the fanout shape downstream. Useful for separating "what the originator pays" from "what the fanout costs."

`e2e` = `t_arrived − t_before_commit` per subscriber per commit — wall-clock from "originator called `transaction()`" to "subscriber's `handleResourceUpdate` fired." `p50` is the median subscriber's wait; `p99` is the 99th-percentile subscriber's wait; `max` is the worst observed subscriber across all commits at this N.

`errors > 0` means at least one subscriber didn't receive the push within `FANOUT_TIMEOUT_MS`.

Raw per-subscriber arrival data + the full Stats (mean, p50, p75, p95, p99, min, max) for span / per-subscriber-latency / end-to-end are in [fanout-ramp-raw-deployed.json](fanout-ramp-raw-deployed.json).
