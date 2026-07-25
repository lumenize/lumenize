<!-- measured-at-commit: aff3347b736397313d7b5ec9142b4d7da8f05f50 -->
> Measured at commit `aff3347b736397313d7b5ec9142b4d7da8f05f50` ⚠️ dirty tree — not reproducible.

# Fanout Bench — Cloudflare Agents naive-broadcast (local)

- **baseUrl**: `https://127.0.0.1:49346`
- **agent class**: `BenchAgent` (extends `agents/Agent`, naive partyserver `broadcast` loop)
- **instance**: `bench-acea8dae` (all M=101 clients share one DO)
- **N values**: 10, 50, 100
- **commits per N**: 5
- **bench source**: [fanout-agents.benchmark.ts](fanout-agents.benchmark.ts) · [agents-harness-client.ts](agents-harness-client.ts)

## Latency vs N

| N | commits | errors | e2e p50 (ms) | e2e p99 (ms) | e2e max (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 5 | 0 | 3.56 | 4.67 | 4.67 |
| 50 | 5 | 0 | 3.05 | 3.68 | 3.69 |
| 100 | 5 | 0 | 2.55 | 3.96 | 3.98 |

`e2e` = `t_arrived − t_before_trigger` per subscriber per commit — wall-clock from "originator called `setState`" to "subscriber's `onStateUpdate` fired." `p50` is the median subscriber's wait; `p99` is the 99th-percentile subscriber's wait; `max` is the worst observed subscriber across all commits at this N.

`errors > 0` means at least one subscriber didn't receive the state update within `FANOUT_TIMEOUT_MS`.

Raw per-subscriber arrival data + full Stats (mean, p50, p75, p95, p99, min, max) for span / per-subscriber-latency / end-to-end are in [fanout-agents-raw-local.json](fanout-agents-raw-local.json).
