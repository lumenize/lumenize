---
title: What I got wrong about Durable Object throughput (and what I had to unlearn)
slug: what-i-got-wrong-about-do-throughput
authors:
  - larry
tags:
  - architecture
  - cloudflare
description: A real-load Cloudflare Durable Objects performance dive. Per-DO-instance throughput of ~410 txn/s, far above single-client serial throughput, and what that taught me about input gates, output gates, and `transactionSync`.
---
I've spent four+ years building on Cloudflare Durable Objects. The mental model I leaned hard into — *input gates make your code passively correct as long as you don't await across critical sections* — works beautifully for simple workloads, and it served me well for years. As I started building [Nebula](/blog/introducing-lumenize-nebula), a moderately complex distributed system, that model was insufficient. This post is what I learned benching that system end-to-end: real numbers from a real workload (not a microbenchmark), and how I had to expand my mental model beyond input gates = correctness.

<!-- truncate -->

## TL;DR

Numbers below come from benching a real Nebula transaction end-to-end — Gateway DO + transactional storage write + a [typia parse-validator](/blog/introducing-parse-validator) hosted as a [Cloudflare DO Facet](/blog/cloudflare-do-facets-in-practice) — over real WebSockets to a deployed Worker:

- **Per-DO-instance throughput: \~410 transactions/sec.**.
- **Output-gate flush latency occurs after input gates open — even when the writes are in a `transactionSync`.** That mechanism is what lets throughput climb above the naive serial floor. (Integrated warm transaction: ~16 ms in-Worker, ~10–13 ms of which is the flush. See [Confirming a hopeful assumption](#confirming-a-hopeful-assumption).)

For facet-specific costs (cold-wake, the ~1.35 ms boundary cost), see the [companion post](/blog/cloudflare-do-facets-in-practice).

## The fixture

To bench a real Nebula transaction end-to-end, we needed a real workload including the storage write. The breakdown below shows every layer the request passes through — exactly the kind of moderately complex distributed system this post's argument is about.

**A warm transaction:**

1. **Routing in** (counted in the ~40 ms ping baseline):
    1. WebSocket internet hop: client → [Gateway DO](/docs/mesh/gateway)
    2. Workers RPC: Mesh call Gateway DO → parent DO
2. **Pre-facet work in the parent DO** (storage reads, etc.) — ~1.5 ms
3. [**Facet call**](/blog/cloudflare-do-facets-in-practice) — ~1.4 ms total:
    1. Boundary overhead — ~1.35 ms (the cost of crossing the facet)
    2. Inner work — ~50 µs (typia parse, in this fixture)
4. **Post-facet work in the parent DO** (~12–14 ms total, all inside `transactionSync` for atomicity). Output-gate flush dominates (~10–13 ms); eTag check, permission walk, and SQL write account for ~1–2 ms.
5. **Routing out** (also counted in the ~40 ms ping baseline):
    1. Workers RPC: Mesh callback parent DO → Gateway DO
    2. WebSocket internet hop: Gateway DO → client

Total end-to-end: **\~56 ms warm round-trip** as the client sees it. Roughly what a classic 3-tier architecture pays just to reach its database — and we add routing, validation, and relationship-based access control on top of the storage write, in the same budget. Credit to Cloudflare's edge architecture.

## Throughput (~410 txn/s per DO instance)

For context, Cloudflare documents [a ~1,000 req/s soft limit per individual Durable Object](https://developers.cloudflare.com/durable-objects/platform/limits/) for simple operations, with throughput dropping as work-per-request grows. Our ~410 txn/s lands at ~41% of that ceiling — and given we've layered in a fuller mesh shape (Gateway hop + WebSocket round-trips), a transactional storage write, and a facet call on top of the bare DO operation, we were pleasantly reassured that we hadn't degraded further.

## Confirming a hopeful assumption

This is the number that confirmed a hopeful assumption I'd been making, and it's the reason I wrote this post.

Full end-to-end over the internet, a request takes ~56 ms warm, the naive throughput ceiling is `1 / 56 ms ≈ 18 txn/s`. That's what a single client doing one in-flight call at a time can sustain.

I ramped concurrency from 1 to 256 simulated clients. At 1 simulated client, throughput sits at ~16 txn/s — close to the ~18 implied by 1/56 ms. Peak is **\~410 txn/s** at 128 simulated clients — far above the single-client floor — and degrades past that. ([Full ramp data](https://github.com/lumenize/lumenize/blob/main/apps/nebula/test/browser/THROUGHPUT-RESULTS.md).)

So, the question remains, how exactly does serial latency of 56 ms produce 400+ ops/sec on one DO? The short answer is interleaving. The longer one is about input and output gates.

The **input gate** serializes events so JavaScript code never runs concurrently with itself, but it opens whenever code awaits I/O. The **output gate** holds outbound messages until pending writes have been durably flushed, so the system never tells a caller "done" before replicas are written to disk on at least three additional machines in three different buildings. The key is that while invocation A waits for its write to durably flush, invocations B, C, …, N start their own work in parallel.

Bottom-line: **Input gates help prevent races. Output gates prevent lies, without preventing interleaving, which benefits throughput.**

:::warning How are responses kept in-order?
The careful reader is wondering: if invocation B starts on the local primary's SQLite *before* A's writes are durably replicated, B sees A's not-yet-durable state. Doesn't that risk a consistency violation? No. Local SQLite acts as a *speculative* commit log: outside observers can't see anything until the output gate releases, and output gates appear to release in invocation-arrival order (can anyone confirm?), so a sequential client never sees B's response before A's. If replication fails, the entire DO instance dies and all in-flight invocations die with it — both A and B vanish from history. The client sees an error and retries.
:::

**I've long held this hopeful assumption that `transactionSync` didn't hold input gates closed while the output-gate flush was ongoing. The data proves that assumption**. If input gates had been held closed, throughput would be 1 / ~16 ms ≈ 62 txn/s, not ~400.

Two different constraints set the two numbers: single-client throughput is bound by *round-trip latency* (the client waits for each response, firing 1/56 ≈ 18 calls per second); peak per-DO throughput is bound by *serial CPU per invocation* — the non-yieldable fraction of in-Worker time.

The two yield-points where the input gate opens — ~1.4 ms on the facet RPC and ~10–13 ms on the output-gate flush — together cover ~80–85% of in-Worker time. That leaves only ~2–3 ms of serial CPU work per invocation (awaited storage reads, permission walk, SQL queue) as the throughput floor: `1 / 2.5 ms ≈ 400 txn/s`, matching what the bench shows.

## What this means for system design

For simple workloads, the gate-semantics model above is the whole correctness story. For moderately complex systems, it isn't. Once your system has work that crosses Workers RPC boundaries, coordinates state with sibling DOs, or interleaves invocations across awaits to hit throughput, "don't await and you're correct" stops being sufficient. You need explicit mechanisms — eTag-based optimistic concurrency, two-phase commits, idempotency keys, version vectors. None of that is exotic; it's standard distributed-systems hygiene.

For Nebula we chose eTags. eTags for all resources in a transaction request tell the DO managing storage what baseline state this transaction should go against. If the state for any of the effected resources has been altered, the eTags don't match, and the transaction fails. The failure response includes the latest state/eTag for each resource. The client-side code can decide how to handle the conflict (revert, merge, ask the user to choose, etc.)

I've often framed [Lumenize Continuations](/docs/mesh/continuations) as a race-prevention tool, but a more accurate framing is: **they make work that will be done in a different place or time explicit at points where pretending it's local would mislead you.** Race prevention is still up to you, but the mental model that Continuations cultivate makes it easier.

## Reproducing this

The fixture, benches, and harness are all in the [Lumenize repo](https://github.com/lumenize/lumenize):

- 30-type ontology fixture: [`packages/ts-runtime-parser-validator/test/fixtures/benchmark-ontology-30.ts`](https://github.com/lumenize/lumenize/blob/main/packages/ts-runtime-parser-validator/test/fixtures/benchmark-ontology-30.ts)
- Latency bench (single-call warm transaction round-trip): [`apps/nebula/test/browser/transactions.bench.ts`](https://github.com/lumenize/lumenize/blob/main/apps/nebula/test/browser/transactions.bench.ts)
- Throughput bench (saturation ramp): [`apps/nebula/test/browser/throughput.benchmark.ts`](https://github.com/lumenize/lumenize/blob/main/apps/nebula/test/browser/throughput.benchmark.ts)
- Raw numbers: [`RESULTS.md`](https://github.com/lumenize/lumenize/blob/main/apps/nebula/test/browser/RESULTS.md), [`THROUGHPUT-RESULTS.md`](https://github.com/lumenize/lumenize/blob/main/apps/nebula/test/browser/THROUGHPUT-RESULTS.md)

Bench harness uses real WebSockets to a deployed Worker — no test-mode bypasses, no in-process mocks. The deployed Worker stays at `nebula-browser-test.transformation.workers.dev` for now; if you want to repro against your own account, the wrangler config and the secret bulk-upload pattern are documented in `RESULTS.md`.

If you find numbers significantly different from these for your own DO workload — especially different throughput shapes — I'd be very interested. Reach out.
