# Parse-Validate: Throughput / Saturation Bench

**Status (2026-04-29)**: **Phase 1 complete.** Numbers in [apps/nebula/test/browser/THROUGHPUT-RESULTS.md](../apps/nebula/test/browser/THROUGHPUT-RESULTS.md). Headline: per-Star peak ~410 txn/s deployed at N=128, **23× the serial single-client floor** of ~18 txn/s. Empirically confirms the output-gate / group-commit insight — concurrent invocations interleave on awaits and writes batch through a shared commit, so `1/serial-mean` was a floor not a ceiling. **Phase 2 (load-gen credibility upgrade) did not trigger** — clear knee at N=64–128, well below Node's reliable load-gen ceiling. Phase 3 (gating into release posts) is about to fire — control returns to [parse-validate-release.md](./parse-validate-release.md) Phase 2.

**Depends on**: The integrated browser bench from [parse-validate-release.md](./parse-validate-release.md) Phase 1 — reuses these shipped pieces:
- Harness directory `apps/nebula/test/browser/` (auto-spawned `wrangler dev`, magic-link auth bootstrap)
- `HarnessNebulaClient` ([harness-client.ts](../apps/nebula/test/browser/harness-client.ts)) — extend to a Map keyed by resourceId (see Implementation below)
- `ping()` mesh handler on `StarTest` — already shipped, used sequentially before the ramp for the WS-leg baseline
- Deployed Worker `nebula-browser-test.transformation.workers.dev` + `BENCH_BASE_URL` override in [global-setup.ts](../apps/nebula/test/browser/global-setup.ts) — already configured for deployed runs
- Galaxy-scope bootstrap admin (one client drives any Star under that galaxy)

**Related**:
- [parse-validate-release.md](./parse-validate-release.md) — per-call latency bench (sequential `vi.bench`, sibling to this task)
- [apps/nebula/test/browser/RESULTS.md](../apps/nebula/test/browser/RESULTS.md) — Phase 1 latency numbers; this task's THROUGHPUT-RESULTS.md should cross-link
- `feedback_cf_clock_traps.md` — wall-clock measurement cautions
- `tasks/alarm-accuracy-experiment.md` (archived) — example of an external-observer measurement style

## Objective

**One question**: how many transactions per second can a single Star sustain, with a single client driving N concurrent in-flight calls? Where is N\*?

This is a **per-Star** ceiling under realistic single-client conditions. It implicitly includes the Gateway DO's contribution (one client = one Gateway DO instance, [lumenize-client.ts:537](../packages/mesh/src/lumenize-client.ts:537)), which is fine — the release post wants the user-observable number, not a cost decomposition.

DO's documented practical cap is ~1000 req/s per instance. The Phase 1 latency bench gave us serial single-client throughput of ~19 txn/s deployed (16 ms in-Worker mean + ~40 ms WS round-trip), which is **not** the system ceiling — it's a floor.

**Predicted shape (to test, not assume):**
- **Output gates don't serialize.** They hold *one* invocation's outputs until *its* writes commit; the input gate continues opening on awaits, so concurrent invocations interleave their CPU work and their writes batch into a shared commit (group-commit). This is the architectural insight that makes per-Star throughput substantially exceed `1/serial-mean`.
- **Best guess: knee around 100–300 req/s/Star**, latency staying near the serial mean until the knee. The whole point of running this is to stop guessing — and to map the curve, not just the knee.
- **Likely-saturating component**: storage commit pipeline on the machine hosting the Star DO, *not* parse CPU (typia warm parse is ~50 µs — vanishingly small). The `transactionSync` block is single-threaded JS for ~sub-ms; that serializes but isn't where time goes. Per-iteration cost is dominated by the output-gate flush waiting for the write to fan out.

## Method: stepped-concurrency ramp

At each step, hold N requests in flight against the system for a fixed steady-state window. Pre-warm so cold-start doesn't pollute.

**Steps**: 1, 2, 4, 8, 16, 32, 64, 128, 256 (extend if no knee found, see Phase 2).

**Per step, record**:
- Throughput (txn/s = total completions / window)
- Latency p50, p99 (per-request, measured client-side, WS-leg latency subtracted via the pre-ramp ping baseline — see "open question on ping under load" in Notes)

**Signals to read**:
- **Knee in latency-vs-concurrency**. Below saturation, latency is roughly flat (request goes straight through). At saturation, queueing kicks in (Little's law: L = λW) and latency rises ~linearly with N.
- **Plateau in throughput-vs-concurrency**. Below saturation: linear, slope ~1. At saturation: flat. Beyond: sometimes decreases if coherence costs grow.

The largest N before either signal trips is N\* — the optimal concurrency for this workload.

## Phase 1: Per-Star saturation

**Goal**: Find N\* — the concurrency at which throughput plateaus or latency knees.

**Setup**:
- Reuse `apps/nebula/test/browser/` harness from the latency bench
- Galaxy-scope bootstrap admin (one client, one WS, one ontology version, drives one Star under the galaxy) — mirrors the latency bench's `setupClient()` shape in [transactions.bench.ts](../apps/nebula/test/browser/transactions.bench.ts)
- `uniqueGalaxy()` per run so `.wrangler/state` (or deployed DO storage) doesn't carry resources across runs
- Pre-warm: fire ~20 transactions sequentially before the ramp to ensure ontology cache, facet bundle, and target Star DO are all hot
- Measure WS-leg round-trip via ~50 sequential `client.callStarPing(...)` calls before the ramp; record the mean as `pingMean` and use it as the WS-leg subtraction constant

**Implementation file**: `apps/nebula/test/browser/throughput.test.ts` — plain vitest `it('finds saturation', async () => { ... }, 600_000)` (10-min timeout). Uses the `browser` vitest project (not `browser-bench`) since vi.bench is sequential by design.

**Result-correlation mechanism — match by `resourceId`**:

Each bench iteration creates a unique resource (`crypto.randomUUID()` as resourceId). On success, the Star's response includes `result.eTags` keyed by that resourceId. So the client can correlate a returning result with the originating call by inspecting `Object.keys(result.eTags)` — no Star-side changes, no callId threading.

```ts
class ThroughputHarnessClient extends NebulaClient {
  #pending = new Map<string, { resolve: (r: TransactionResult) => void; reject: (e: Error) => void }>();

  @mesh()
  override handleTransactionResult(r: TransactionResult | Error): void {
    if (r instanceof Error) {
      // No way to correlate an Error to a specific call without callId.
      // Fail-loud: reject all pending. (Errors are unexpected in steady-state ramps;
      // if they happen, the bench should stop and we investigate.)
      for (const p of this.#pending.values()) p.reject(r);
      this.#pending.clear();
      return;
    }
    const resourceId = Object.keys(r.eTags)[0];  // Exactly one create per iteration
    const p = this.#pending.get(resourceId);
    if (!p) return;
    this.#pending.delete(resourceId);
    p.resolve(r);
  }

  callStarTransactionForBench(starName: string, ontologyVersion: string, resourceId: string): Promise<TransactionResult> {
    return new Promise((resolve, reject) => {
      this.#pending.set(resourceId, { resolve, reject });
      this.lmz.call('STAR', starName,
        (this.ctn() as any).transaction(ontologyVersion, {
          [resourceId]: {
            op: 'create',
            typeName: 'TestResource',
            nodeId: ROOT_NODE_ID,
            value: { title: 'bench' },
          },
        }));
    });
  }
}
```

**Trade-off**: this approach assumes (a) every iteration creates exactly one resource (so `Object.keys(r.eTags)[0]` is the originating resourceId) and (b) errors are rare enough that fail-loud-on-error is acceptable. Both hold for a saturation ramp. If we later need richer per-call attribution (multi-op transactions, expected-error paths), switch to a callId mechanism via `StarTest` override at that point — not now.

Ping reuses `HarnessNebulaClient.callStarPing` sequentially before the ramp; no concurrent ping needed.

**Per step (concurrency level N)**:
- Window: 30 s. Drop the first 5 s (rampup as in-flight Promises queue up) and last 2 s (drain) — measure on the steady-state middle 23 s.
- Loop: maintain N in-flight calls. As each completes, record `(start, end, latency)` and immediately fire the next.
- Inter-step: drain in-flight, pause 2 s, then advance N.

**Output**:
- Raw per-iteration data: `apps/nebula/test/browser/throughput-raw.json` (gitignored or kept small) — array of `{ N, start, end, latencyMs }` for offline analysis if needed.
- Summary: `apps/nebula/test/browser/THROUGHPUT-RESULTS.md` written via `fs.writeFileSync` from inside the test, with sections mirroring [RESULTS.md](../apps/nebula/test/browser/RESULTS.md) (deployed table, local table, experiment-design notes, reconciliation with Phase 1 latency).
- Console: headline N\* + throughput-at-N\* + comparison to serial floor.

**Deployed run is required, not optional.** The release post relies on the deployed numbers. Local (`wrangler dev`) is for the implementation-correctness gate only — its numbers go in the diagnostic section of THROUGHPUT-RESULTS.md, not the headline.

**Success Criteria**:
- [x] `ThroughputHarnessClient` (resourceId-keyed Map) implemented; concurrent in-flight calls correlate correctly under load
- [x] Pre-ramp ping baseline captured (mean over ~50 sequential pings) — deployed mean 50.06 ms
- [x] Ramp executed for N ∈ {1, 2, 4, 8, 16, 32, 64, 128, 256}; throughput + latency p50/p99 recorded per step
- [x] N\* identified — peak throughput at N=128 (~410 txn/s), knee at N=64
- [x] Deployed run captured; numbers in [THROUGHPUT-RESULTS.md](../apps/nebula/test/browser/THROUGHPUT-RESULTS.md) as the headline section
- [x] Per-call timeouts (30 s) added during debugging — saturation produces some indefinite-queue calls; timeouts surface them as errors instead of hangs. Heartbeat logging on stderr added for visibility (vitest swallows test-mode stdout)

## Phase 2 (contingency): Load-generator credibility

A single Node process is reliable to ~256–512 concurrent WebSocket clients before Node's own event-loop / GC pauses contaminate measurements. Past that, you're measuring the load generator, not the system.

**Phase 1's expected ceiling vs Node's load-gen ceiling**: deployed warm transaction is ~56 ms mean. At N=256 with Phase 1's setup (one client driving N concurrent calls), generated load ceiling is ~256/0.056 ≈ 4,600 txn/s — well above Cloudflare's documented ~1k req/s/instance. So Node should be sufficient unless N\* turns out higher than expected.

**This phase fires only if Phase 1's curve hasn't kneed by N=256.** **Did not trigger (2026-04-29)** — Phase 1 found a clean knee at N=64 and peak at N=128, well below Node's reliable load-gen ceiling. No need to upgrade. The Node-based bench produced credible numbers; deployed run completed in ~6.5 min with <0.5% error rate at the headline operating points (N=64–128).

Two options if it hasn't:

**Option A — Multiple Node `worker_threads` on one machine.** Each thread runs an independent client pool; main thread aggregates. Gets to ~1k concurrent reliably. Cheapest path. Adequate if N\* is in the 300–800 range.

**Option B — Cloudflare Worker as load generator.** Spawn a Worker that fires N parallel WebSocket calls at the deployed system. Workers have effectively unlimited parallelism, you're measuring from inside Cloudflare (geographic round-trip and load-gen contamination both vanish), and it's cheap. The right choice if we want defensible publishable numbers past ~1k or if Larry's network turns out to be a noticeable factor in Phase 1's results.

**Decision rule**: pick A if Phase 1's knee is clearly below 256. Pick B if the knee is at or beyond 256.

**Success Criteria** (only if triggered):
- [ ] Decision made (A or B) based on Phase 1's curve
- [ ] Higher-N ramp re-run; results appended to THROUGHPUT-RESULTS.md
- [ ] Updated N\* recorded if the curve kneed at the new range

## Phase 3 (gating): Numbers feed the parse-validate release posts

Per [parse-validate-release.md](./parse-validate-release.md)'s 2026-04-29 status update, the release post now needs both **latency** (Phase 1, done) and **throughput** (this task) before it can ship:

- **2a (release announcement)**: a brief throughput line preempts the tsc-engine pushback ("typia engine fixes both latency and throughput").
- **2b (facet performance in practice)**: incorporate the per-Star saturation curve alongside the latency numbers. The output-gate / group-commit nuance is what makes the throughput number much higher than `1/serial-mean` — that's a strong narrative beat for the post.

Once those land, there's an additional standalone post idea captured in [parse-validate-release.md](./parse-validate-release.md): **"the throughput-intuition trap with Durable Objects"** — a Cloudflare-community piece on output-gate semantics and why `1/mean_latency` reads like a ceiling but is actually a floor. Optional, but the angle is strong (4+ years working with DOs and Larry hadn't internalized the distinction; expert blind-spot framing without contradicting Cloudflare's positioning).

If the numbers are entirely unsurprising, skip the standalone post and just keep `THROUGHPUT-RESULTS.md` as internal reference. The release-post integration is non-optional regardless.

## Out of Scope

- **Per-Gateway saturation isolation (M Stars, one Gateway)**. With one client = one Gateway, Phase 1's per-Star number already includes the Gateway's contribution under realistic single-client load — that's what the release post wants. Disambiguating "Star vs Gateway bottleneck" is sizing-decision territory; defer to a future task if 5.3 subscriptions or a sizing-guidance doc actually needs it. (Method when needed: many clients hammering one Star = isolates Star; one client driving M Stars = isolates Gateway.)
- **Plain-Worker / Service-Binding parser hosting comparison.** Was a candidate phase; cut because (a) per Phase 1's prediction, parse isn't the bottleneck (storage commit is), so the plain-Worker throughput hypothesis likely wouldn't fire, and (b) gating the release on a parser-hosting refactor would scope-creep this task. Revisit only if Phase 1 surprises us with a parse-bound knee, or if a future task explicitly motivates it. Prior context: `tasks/nebula-5.2.6-switch-validate-to-plain-worker.md`, `experiments/dw-bundler-spike/`.
- **Multi-tenant load testing across many Galaxies.** This is one-org-deep. Cross-tenant fairness, noisy-neighbor isolation, etc. are different questions for a different task.
- **Subscription fanout.** 5.3's high-fanout subscription path will have its own throughput shape. Don't conflate.
- **End-to-end latency under load from real geographic clients.** Phase 2 Option B (Worker load generator) approximates this; for true end-to-end we'd need real edge clients, which is k6/cloud territory.

## Notes

- **Wall-clock fidelity**: `performance.now()` in Node is honest. Avoid `Date.now()` *inside* DOs for any measurement (clock pinning — see `feedback_cf_clock_traps.md`); do all timing client-side.
- **Pre-warm matters**: cold facet bundle, cold typia validator, cold DO all add hundreds of ms each. The bench measures *steady-state* throughput; cold-start is the latency-bench's job.
- **Open question — ping baseline under load.** Phase 1 captures the ping baseline *before* the ramp, then subtracts that constant from every step's transaction latency. At low N this is fine. At high N (~256), the WS leg may itself become contended (browser-side socket buffering, network jitter on Larry's outbound link), and the constant-subtraction approximation may understate true in-Worker latency. **Mitigation if the curve looks suspicious**: insert ~5 pings *during* each step's steady-state window and recompute the per-step WS-leg estimate. Defer to running the bench and seeing whether the raw curve is well-behaved before adding this complication.
