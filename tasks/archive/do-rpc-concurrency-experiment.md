# DO-to-DO RPC Concurrency Experiment

## Status: Answered from docs (2026-04-22) — empirical probe not run

**Outcome**: Cloudflare documentation indicates DO stub RPC is not subject to the 6-simultaneous-connections limit. See [`experiments/do-rpc-concurrency/FINDINGS.md`](../experiments/do-rpc-concurrency/FINDINGS.md) for evidence and citations.

**Remaining Phases 2–5 below are optional.** They would only be run if publication-grade empirical backing is desired later (e.g., as a supporting artifact for a blog post). The answer is adequate for mesh design decisions as-is.

---

## Objective

Determine whether the Workers 6-concurrent-subrequest limit applies to Durable Object → Durable Object RPC calls. The answer is load-bearing for fanout-latency analysis throughout `@lumenize/mesh` (notification delivery, grace-period sizing, subscription broadcast).

## Motivation

Much of our fanout-latency reasoning assumes a caller DO can only have 6 concurrent in-flight RPCs to other DOs. If that cap doesn't apply to DO→DO calls (or applies at a much higher number), fanout math collapses from `(N / 6) × op_ms` to `~op_ms` — radically different operational envelope and much weaker motivation for some design tradeoffs in the mesh.

This experiment is **independent of and does not block** `tasks/alarm-accuracy-experiment.md`. Both experiments inform mesh design; neither depends on the other's outcome.

## Key Questions

1. **Is there a concurrency cap on Worker → DO RPC?** If yes, what is it?
2. **Is there a concurrency cap on DO → DO RPC?** If yes, what is it? (This is the one that actually matters for mesh fanout.)
3. **Do the caps differ between the two topologies?**

## Decision Criteria

- **No cap (flat line)** on DO→DO → fanout latency math simplifies; document and move on.
- **Cap = 6** → our existing assumption holds; document with empirical backing.
- **Cap = some other constant K** → update all fanout reasoning to use K; revisit grace-period sizing and any other places the number 6 is baked in.

## Architecture

```
Caller (Worker OR DO) ──► Promise.all over 20 distinct target DO instances
                            │
                            │ .slowOp(i)  — sleeps ~2 s, returns
                            ▼
                          TargetDO-{0..19} each record enteredAt = Date.now()
                            │
                            ▼
                          Return array of {i, enteredAt} pairs
```

**20 different target instances** so input gates on any single target DO don't serialize the calls. The question is caller-side concurrency, not target-side.

**Two topology runs** in sequence:
1. **Worker → DO**: HTTP handler issues the Promise.all.
2. **DO → DO**: A `CallerDO` instance issues the Promise.all from inside its own invocation.

## Phase 1: Check existing documentation first

**Goal**: Don't run an experiment if Cloudflare has already answered this publicly.

**Success Criteria**:
- [x] Check [Cloudflare platform limits docs](https://developers.cloudflare.com/workers/platform/limits/) for concurrent-subrequest wording — specifically whether DO calls count as subrequests and whether the limit differs for DO→DO
- [x] Search the Cloudflare Discord for "concurrent subrequest" + "durable object" and capture any authoritative employee responses (Kenton, James, etc.)
- [x] If the answer is **clearly** documented, write `experiments/do-rpc-concurrency/FINDINGS.md` summarizing the sources and STOP — skip the empirical probe
- [~] If ambiguous, proceed to Phase 2 *(not ambiguous — answer is that DO RPC is not in the enumerated list; stopped here)*

## Phase 2: Scaffold experiment package

**Goal**: Working `experiments/do-rpc-concurrency/` package.

**Success Criteria**:
- [ ] Package created at `experiments/do-rpc-concurrency/` mirroring the layout of `experiments/call-delay/`
- [ ] `wrangler.jsonc` with `CallerDO` binding and `TargetDO` binding
- [ ] `TargetDO.slowOp(i: number): { i: number, enteredAt: number }`:
  - Records `enteredAt = Date.now()`
  - Sleeps ~2 s via `await new Promise(r => setTimeout(r, 2000))` (test fixture — setTimeout is fine here, not production code)
  - Returns `{ i, enteredAt }`
- [ ] `CallerDO.fanoutTest(n: number): { i: number, enteredAt: number }[]`:
  - Does `await Promise.all(range(n).map(i => this.env.TARGET_DO.get(\`inst-\${i}\`).slowOp(i)))`
  - Returns the array
- [ ] Worker `fetch()` handler with two endpoints:
  - `GET /worker-fanout?n=20` — runs the same `Promise.all` directly from the Worker
  - `GET /do-fanout?n=20` — calls `CallerDO.fanoutTest(n)` and returns the result

## Phase 3: Local validation

**Goal**: Confirm the test harness produces interpretable output before deploying.

**Success Criteria**:
- [ ] `npm run dev` + `curl /worker-fanout?n=20` returns 20 entries, all with `enteredAt` timestamps
- [ ] `curl /do-fanout?n=20` likewise
- [ ] Both responses log-plot cleanly (manually eyeball — staircase or flat line?)
- [ ] **Caveat**: miniflare may not enforce real concurrent-subrequest limits. Local validation confirms *test correctness*, not the answer.

## Phase 4: Production run

**Goal**: Real Cloudflare infrastructure data.

**Success Criteria**:
- [ ] Deployed via `npm run deploy`
- [ ] Run each topology at `n ∈ [5, 10, 20, 50, 100]`, 3 repetitions each
- [ ] Results saved to `experiments/do-rpc-concurrency/results/` with timestamp + git SHA

## Phase 5: Analysis

**Goal**: Identify the cap (or lack thereof) per topology.

**Success Criteria**:
- [ ] Plot `enteredAt` (y) vs `i` (x), sorted by `enteredAt`, for each topology and each `n`
- [ ] Measure step structure: flat line = no cap; staircase with step height ≈ 2 s and step width K = cap at K concurrent
- [ ] `FINDINGS.md` with:
  - Measured cap per topology (or "none detected up to n=100")
  - Implications for `@lumenize/mesh` fanout reasoning
  - Recommendation on whether mesh docs need updating and where the number 6 is currently referenced

## Non-Goals

- **Tail latency / jitter across concurrent DOs** — that's a different question; this experiment only measures the *cap*, not performance within the cap.
- **Non-RPC paths** — we're not measuring `fetch()` to DOs, HTTP subrequests, or KV/R2 subrequests. Just DO RPC.

## Notes

- Prior art: `experiments/call-delay/` already asks a related question as a secondary goal. Check its `EXPERIMENT_RESULTS.md` before scaffolding — parts of the harness may be reusable.
- This experiment does NOT block any current work. Run asynchronously to active Nebula/Mesh/alarm-accuracy work.
