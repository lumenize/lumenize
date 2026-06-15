# Fanout Bench — Cloudflare Agents naive-broadcast (local)

- **baseUrl**: `https://127.0.0.1:51329`
- **agent class**: `BenchAgent` (extends `agents/Agent`, naive partyserver `broadcast` loop)
- **instance**: `bench-2c38b6e8` (all M=1001 clients share one DO)
- **N values**: 500, 1000
- **commits per N**: 3
- **bench source**: [fanout-agents.benchmark.ts](fanout-agents.benchmark.ts) · [agents-harness-client.ts](agents-harness-client.ts)

## Latency vs N

| N | commits | errors | span (mean / p50 / p99) | per-subscriber latency (mean / p50 / p99) | end-to-end (mean / p50 / p99) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 500 | 3 | 0 | 8.44 / 8.44 / 9.02 ms | 27.19 / 20.54 / 46.86 ms | 27.31 / 20.61 / 47.09 ms |
| 1000 | 3 | 0 | 14.95 / 15.06 / 15.52 ms | 13.69 / 14.98 / 19.49 ms | 13.74 / 15.03 / 19.55 ms |

All values in milliseconds.

`span` is `max(t_arrived) − min(t_arrived)` within a single state-update broadcast — how stretched partyserver's `for (conn of getConnections()) conn.send(msg)` loop was.

`per-subscriber latency` is `t_arrived − t_after_trigger` (originator's `setState` call returned at `t_after_trigger`; the actual server-side broadcast happens asynchronously after the originator's WS message lands).

`end-to-end` is `t_arrived − t_before_trigger` — wall-clock from "originator called setState" to "subscriber's onStateUpdate fired."
