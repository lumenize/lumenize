---
title: "Cloudflare DO Facets in practice: cold-wake and boundary cost"
slug: cloudflare-do-facets-in-practice
authors:
  - larry
tags:
  - architecture
  - cloudflare
description: Real numbers for hosting code as a Cloudflare Durable Object facet — cold-wake ~262 ms above DO baseline, warm boundary cost ~1.35 ms per call. Measured with a typia parse-validate fixture; the cost structure generalizes.
---
Cloudflare's [Durable Object Facets](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/) shipped on April 13, 2026[^beta]. Cloudflare's framing is that they're "essentially free." That's accurate at the infrastructure layer — same V8 isolate as the parent DO, no extra billing line, no separate Worker. However, from the cold-wake and per-call latency perspectives, it's not zero, and I needed to know by how much.

While building [Nebula](/blog/introducing-lumenize-nebula), I wanted to host a per-tenant [typia parse-validator](/blog/introducing-parse-validator) close to each tenant's write DO. Facets were the obvious choice, but I wanted real numbers before committing. This post is what I measured: cold-wake contribution and warm RPC boundary cost. For the non-facets-related benchmarking results — throughput, gate semantics, and what I had to unlearn about Durable Objects under load — see the companion post: [What I got wrong about Durable Object throughput](/blog/what-i-got-wrong-about-do-throughput).

<!-- truncate -->

## TL;DR

Numbers below come from a ~119 KB facet bundle hosted on a Durable Object that owns the writes. The fixture is [a typia parse-validator](/blog/introducing-parse-validator), but the boundary costs generalize to any facet workload of similar bundle size:

- **Cold-wake adds \~262 ms** above whatever your DO already pays at first wake — bundle load + module parse + first call into the bundle's exports. One-time per bundle. **Amortizes to zero when you can call it many times** like we do with our parser-validator.
- **Warm boundary cost: \~1.35 ms per facet call.** Our 1.4 ms total is ~1.35 ms generic boundary plus ~50 µs of inner work (a typia parse, in this fixture). The boundary number generalizes; the inner work depends on what you put in the bundle. **Essentially free when compared to the internet hop into Cloudflare**.

## What "facet" means here

A Durable Object Facet is a way to run a [Dynamic Worker](https://blog.cloudflare.com/dynamic-workers/) inside a parent Durable Object's V8 isolate — same process, same thread. Each facet gets its own 128 MB memory budget, but they share the runtime infrastructure, which is what makes the call cheap. A call into a facet is just a local Workers RPC hop, not a network round-trip.

## The fixture

To measure the *facet boundary*, we needed a realistically sized workload running in the facet. Ours is a ~119 KB module that happens to be some real work we were doing for Nebula.[^fixture]

If your facet hosts something else of similar bundle size — a rules engine, a sandboxed transformer, an LLM agent's generated code à la [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/) — the boundary numbers (cold-wake, warm RPC) should land in the same neighborhood. What changes is the inner work cost (~50 µs per call in our workload).

The integrated transaction breakdown — what the bench actually measures end-to-end through Gateway DO, mesh routing, and storage commit — lives in the [companion throughput post](/blog/what-i-got-wrong-about-do-throughput#the-fixture).

## Cold-wake (one-time per bundle)

~262 ms above the DO infrastructure baseline (~1,494 ms — the cold-wake for the DO itself). Bundle-size dominated: V8 has to fetch, parse, and instantiate the module on first wake, and parse cost scales roughly linearly with source size. Smaller bundles cost less; larger ones scale up proportionally. Amortizes to nothing on a warm DO.

## Where does the 1.35 ms boundary cost go?

The work the bundle actually does is 50 microseconds. The remaining ~1.35 ms is the boundary cost.

It's curious that while **facet RPC is roughly an order of magnitude cheaper than a network hop to a separate Worker (1.35 ms vs 5–20 ms typical Service Binding), it's still five orders of magnitude more expensive than a direct function call (1.35 ms vs \~10 ns).** The first gap explains why facets exist. The second is the interesting one — same isolate, same thread, ~100,000× the cost of an in-process call. Where does it go? My guess is the bulk is Workers RPC treating same-isolate facet calls with the same capability machinery it uses for cross-isolate ones — parameters/result serialization/deserialization plus DW source module resolution and loading.

When the ratio of the internet hop count to facet call count is 1:1 like it is here, it's not worth a thought. However, if you were to make many facet calls per internet hop, it would become more of a consideration, especially if it's possible to move any of that into the parent DO.

## Reproducing this

The 30-type ontology fixture used for these benches is at [`packages/ts-runtime-parser-validator/test/fixtures/benchmark-ontology-30.ts`](https://github.com/lumenize/lumenize/blob/main/packages/ts-runtime-parser-validator/test/fixtures/benchmark-ontology-30.ts). The bare-facet bench itself was a throwaway spike — the per-call number (~1.35 ms) is in this post; the harness isn't checked in.

The integrated benches (latency + throughput) and full numbers are linked from the [companion throughput post](/blog/what-i-got-wrong-about-do-throughput#reproducing-this).

If you find numbers significantly different from these for your own facet workload — especially if you're seeing higher facet RPC overhead — I'd be very interested. Reach out.

---

[^fixture]: Our workload: a typia-generated parse-validator hosted as a facet on each Nebula `Star` Durable Object (Nebula's per-tenant write DO). The validator is generated from a 30-type ontology — interfaces with primitives, optionals, unions, nested relationships (`T`, `T | null`, `T[]`, `Set<T>`, `Map<K, T>`), and the standard JSDoc tags (`@minimum`, `@format email`, `@default`, etc.). Source: [`benchmark-ontology-30.ts`](https://github.com/lumenize/lumenize/blob/main/packages/ts-runtime-parser-validator/test/fixtures/benchmark-ontology-30.ts).

[^beta]: Facets are still in beta on the Workers Paid plan as of this writing. No GA timing announcement, no breaking-change entries in the [Durable Objects changelog](https://developers.cloudflare.com/changelog/product/durable-objects/) since launch. The adjacent Dynamic Worker API is receiving additive enhancements (custom limits, nullable bundle names) — evolving but compatible. We're using a stable beta of an evolving feature, not betting on shifting sand.
