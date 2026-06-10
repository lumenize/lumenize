---
title: "How big can a Durable Object's WebSocket fanout get?"
slug: scaling-durable-object-broadcast
authors:
  - larry
tags:
  - architecture
  - cloudflare
  - durable-objects
  - benchmarking
description: A 1,000-subscriber head-to-head between Cloudflare Agents naive broadcast and Lumenize. The "6-to-1000 fanout limit" folklore from the Cloudflare Discord, measured. Includes the framework lift — svc.broadcast — that closes most of the gap.
draft: true
---
If you hang out on the Cloudflare Discord, you've probably seen the question come up every few weeks: *"how many WebSocket clients can a single Durable Object actually push to?"* The answers I've seen range from "six" to "a thousand", which is suspicious. So I measured.

The short version: naive broadcast on a single DO scales further than the lower end of folklore suggests, but a different shape — the one already implied by Lumenize's [Gateway pattern](/docs/mesh/gateway) — handles 1,000-subscriber fanout with a flatter tail than a one-DO loop ever can.

<!-- truncate -->

## TL;DR

End-to-end median wait for a subscriber to receive a push, at N=1,000 connected clients on a single tenant, deployed to real Cloudflare (Pittsburgh client → IAD colo):

| Pattern | p50 | p99 | max | shape |
|---|---:|---:|---:|---|
| Cloudflare Agents `setState` (naive partyserver loop) | 148 ms | 291 ms | 429 ms | one DO owns all WS + does the broadcast |
| Lumenize per-Gateway `lmz.call` loop, no batching | 1,746 ms | 4,739 ms | 5,418 ms | one app-DO + N Gateway DOs, app-DO loops N times |
| Lumenize `svc.broadcast` (tier-worker tree, branch=6) | 790 ms | 2,677 ms | 2,702 ms | same shape, but the app-DO hands off to a recursive Worker tier |

Three things to read out of this:

1. **The "6-to-1000 fanout limit" is not a delivery wall**, at least not at N=1,000. Zero errors across all three patterns. The story is tail-latency, not lost messages.
2. **Lumenize's previous broadcast (a flat `lmz.call` loop, one call per subscriber) hit a real tail-latency wall around N≈250.** The cause is well-defined and ordinary: Workers RPC has a ~6 concurrent outbound subrequest cap per binding namespace, so 1,000 calls drain through a 6-wide window and the tail subscribers wait through ~166 queue cycles.
3. **The recursive Worker tier reduces 1,000-way fanout to log₆(1,000) ≈ 4 sequential hops.** That's the new framework primitive `svc.broadcast` in `@lumenize/mesh`. It closes most of the gap to Agents; a residual remains that I'll explain at the end.

## The folklore

The two extremes you see in answers are both real lower-bounds dressed up as ceilings:

- **"6"** is the Workers RPC concurrent outbound subrequest cap per binding. It applies *per node doing the calling* — not to the system as a whole. A loop that fans out from one DO via 1,000 sequential RPCs hits this cap and queues; a tree where each node fans out to 6 children doesn't.
- **"1,000"** is what you can do *if* you fit your fanout into the right shape — typically a single DO that owns N WebSockets and calls `ws.send()` in a loop. `ws.send()` writes to a kernel buffer; it's not an outbound subrequest. So it doesn't see the 6-cap and you can spray a thousand `ws.send` calls in a tight loop with no queueing tax.

Different cost models. The question "how big can a fanout get?" isn't really one question — it depends on which primitive you're using and which boundary your fanout has to cross.

## The setup

All three patterns measure the same user-facing flow: an originator commits a change, every subscriber receives a push, we measure wall-clock from "originator called the write API" to "subscriber's handler fired." Pittsburgh-driven Node test client; deployed Worker in IAD. Bench source: [`fanout.benchmark.ts`](https://github.com/lumenize/lumenize/blob/main/apps/nebula/test/browser/fanout.benchmark.ts) (Lumenize), [`fanout-agents.benchmark.ts`](https://github.com/lumenize/lumenize/blob/main/apps/nebula/test/browser/fanout-agents.benchmark.ts) (Agents).

Three architectures under test:

- **A — Cloudflare Agents `setState`.** An [Agents](https://github.com/cloudflare/agents) DO holds all N WebSockets in the hibernation API. On a `setState`, partyserver's broadcast loop fires `ws.send()` to every connected socket. One DO end-to-end.
- **B — Lumenize without broadcast.** The [Gateway pattern](/docs/mesh/gateway): the application DO (`Star`) holds business state; each connected client gets its own `GatewayDO` that owns that client's WebSocket and the JWT/auth attached to it. On a write, Star looped over subscribers and dispatched one `lmz.call(GATEWAY, clientId, push)` per subscriber. This is the production code Lumenize shipped before `svc.broadcast`.
- **C — Lumenize with `svc.broadcast`.** Same architecture as B, but Star calls `svc.broadcast(targets, push, opts)` instead of looping. Below an opt-in threshold (default 100), it's the same flat loop. Above the threshold, it hands the target list to a recursive Worker tier that partitions targets into groups of 6 and recurses.

## Naive Agents broadcast scales fine

| N | p50 | p99 | max |
|---:|---:|---:|---:|
| 10 | 182 | 214 | 214 |
| 50 | 168 | 493 | 494 |
| 100 | 137 | 176 | 229 |
| 250 | 158 | 181 | 182 |
| 500 | 144 | 154 | 274 |
| 1,000 | 148 | 291 | 429 |

Roughly flat ~150 ms median across the ramp. This is what `ws.send()` looks like as a primitive: kernel buffer write, no RPC boundary, no queueing tax until you saturate the buffer itself (which we don't, at 1,000).

A few caveats worth noting before reading too much into "Agents wins":

- Agents `setState` is a state-sync broadcast — push the whole state to everyone. It doesn't model per-subscriber permissions, per-target deltas, or auth. The naive loop is the right primitive when every subscriber gets the same bytes.
- The whole architecture lives in one DO. That's *exactly* the shape Cloudflare's Discord audience tends to start with, and it's a fine shape for many workloads — chat rooms, presence, live cursors. The constraints show up when your application can't reasonably collapse everything into one process.

So: Agents sets a floor I'd like to beat but can't quite, with the constraint that I have a different problem to solve.

## Lumenize's 1:1 dispatch hits a tail wall

The same ramp on the pre-broadcast Lumenize code:

| N | p50 | p99 | max |
|---:|---:|---:|---:|
| 10 | 61 | 77 | 77 |
| 50 | 96 | 151 | 153 |
| 100 | 142 | 243 | 293 |
| 250 | 296 | 522 | 581 |
| 500 | 652 | 1,161 | 1,230 |
| 1,000 | 1,746 | 4,739 | 5,418 |

Two distinct regions. Below N≈100 it tracks Agents within run-to-run noise — and is slightly faster at N=10 (61 ms vs 182 ms), which I read as Pittsburgh→IAD's variance plus Gateway's smaller per-message work compared to partyserver's state-diff machinery.

Above N≈250 the tail blows out. The structural cause: every `lmz.call(GATEWAY, clientId, push)` initiates an outbound Workers RPC subrequest from Star's isolate. Workers RPC caps concurrent outbound subrequests per binding to ~6. A 1,000-target loop drains through that 6-wide window, so the last subscribers wait behind ~166 queue cycles. p99 4.7 seconds is exactly the shape you'd expect from "fanout-size / concurrency-cap × per-hop latency."

The naive shape *worked* — zero errors — but the worst-case observation window is unusable for any "user edits a doc, watches the other tab update" experience. So I went looking for the obvious fix.

## Tree fanout, and why it needs the Gateway pattern

If each tier fans out to ≤6 children, no tier node ever queues its own outbound calls. For 1,000 targets at branch=6, that's log₆(1,000) ≈ 4 sequential hops instead of 166. Numerically that's the win.

The architectural point is the part I want to draw out, because it's not obvious until you try to implement it:

> **Tree fanout architecturally requires the Gateway pattern.**

To see why: suppose you tried to tree-fan a single Agents-style DO. The leaves of your tree need to invoke `ws.send()` on a specific WebSocket. But the only DO that *holds* that WebSocket is the parent — there's no Workers RPC method on a remote helper that can reach into your parent DO's hibernated sockets. The leaves have nothing to call. Tree fanout from a single-DO architecture isn't slow, it's not expressible.

The Gateway pattern splits the WebSocket ownership *away from* the application DO. Each client has its own Gateway DO that owns its WebSocket. Now your tier leaves *do* have something to call: `lmz.call(GATEWAY, clientId, push)` — a Workers RPC into the Gateway, which forwards over its WebSocket to the client.

So the same architectural choice that adds a per-message hop at small N (and adds a security DMZ — see the [Gateway docs](/docs/mesh/gateway#implications)) is what makes tree fanout possible at large N. It's not two separate trade-offs, it's the same trade-off pointing in opposite directions at different scales.

## The framework lift: `svc.broadcast`

The tier is now a built-in primitive in `@lumenize/mesh`:

```ts
@mesh()
async transaction(...) {
  for (const [resourceId, snapshot] of mutations) {
    const targets = this.#subscriptions.forResource(resourceId)
      .filter(s => s.clientId !== originator)
      .map(s => ({ bindingName: 'GATEWAY', instanceName: s.clientId }));

    const remote = this.ctn<Client>().handleResourceUpdate(snapshot);

    this.svc.broadcast(targets, remote, {
      onResult: this.ctn<this>().onBroadcastResult(resourceId),
    });
  }
}
```

Below the `directThreshold` (default 100), it's a flat loop on the calling DO — same shape as the naive code. Above it, it dispatches the target list to a recursive Worker tier (you bind one to your app under the convention name `LUMENIZE_BROADCAST_TIER`). Each tier node groups its targets into batches of 6 and recurses; at the leaves it dispatches directly to the targets.

The `onResult` partial continuation is what makes "drop-on-failed-fanout" possible: when a Gateway returns `ClientDisconnectedError`, the framework routes that error back to your `onBroadcastResult` handler on the calling DO, and you can drop the leaked subscriber row. Full docs at [`/docs/mesh/broadcast`](/docs/mesh/broadcast); source at [`packages/mesh/src/broadcast.ts`](https://github.com/lumenize/lumenize/blob/main/packages/mesh/src/broadcast.ts).

## Head-to-head

Same N ramp, all three patterns:

**Median wait (ms)**

| N | A — Agents | B — Lumenize, no batching | C — Lumenize, `svc.broadcast` |
|---:|---:|---:|---:|
| 10 | 182 | 61 | **47** |
| 50 | 168 | **96** | 101 |
| 100 | 137 | 142 | 151 |
| 250 | 158 | **296** | 317 |
| 500 | 144 | 652 | **614** |
| 1,000 | 148 | 1,746 | **790** |

**99th percentile (ms)**

| N | A — Agents | B — Lumenize, no batching | C — Lumenize, `svc.broadcast` |
|---:|---:|---:|---:|
| 10 | 214 | 77 | **58** |
| 50 | 493 | **151** | 153 |
| 100 | 176 | **243** | 254 |
| 250 | 181 | **522** | 590 |
| 500 | 154 | 1,161 | 2,811 |
| 1,000 | 291 | 4,739 | **2,677** |

Bold marks the better of the two Lumenize columns at each row. Agents is shown for orientation — it's a different architecture, not an apples-to-apples comparison cell.

At N=1,000, `svc.broadcast` is roughly 2.2× faster median and 1.8× faster on p99 than the unbatched loop. The unbatched code's worst-case p99 (~4.7 s) is no longer present. The cliff Discord folklore worries about — wherever it actually lives — has moved well above N=1,000.

Below N≈250 the two Lumenize patterns are within run-to-run noise — the tier hop costs roughly what the direct loop's first ~6 cycles would. The crossover is wide enough that the framework default (`directThreshold: 100`) and "always use broadcast" both work; the difference is a couple hundred milliseconds in either direction at the midpoint, and an order-of-magnitude difference at the high end.

## The residual to Agents

At N=1,000, Agents is still ~5× faster on median (148 ms vs 790 ms). That's the headline number I want to be honest about.

Some of that is architectural overhead Lumenize wears by design. Agents does a `ws.send()` loop in one process; Lumenize is Workers RPC across processes. Each cross-DO hop is ~5-12 ms (see [post 2d](/blog/benchmarking-cloudflare-durable-objects-from-outside) for the decomposition). Four tier hops + a Gateway hop ≈ 25-60 ms of hop overhead Agents doesn't pay. But that's not the whole gap.

The bigger structural fact:

**The originator's commit round-trip — `t_after_commit − t_before_commit` measured at the client — grows with N even though Star only makes one outbound Workers RPC.**

At N=100, the originator's commit p50 was ~60 ms. At N=1,000 it was ~570-640 ms. Star calls into the tier exactly once. So what's it paying for?

The hypothesis: `workerd`'s outbound-subrequest lifecycle tracking is *transitive*. When Star calls the tier worker, workerd registers a hold against Star's `IoContext`. The tier worker spawns 6 children; each of those is a subrequest tracked against the tier's `IoContext`. The tier can't be "done" until its children settle, so the response back to Star is held; Star's `IoContext` is held; Star's `transaction` invocation can't complete the response cycle until every leaf has returned. Even though no caller is `await`ing.

I tested two ways to escape this from userland. Both failed:

1. **Strip the success-path handler tail off every outbound call.** Adding `onErrorOnly: true` to the 4-arg `lmz.call` form so successful results never invoke the local handler chain. If workerd's tracking included the handler `.then()` as part of the subrequest lifecycle, removing it should have shortened the hold. Commit p50 didn't move — stayed in the ~570-640 ms band across multiple runs.
2. **Push the tier's dispatch into `ctx.waitUntil()`.** The `IoContext` doc'd intent for `waitUntil` is "background work, decoupled from the response cycle." If workerd's transitive tracking was bound to the immediate Workers RPC and `waitUntil` opened a separate context, the tier's response to Star would go back as soon as the dispatch was registered, not after the children settled. Commit p50 also didn't move; meanwhile subscriber e2e p50 jumped to ~2 s and delivery failure rate went from 0.02% to 0.32% — `waitUntil` defers work but it's a "best effort, eventually" mechanism, not low-latency. Reverted.

Two failed escape attempts is weak evidence, but it's the evidence I have. The structural read: workerd's subrequest tracking propagates through the dispatch tree, and there's no userland flag that opts a Workers-RPC-spawned subtree out of the originator's response cycle.

The natural next reach is [Cloudflare Queues](https://developers.cloudflare.com/queues/) — Star produces a "broadcast this snapshot" message and returns; a separate consumer dispatches the fan-out tree in its own invocation, no longer on Star's critical path. But Queues' end-to-end delivery floor is hundreds of milliseconds to a few seconds, which is worse than the originator-pays cost we're trying to escape. And Queues themselves are built on Durable Objects under the hood — so any "let's do better than Queues with our own DO-based dispatch tier" attempt would inherit the same DO cold-start floor that motivated us to use a Worker (not a DO) for the broadcast tier in the first place. There's no platform-native primitive that decouples the originator from the dispatch tree without paying a worse tax somewhere else.

Things that also don't escape: **Durable Object facets**. The call from Star to a facet is itself a Workers RPC subrequest that gets tracked transitively the same way the tier worker call does. A facet saves the cross-isolate hop cost (~1.35 ms warm boundary vs ~5-12 ms cross-DO), but it doesn't decouple the invocation lifecycle. **`ctx.waitUntil`** doesn't escape either, by Experiment 2 above. **A sidecar DO with self-scheduled alarms** technically would — Star writes a job to KV, the sidecar polls — but DO alarm granularity (~1 s minimum effective delay) makes the consumer's delivery floor worse than the originator-pays cost we wanted to avoid.

Agents pays no analogous tax because there are no subrequests in its broadcast loop — `ws.send()` is a buffer write, not an RPC. The 5× gap to Agents on this benchmark isn't an open problem with a known solution we haven't built yet; it's the structural floor of the platform for any architecture that decomposes responsibility across separately-addressable units. If you need that decomposition (per-client identity, per-subscriber permissions, multi-tenant isolation), you pay it. If you don't, single-DO + naive broadcast remains the cheaper shape.

## What I'd recommend

- **Single-DO + naive broadcast** is the right primitive when (a) every subscriber gets the same bytes and (b) you can collapse your application into one DO. Agents is a great default; partyserver's broadcast loop is fine.
- **The Gateway pattern + `svc.broadcast`** is the right primitive when you have per-client identity (auth, per-subscriber permissions, drop-on-disconnect cleanup) AND you need to scale fanout. The architectural cost is a per-message hop at small N; the architectural benefit is that tree fanout, per-client auth, and a security DMZ are all the same shape.

## Reproducing this

The bench source is in `apps/nebula/test/browser/`:
- [`fanout.benchmark.ts`](https://github.com/lumenize/lumenize/blob/main/apps/nebula/test/browser/fanout.benchmark.ts) — Lumenize ramp
- [`fanout-agents.benchmark.ts`](https://github.com/lumenize/lumenize/blob/main/apps/nebula/test/browser/fanout-agents.benchmark.ts) — Agents ramp
- [`RESULTS-fanout-comparison-deployed.md`](https://github.com/lumenize/lumenize/blob/main/apps/nebula/test/browser/RESULTS-fanout-comparison-deployed.md) — full data + caveats from this run

```bash
cd apps/nebula
npx wrangler deploy --config test/browser/worker/wrangler.jsonc

# Lumenize ramp
BENCH_BASE_URL=https://nebula-browser-test.transformation.workers.dev \
  FANOUT_N_VALUES=10,50,100,250,500,1000 FANOUT_COMMITS_PER_N=10 \
  FANOUT_TEST_TIMEOUT_MS=600000 \
  npm run bench:fanout

# Agents ramp
BENCH_BASE_URL=https://nebula-browser-test.transformation.workers.dev \
  FANOUT_N_VALUES=10,50,100,250,500,1000 FANOUT_COMMITS_PER_N=10 \
  npm run bench:fanout:agents
```

The deployed worker (`nebula-browser-test`) is a Lumenize-internal test environment but the bench setup is general — same primitives, same patterns, you can stand up an equivalent in any account. The `svc.broadcast` primitive itself ships in [`@lumenize/mesh`](/docs/mesh/broadcast) and doesn't require any of the bench infrastructure.

## Related posts in this arc

- [Piercing the temporal haze](/blog/benchmarking-cloudflare-durable-objects-from-outside) — methodology, how to get honest latency numbers out of CF
- [What I got wrong about DO throughput](/blog/what-i-got-wrong-about-do-throughput) — single-DO peak throughput, gate semantics
- [Cloudflare DO Facets in practice](/blog/cloudflare-do-facets-in-practice) — cold-wake + boundary cost for facet RPC
