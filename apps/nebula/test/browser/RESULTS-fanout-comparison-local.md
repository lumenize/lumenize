# Fanout Bench — Two-Pattern Comparison (LOCAL wrangler dev)

Side-by-side ramp data for the two patterns under test. **Local-only — these
are wrangler-dev numbers, not production CF.** Real-cloud measurements wait
on a deploy of the bench worker.

- **bench source**: [fanout.benchmark.ts](fanout.benchmark.ts) (Lumenize side)
  · [fanout-agents.benchmark.ts](fanout-agents.benchmark.ts) (Agents side)
- **scenario A — Cloudflare Agents naive broadcast**: `AgentClient.setState(...)`
  → server `_setStateInternal` → partyserver
  `for (conn of getConnections()) conn.send(msg)`. State + WebSockets live on
  the same `BenchAgent` DO.
- **scenario B — Lumenize Resources transaction**: `client.resources.transaction(...)`
  → `Star.transaction` → `Star.#fanout` synchronous loop dispatching
  `lmz.call(NEBULA_CLIENT_GATEWAY, clientId, handleResourceUpdate(...))` per
  subscriber → per-client Gateway DO → WS push to client.

## Side-by-side latency vs N

| N | A — Agents span p50 | B — Lumenize span p50 | A — Agents e2e p50 | B — Lumenize e2e p50 | A errors | B errors |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 0.09 | 0.43 | 9.62 | 1.57 | 0 | 0 |
| 50 | 0.43 | 2.39 | 6.84 | 4.71 | 0 | 0 |
| 100 | 2.08 | 3.82 | 7.65 | 9.94 | 0 | 0 |
| 250 | 4.63 | 9.26 | 5.74 | 20.07 | 0 | 0 |
| 500 | 8.44 | 22.16 | 20.61 | 42.15 | 0 | 0 |
| 1000 | 15.06 | 37.74 | 15.03 | 89.91 | 0 | 0 |

All values in milliseconds. `span` = max(t_arrived) − min(t_arrived) across
subscribers for one broadcast. `e2e` = max(t_arrived) − t_originator_trigger.

## Initial observations

**Both patterns scale linearly with N — no hard caps in the 1..1000 range
on local wrangler.** The Discord folklore "6-1000 fanout limit" doesn't
materialize as a wall in either pattern locally. Zero delivery errors at
N=1000 for both.

**Agents has a lower per-iteration cost** (`ws.send` is microseconds; even
naive scaling at N=1000 spans only 15 ms). Lumenize's per-iter cost is
~36 μs locally — slower than `ws.send` but still microseconds. The factor
~2× gap (Lumenize 37 ms vs Agents 15 ms at N=1000) reflects Workers RPC
dispatch overhead inside Star vs. the cheap `ws.send` call inside the
Agent DO. This gap **will widen on real CF**, where each Lumenize `lmz.call`
becomes a real cross-DO Workers RPC (~8 ms same-DC RT per call) whereas
Agents `ws.send` stays a buffer write.

**End-to-end shape diverges between the patterns:**
- Agents `setState` is fire-and-forget WS-message from the client's POV;
  e2e measures `originator-WS-send → server-receive → state-persist →
  broadcast → subscriber-receive`. Even at small N, that's >5 ms because of
  the state-persistence step on the Agent DO (synchronous DB write before
  broadcast).
- Lumenize `transaction()` is request/response; the originator awaits a
  result. But Star's `#fanout` dispatches DURING the transaction commit, so
  subscribers see the update mid-round-trip — often arriving BEFORE the
  originator gets its confirmation. At N=10 this shows up as e2e p50 1.57 ms
  (faster than a single same-DC round trip).

**Crossover point**: somewhere between N=100 and N=500. At N=100 Lumenize
e2e (9.94 ms) is comparable to Agents (7.65 ms); by N=500 Agents has pulled
ahead (20.61 vs 42.15); by N=1000 Agents is ~6× faster (15 vs 90 ms).
This is the local picture — production CF likely shifts the crossover left
because Lumenize's per-iter Workers RPC cost grows from ~36 μs to ~8 ms.

## Caveats

- **All measurements on local wrangler-dev.** Workers RPC is in-process here;
  on real CF it's a network hop (~8 ms same-DC, ~100 ms cross-region per
  gateway-hop-benchmark). Expect Lumenize numbers to grow substantially when
  re-run against the deployed worker. Agents in-DO `ws.send` shouldn't
  change much — it's local-buffer-write either way.
- The bench worker needs re-deploy before the deployed run can happen:
  `npx wrangler deploy --config apps/nebula/test/browser/worker/wrangler.jsonc`
  (the worker now includes the `BenchAgent` DO + a migration entry adding it).
- Star's `#fanout` is the system-under-test on the Lumenize side; its
  current pattern (4-arg `lmz.call` with `onFanoutDelivered` continuation) is
  unchanged for this bench — see [star.ts](../../src/star.ts) `#fanout`.

## How to re-run (local)

```
cd apps/nebula
FANOUT_N_VALUES=10,50,100,250,500,1000 npm run bench:fanout
FANOUT_N_VALUES=10,50,100,250,500,1000 npm run bench:fanout:agents
```

Then merge the two `RESULTS-fanout-ramp-local.md` and
`RESULTS-fanout-agents-local.md` into this file.

## How to re-run (deployed)

Redeploy first:

```
cd apps/nebula && npx wrangler deploy --config test/browser/worker/wrangler.jsonc
```

Then:

```
BENCH_BASE_URL=https://nebula-browser-test.transformation.workers.dev \
  FANOUT_N_VALUES=10,50,100,250,500,1000 \
  npm run bench:fanout
BENCH_BASE_URL=https://nebula-browser-test.transformation.workers.dev \
  FANOUT_N_VALUES=10,50,100,250,500,1000 \
  npm run bench:fanout:agents
```

Deployed results will land in `RESULTS-fanout-ramp-deployed.md` and
`RESULTS-fanout-agents-deployed.md`.
