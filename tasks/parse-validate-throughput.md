# Parse-Validate: Throughput / Saturation Bench

**Status**: Not started — design captured 2026-04-29 from a discussion during `tasks/parse-validate-release.md` Phase 1 planning. Out of scope for the parse-validate release (latency-only); split here so it isn't lost.

**Depends on**: The integrated browser bench from `tasks/parse-validate-release.md` Phase 1 — reuses the same harness pieces (`apps/nebula/test/browser/`, Universe-scoped admin, Promise-wrapped `callStarTransaction`, ping-bench WS round-trip baseline).

**Related**:
- `tasks/parse-validate-release.md` — per-call latency bench (sequential `vi.bench`, sibling to this task)
- `feedback_cf_clock_traps.md` — wall-clock measurement cautions
- `tasks/alarm-accuracy-experiment.md` (archived) — example of an external-observer measurement style

## Objective

Find the practical saturation point of the integrated parse-validate path. Two related questions:

1. **Per-Star saturation**: how many transactions per second can a single Star DO sustain before latency knees? At what concurrency level?
2. **Per-Gateway saturation**: how many concurrent active Stars can a single Gateway DO multiplex before *it* becomes the bottleneck (mesh callbacks all funnel through the Gateway)?

Knowing both gives the architecture's real per-tenant ceiling, separates Star-side cost from Gateway-side cost, and informs sizing guidance for `5.3 subscriptions` and any future high-fanout features.

DO's documented practical cap is ~1000 req/s per instance. With parse + write + WS-callback per request, the actual knee is expected to be lower — best guess 100–300 req/s/Star, but the whole point of running this is to stop guessing.

## Why this is a separate task

The latency bench (`parse-validate-release.md` Phase 1) is sequential `vi.bench`: one in-flight transaction at a time, measure per-call cost. Throughput is a different shape — N concurrent in-flight transactions, measure aggregate behavior. Different harness, different signals, different questions. Bundling them into one effort would muddy both.

This task also has its own framing question (load-generator credibility — see Phase 2) that doesn't apply to the latency bench, and it produces sizing/operational numbers rather than per-call latency numbers.

## Method: stepped-concurrency ramp (USL-style)

At each step, hold N requests in flight against the system for a fixed steady-state window (e.g. 20–30 s). Pre-warm so cold-start doesn't pollute.

**Steps**: 1, 2, 4, 8, 16, 32, 64, 128, 256, 512 (extend if no knee found).

**Per step, record**:
- Throughput (txn/s = total completions / window)
- Latency p50, p99 (per-request, measured client-side, WS-leg latency subtracted via the ping-bench baseline)

**Signals to read**:
- **Knee in latency-vs-concurrency**. Below saturation, latency is roughly flat (request goes straight through). At saturation, queueing kicks in (Little's law: L = λW) and latency rises ~linearly with N.
- **Plateau in throughput-vs-concurrency**. Below saturation: linear, slope ~1. At saturation: flat. Beyond: sometimes decreases if coherence costs grow (USL's β term — retries, lock contention).

The largest N before either signal trips is N* — the optimal concurrency for that DO.

Optional: fit USL parameters (λ, σ, β) to the curve. Neil Gunther's model is well-documented; an Excel sheet or 30 lines of Python suffice.

## Phase 1: Per-Star saturation (one Gateway, one Star)

**Goal**: Find N* for a single Star — the concurrency at which a Star's throughput plateaus or its latency knees.

**Setup**:
- Reuse `apps/nebula/test/browser/` harness from the latency bench
- Universe-scoped bootstrap admin (one client, one WS, one Star scope, one ontology version) — same as latency bench's `beforeAll`
- Pre-warm: fire ~20 transactions sequentially before the ramp to ensure cache, facet bundle, and DO are all hot
- Measure WS-leg round-trip via the ping-bench baseline (single no-op echo) before the ramp; subtract from transaction latencies

**Implementation shape**:
- New file: `apps/nebula/test/browser/throughput.bench.ts` — but **not** vi.bench (which is sequential). A plain vitest `it('finds saturation')` block that drives the ramp and writes results to `apps/nebula/test/browser/THROUGHPUT-RESULTS.md`.
- Per step: `Promise.all` of N parallel `client.callStarTransaction(...)` invocations, looping until the window expires; each completion records its latency into an array; total completions / window = throughput.
- Between steps, drain in-flight requests and pause briefly (let the DO settle before next step).

**Success Criteria**:
- [ ] Throughput-vs-concurrency curve recorded for N ∈ {1, 2, 4, …, max-meaningful}
- [ ] Latency p50/p99-vs-concurrency curve recorded for the same N values
- [ ] N* (the knee) identified and noted
- [ ] Results written to `apps/nebula/test/browser/THROUGHPUT-RESULTS.md`
- [ ] Run reproduced once on deployed Cloudflare (not just local `wrangler dev`) — saturation under real network conditions matters more than under loopback

## Phase 2: Load-generator credibility (Node vs Worker)

A single Node process is reliable to ~256–512 concurrent WebSocket clients on this workload before Node's own event-loop / GC pauses contaminate measurements. Past that you can't trust the numbers — you're measuring the load generator, not the system under test.

If Phase 1's curve hasn't kneed by N=256, we have to upgrade the load generator before going higher. Two options:

**Option A — Multiple Node `worker_threads` on one machine.** Each thread runs an independent client pool; main thread aggregates. Gets to ~1k concurrent reliably. Cheapest path. Adequate if N* turns out to be in the 300–800 range.

**Option B — Cloudflare Worker as load generator.** Spawn a Worker that fires N parallel `fetch`/WebSocket calls at the deployed system. Workers have effectively unlimited parallelism, you're measuring from inside Cloudflare (so geographic round-trip and load-gen contamination both vanish), and it's cheap. The right choice if we want to go past ~1k or get the most credible numbers for the 2b-style follow-up post.

**Decision rule**: pick A if Phase 1's knee is clearly below 256. Pick B if the knee is at or beyond 256, or if we want a publishable number we'd defend against community scrutiny.

**Success Criteria**:
- [ ] Decision made (A or B) based on Phase 1's curve
- [ ] If A: `worker_threads`-based load generator built; Phase 1 ramp re-run at higher N to find knee
- [ ] If B: Load-generator Worker built and deployed; Phase 1 ramp re-run from inside Cloudflare

## Phase 3: Per-Gateway saturation (M Stars, one Gateway)

Every transaction round-trips through the Gateway DO via mesh callback. So before we find the *Star's* limit, we may already have hit the *Gateway's*. Measuring Phase 1 with a single Star can't distinguish "Star saturated" from "Gateway saturated" — the Star is the only thing using the Gateway in that test.

**Goal**: Determine whether the Gateway saturates before the Star, and at what M (number of concurrent active Stars).

**Setup**:
- Same harness; admin still Universe-scoped, so one client can drive M unique Stars through the same Gateway
- For M ∈ {1, 2, 4, 8, 16, …}: at *each* M, run Phase 1's ramp on each Star concurrently; record per-Star throughput and aggregate Gateway throughput

**What to look for**:
- If per-Star throughput stays at Phase 1's number as M grows → Gateway is not the bottleneck at this scale; report the upper-M tested as a lower bound.
- If per-Star throughput drops as M grows → the Gateway saturated. Aggregate throughput at the drop is the Gateway's ceiling.

This is the more architecturally interesting number — it tells us "how many concurrent active scopes per Gateway" — and is the one most likely to be load-bearing for sizing decisions in 5.3.

**Success Criteria**:
- [ ] Per-Star throughput recorded as a function of M
- [ ] Gateway saturation point identified (or lower bound reported if not reached at max-M tested)
- [ ] Results written to `apps/nebula/test/browser/THROUGHPUT-RESULTS.md` alongside Phase 1

## Phase 4: Facet vs plain Worker — does horizontal scaling beat same-isolate RPC at high load?

**Goal**: Test the hypothesis that a facet, despite winning low-load latency, may *lose* on throughput because all parses serialize through one isolate — and a plain Dynamic Worker (or Service-Binding Worker) hosting the parser would scale horizontally across isolates and win at high concurrency.

**Gated on**: Phase 1's curve. Only worth running if Phase 1 identifies the **parse** as the bottleneck (per-Star throughput plateau coincides with parse-bound CPU, not the Star's write path or the Gateway's mesh routing). If the Star's write path or Gateway saturates first, the parser-host choice doesn't matter at this scale.

**Hypothesis**:
- A facet shares the parent DO's isolate. All concurrent parses on one Star serialize through that one isolate's CPU. Best-case throughput per Star ≈ (1 / per-call parse time) — fixed by single-isolate compute.
- A plain Worker (via Service Binding) or a Dynamic Worker (via `env.LOADER`) runs in its *own* isolate(s). Cloudflare's runtime auto-scales additional isolates for concurrent load. Throughput scales with offered load until the Star or upstream saturates.
- Per-call latency: facet wins (same-isolate RPC, ~1.4 ms warm in our 5.2.4.1 numbers). Plain Worker / DW pays a cross-isolate RPC hop (somewhat higher, but unmeasured for typia parse — `tasks/nebula-5.2.6-switch-validate-to-plain-worker.md` has pre-typia numbers when parse compute dominated).
- Net: **facet has best low-load latency; plain Worker has best high-load throughput.** The crossover point is what this phase measures.

**Related prior work**:
- `tasks/nebula-5.2.6-switch-validate-to-plain-worker.md` — proposed plain-Worker-via-Service-Binding for *latency* reasons under tsc (~15–25 ms parse). Concluded plain Worker beats DW for cold-start, both beat facet on throughput. Pre-typia; numbers don't transfer directly because typia changes the bottleneck character (compute is now ~50 µs, RPC dominates the warm path). This phase is a fresh measurement under typia.
- `experiments/dw-bundler-spike/` — earlier deployed benchmarks. Same caveat: pre-typia.

**Experimental design**:
- Build a second harness scope where `ParserValidator` is invoked via a plain Worker (Service Binding) instead of as a facet on the Star. Star → `env.PARSER.parseBatch(...)` over RPC, parser runs in its own Worker.
- Re-run Phase 1's per-Star ramp on this alternate host.
- Compare per-Star throughput-vs-N curves: facet vs plain-Worker.
- Note where the crossover happens (if it does within reasonable N).

**Does the parser need to be refactored?**

Likely a small adapter, not a refactor of `@lumenize/ts-runtime-parser-validator` itself. As you noted, `ParserValidator extends DurableObject` doesn't *make* it a DO — wrangler config + binding type does. A plain Worker entrypoint can host the same class as long as no DO-specific APIs (`ctx.storage`, `ctx.blockConcurrencyWhile`, alarms) are called. Worth verifying this assumption empirically before committing to the experiment shape:
- If the parser truly only uses constructor + parse methods, host it as a `WorkerEntrypoint` in a thin wrapper Worker — no package change.
- If anything DO-specific creeps in, emit a parallel Worker form from `@lumenize/ts-runtime-parser-validator`. Track that decision separately if it comes up.

**Success Criteria**:
- [ ] Determined whether parser-only hosting requires package changes (yes/no, with one-line justification)
- [ ] Plain-Worker-hosted parser harness built (scoped narrowly to this experiment)
- [ ] Per-Star throughput-vs-N curve recorded for plain-Worker hosting; compared side-by-side with facet curve from Phase 1
- [ ] Crossover N (where plain-Worker throughput overtakes facet) identified, or noted as "not within tested range"
- [ ] Per-call latency cost of plain-Worker hosting recorded (warm p50/p99) alongside throughput — needed to size the latency/throughput tradeoff
- [ ] Architecture recommendation written into `THROUGHPUT-RESULTS.md`: when does the throughput win justify the latency loss?

**If the hypothesis holds**: this is potentially a 5.2.6-revival signal — the throughput numbers may justify reopening the plain-Worker direction even though typia made the latency case for facets stronger. That's a follow-up task decision, not part of this experiment; flag it in `THROUGHPUT-RESULTS.md` and let the next planning pass decide.

## Phase 5 (optional): Findings post

If the numbers are interesting (clear knee, surprising ceiling, useful sizing guidance), draft a follow-up to the parse-validate facet-performance post (`parse-validate-release.md` Phase 2b): "How much load can a single Star/Gateway take?" Cloudflare-community audience, same framing rules from `feedback_cf_community_framing.md`.

If the numbers are unsurprising, skip the post and just keep `THROUGHPUT-RESULTS.md` as internal reference.

## Out of Scope

- **Multi-tenant load testing across many Galaxies.** This is one-org-deep — a single tenant hammering its own Star. Cross-tenant fairness, noisy-neighbor isolation, etc. are different questions for a different task.
- **Subscription fanout.** 5.3's high-fanout subscription path will have its own throughput shape. Don't conflate.
- **End-to-end latency under load from real geographic clients.** The Cloudflare-Worker load generator approximates this; for true end-to-end we'd need real edge clients, which is k6/cloud territory.

## Notes

- **Wall-clock fidelity**: `performance.now()` in Node is honest. WS-leg subtraction (via the ping bench) keeps the cost framing in-Worker. Avoid `Date.now()` *inside* DOs for any measurement (clock pinning — see `feedback_cf_clock_traps.md`); do all timing client-side.
- **Steady-state windowing**: the first ~5 s of each step is rampup as in-flight Promises queue up; throughput should be measured on the steady-state window only. Drop the first and last few seconds of each step.
- **Pre-warm matters**: cold facet bundle, cold typia validator, cold DO all add hundreds of ms each. The bench measures *steady-state* throughput; cold-start is the latency-bench's job.
