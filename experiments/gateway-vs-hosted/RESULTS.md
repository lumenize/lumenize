# gateway-vs-hosted: a DO holding its clients' sockets vs a Gateway per client (deployed)

**Question.** This is Phase 5b of `tasks/archive/gateway-hop-benchmark.md`, which was skipped in
May. Is a Durable Object that holds its clients' sockets itself faster or slower than one reached
through mesh's `LumenizeClientGateway`, one Gateway per client? The +14% in
`website/docs/mesh/gateway.mdx` compared many Gateways with one shared Gateway, so it never
answered this. The answer bears on `tasks/nebula-pre-alpha.md` § *Open decisions*, item 4.

**Method.** `experiment-gateway-vs-hosted`, deployed 2026-10-04 and driven from one Node process
in Pittsburgh (IAD colo).

- **One target class in both arms.** `BenchDO` (`src/bench-do.ts`), a fresh instance per step.
- **Arm `gateway`** is mesh as it ships. Each client connects to its own `LumenizeClientGateway`.
  A call goes client → Gateway → `BenchDO.__executeOperation`, which acks early, runs the chain
  and fires the result back to the Gateway's `__handleResponse`, which writes it to the socket.
- **Arm `hosted`.** Each client connects to `BenchDO` itself, which runs the steps
  `executeEnvelope` runs (decode the chain, stamp `callee`, run `onBeforeCall`, then
  `executeOperationChain` with the `@mesh()` check on) and answers with `ws.send`.
- **Same client, same wire.** One unmodified `LumenizeClient` drives both arms; only its
  `gatewayBindingName` and `baseUrl` differ.
- **Three workloads.** `echo` does no storage. `write` inserts one SQL row. `heavy` adds about
  2 ms of CPU to that row (calibrated on the driver's machine), standing in for a Star
  transaction's own work.
- **A fidelity check opens every run.** Both arms must refuse a method without `@mesh()`, which
  shows the hosted arm runs the Gateway target's entry check rather than calling methods bare.
  Both refused, in every run.
- **Two rounds, alternating which arm goes first.**

**Faithfulness notes.**

- **Arm `gateway` is today's Gateway.** It answers a push only after its client does, so the
  broadcaster's RPC stays open for the client's round trip. `tasks/mesh-calls-to-and-from-clients.md`
  D11 makes it ack at once. That may shorten the publisher's own wait in the broadcast table, but
  each subscriber still costs the broadcaster one RPC.
- **Arm `hosted` models D11 on the hosting side.** It keeps one pending entry and one 30 s timer
  per push until the client answers.
- **The prototype host answers only calls addressed to itself.** Traffic that passes through a
  scope's node on its way somewhere else, such as a `Profile` read or the auth facade, is not
  measured.
- **Client-side work is in both arms.** Parsing up to 1,001 sockets' messages in one Node
  process adds the same cost to each.
- **Mesh internals by relative path.** `runWithCallContext`, `executeOperationChain` and the
  heartbeat constants are not exported, so `bench-do.ts` imports them from `packages/mesh/src`.
  The bundle carries one copy of each (checked with `wrangler deploy --dry-run`), so the hosted
  arm shares mesh's call-context store.

## Results (2026-10-04, two rounds, written r0 / r1)

### Single-call latency: one client, one call at a time, p50 in ms

| workload | gateway | hosted | hosted saves |
|---|---:|---:|---:|
| echo | 34.7 / 31.2 | 25.9 / 24.6 | 7–9 |
| write | 52.6 / 43.6 | 34.3 / 32.3 | 11–18 |

That matches the ~12 ms hop the May benchmark measured.

### Throughput: calls per second, one call in flight per client

| workload | clients | gateway | hosted | hosted ÷ gateway |
|---|---:|---:|---:|---:|
| echo | 16 | 417 / 397 | 739 / 754 | 1.8–1.9× |
| echo | 64 | 830 / 836 | 1,761 / 1,617 | 1.9–2.1× |
| echo | 256 | 552 / 1,051 | 2,479 / 2,579 | 2.5–4.5× |
| write | 16 | 225 / 297 | 411 / 506 | 1.7–1.8× |
| write | 64 | 750 / 691 | 1,364 / 1,364 | 1.8–2.0× |
| write | 256 | 939 / 724 | 2,148 / 1,915 | 2.3–2.6× |

- **At 256 clients both objects are saturated.** p50 call latency rises to about 100–130 ms in
  the hosted arm and 220–400 ms in the gateway arm. So 256 is the ceiling, while at 16 clients
  both arms are bound by round trip and the ratio mostly restates the latency table.
- **Only the gateway arm failed calls**: 6 and 7 at echo/256, 1 at echo/64. They were rejected
  `callAsync` calls, and their cause was not inspected. The hosted arm failed none.

### Broadcast: one publisher, N subscribers, ms from `publish` to delivery

Each cell is the median, over 5 publishes, of that publish's p50 (or p99) across subscribers.

| N | gateway p50 | hosted p50 | gateway p99 | hosted p99 |
|---:|---:|---:|---:|---:|
| 10 | 48 / 44 | 23 / 30 | 59 / 57 | 23 / 30 |
| 100 | 150 / 148 | 37 / 33 | 275 / 246 | 42 / 44 |
| 250 | 402 / 369 | 55 / 56 | 720 / 661 | 65 / 62 |
| 500 | 741 / 591 | 85 / 83 | 1,317 / 1,016 | 105 / 90 |
| 1,000 | 1,242 / 1,088 | 113 / 93 | 2,072 / 1,849 | 138 / 102 |

- **Each extra subscriber costs about 1.1 ms through Gateways and about 0.08 ms hosted.** Read
  off the p50 column from N = 10 to N = 1,000.
- **The writer waits too.** The publisher's own `publish` call came back in about 1.8–2.1 s at
  N = 1,000 through Gateways, and in 100–140 ms hosted.
- **Only the gateway arm missed a delivery.** In round 0 one subscriber missed one publish within
  30 s, once at N = 250 and once at N = 1,000. The hosted arm delivered every push.

### The `heavy` workload: its CPU cost was not stable, and a slow hosting object went down

`heavy` was meant to show the ratio at a Star transaction's weight. Cloudflare's tail (sampled)
shows each call took **3–4 ms** of CPU on some object instances and **about 30 ms** on others
(p50 29, max 43, from one captured slow run), for the same code. A fresh object landed in either
state, in either arm, with no pattern found. These are throughput steps, in calls/s:

| state | arm | clients: steps |
|---|---|---|
| fast | gateway | 16: 170, 147 · 64: 262, 255 · 256: 247 |
| fast | hosted | 16: 212, 221, 155 · 64: 285, 292 · 256: 342, 205 |
| slow | gateway | 16: 29, 28, 30 · 64: 30 · 256: 31, 34 (one call lost across the six) |
| slow | hosted | 16: 18, 16, 19, 17, 17, 18, 15 · 64: 13 · 256: 0 (every in-flight call lost, every step) |

- **In the fast state the call's own CPU sets the ceiling, in both arms.** At 64 and 256 clients
  both arms land between about 200 and 340 calls/s, which is one core spent at 3–4 ms a call.
  The transport is too small a share of a call this heavy to show through the run-to-run noise.
- **In the slow state the hosting object went down, every time.** It ran about 30 calls/s, a full
  core at 30 ms each. Then, 10–14 s in, every socket on it closed and every in-flight call was
  lost. That happened in 9 of 9 slow hosted steps (socket drops were counted in 7 of them, and
  the earlier two lost every call). Behind Gateways, the same slow state lost one call in six
  steps: the object slowed down and kept running.
- **It is not saturation alone.** The hosted object also ran at or near a full core in its fast
  steps at 64 and 256 clients, 4 of 4, and lost nothing. What the slow steps add is 30 ms events back to back.
- **It is not the per-request CPU limit.** With `limits.cpu_ms` raised from its 30 s default to
  the 5-minute maximum, 2 of 3 hosted runs still went down the same way. The sampled tail shows
  the object stop processing, with no exception or CPU-limit outcome recorded for it.

## What this settles

- **Holding the sockets does not cost throughput.** For light calls it raised the ceiling
  1.7–2.6× and cut single-call latency by the hop. Phase 5b existed to test whether hosting could
  lower the ceiling, and it did not.
- **At a Star transaction's weight the ceiling barely moves.** With a call costing 3–4 ms of CPU,
  both arms hit the same ceiling, set by the call's own work. The May benchmark's Star peak, about
  345 transactions/s through Gateways, fits that same per-call cost.
- **Broadcast is where hosting changes the most.** It was about 10× faster at 1,000 subscribers,
  at about a tenth of the per-subscriber cost.
- **A reset is a real cost, with a trigger we can produce.** A hosting object running 30 ms
  events back to back closed every client's socket within seconds, and the same object behind
  Gateways only slowed down. `experiments/do-socket-drop-probe/RESULTS.md` found why: the
  runtime resets an object that keeps running JavaScript in a slow state some instances are born
  in. It resets the object behind Gateways too; its callers just rarely notice.

## Not settled here

- **Why the hosting object went down, and why the same loop cost 10× more on some instances.**
  Answered in `experiments/do-socket-drop-probe/RESULTS.md`, which carries what is still open.
- **Load that passes through the hosting node.** A Star would also forward its tabs' `Profile`
  and auth-facade traffic. The prototype forwards nothing.
- **What a reset costs.** When a hosting object resets on its own, every socket on it drops.
- **ADR-018's write ceiling.** Both arms sustained more writing calls per second than ADR-018's
  ~410 rps all-writes figure. The request shape behind that figure differs from this one in ways
  this experiment did not isolate, so re-measure before quoting either number for a hosted Star.
- **Connections per object.** Cloudflare's limits page names no cap on WebSocket connections per
  object, and its WebSocket page says one object can "connect thousands of clients per instance"
  (both read 2026-10-04). This experiment went no higher than 1,001 sockets on one object.

## Rerun

```sh
cd experiments/gateway-vs-hosted
npx wrangler deploy
openssl rand -hex 16 | tee /tmp/bench-token | npx wrangler secret put BENCH_TOKEN
BENCH_BASE_URL=https://experiment-gateway-vs-hosted.<account>.workers.dev \
  BENCH_TOKEN=$(cat /tmp/bench-token) npx tsx scripts/drive.ts all
# the heavy steps: WORKLOADS=heavy, then `throughput`; ARMS=hosted to repeat only that arm
```

Raw numbers are in `results/`, one file per invocation, in run order (2026-10-04, UTC):

| file | what it holds |
|---|---|
| `raw-deployed-…T18-19-25…` | `all`: latency, throughput and broadcast for `echo` and `write`, two rounds |
| `raw-deployed-…T18-22-27…` | `heavy` latency, two rounds (instance speed varied, so it is not tabled) |
| `raw-deployed-…T18-28-48…` | `heavy` throughput at 16/64/256 clients, two rounds |
| `raw-deployed-…T18-32-32…` | `heavy` throughput at 64/256, with `wrangler tail` running |
| `raw-deployed-…T18-36-46…` | `heavy` throughput at 16, three rounds |
| `raw-deployed-…T18-38-51…` | hosted `heavy` at 16, two rounds, with `wrangler tail` running |
| `raw-deployed-…T18-41-43…` | the same, three rounds, with `limits.cpu_ms` at 300000 |

The tail captures are not committed: they hold the upgrade requests' headers, bench token
included. Delete the Worker from the dashboard when done, which also removes its Durable Object
namespaces.
