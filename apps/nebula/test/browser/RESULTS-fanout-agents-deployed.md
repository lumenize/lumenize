# Fanout Bench — Cloudflare Agents naive-broadcast (deployed)

- **baseUrl**: `https://nebula-browser-test.transformation.workers.dev`
- **agent class**: `BenchAgent` (extends `agents/Agent`, naive partyserver `broadcast` loop)
- **instance**: `bench-f2e66f3a` (all M=1001 clients share one DO)
- **N values**: 10, 50, 100, 250, 500, 1000
- **commits per N**: 3
- **bench source**: [fanout-agents.benchmark.ts](fanout-agents.benchmark.ts) · [agents-harness-client.ts](agents-harness-client.ts)

## Latency vs N

| N | commits | errors | e2e p50 (ms) | e2e p99 (ms) | e2e max (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 3 | 0 | 181.69 | 214.36 | 214.36 |
| 50 | 3 | 0 | 167.50 | 493.01 | 493.90 |
| 100 | 3 | 0 | 137.18 | 175.84 | 229.41 |
| 250 | 3 | 0 | 158.17 | 180.52 | 181.55 |
| 500 | 3 | 0 | 144.37 | 153.69 | 274.21 |
| 1000 | 3 | 0 | 147.56 | 290.81 | 429.46 |

`e2e` = `t_arrived − t_before_trigger` per subscriber per commit — wall-clock from "originator called `setState`" to "subscriber's `onStateUpdate` fired." `p50` is the median subscriber's wait; `p99` is the 99th-percentile subscriber's wait; `max` is the worst observed subscriber across all commits at this N.

`errors > 0` means at least one subscriber didn't receive the state update within `FANOUT_TIMEOUT_MS`.

Raw per-subscriber arrival data + full Stats (mean, p50, p75, p95, p99, min, max) for span / per-subscriber-latency / end-to-end are in [fanout-agents-raw-deployed.json](fanout-agents-raw-deployed.json).
