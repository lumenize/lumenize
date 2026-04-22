# Alarm Accuracy Experiment

## Status: Decision reached (2026-04-22); Phases 1–5 complete; Phases 6–7 deferred

**Decision per pre-registered criteria**: keep the current alarm-based `LumenizeClientGateway` grace-period design. Measured p99 at 5 s: **1 ms** (threshold for refactor was > 10 s). No trials fired early.

**Key findings** (see `experiments/alarm-accuracy/EXPERIMENT_RESULTS.md` for full per-bucket percentiles and discussion):

- Alarms at delays ≤ 30 s fire with sub-millisecond median accuracy. Tails stay under 36 ms.
- 60 s and 120 s buckets show bimodal behavior — most trials fire on time, occasional wakes pay hibernation cost (p99 of 281 ms at 60 s).
- 300 s alarms consistently pay a cold-wake cost: `doJitter` p50 = 241 ms, p99 = 709 ms.
- The 10 s hibernation-eligibility window explains the pattern: short-delay alarms don't hibernate and fire instantly; long-delay alarms hibernate and pay wake overhead.

**Side-effect wins from the experiment**:

- Fixed a latent bug in `@lumenize/mesh` where `LumenizeClient` couldn't be imported from Node.js / browser (transitive `cloudflare:workers` load). New subpath export `@lumenize/mesh/client` + Node regression test. See `tasks/mesh-client-node-import.md`.
- Corrected the `cf-clock-traps` memory: earlier sessions had the alarm-handler `Date.now()` semantics wrong. Phase-4 data disproved the "pinned to scheduledFor" hypothesis.

**Deferred / optional**:

- **Phase 6 (blog post)**: owed. Headline is "your DO alarm is probably fine" — see framing notes in `feedback_cf_community_framing.md`.
- **Phase 7 (setTimeout refactor)**: NOT triggered by decision criteria, but an ~220 ms per-trigger optimization is available if someone picks it up later. The 5 s grace window is inside the 10 s hibernation-eligibility threshold, so `setTimeout(5000)` and `setAlarm(+5000)` keep the DO alive the same amount; `setTimeout` just skips the alarm-scheduler dispatch cost. Small win; not urgent.
- **Caveats on current data** (from results doc): single time-of-day, single colo, 50 trials/bucket. Strengthen before publishing the blog post.

---

## Objective

Measure real-world jitter of Cloudflare Durable Object alarms across a range of scheduling delays, to make a data-backed decision about whether the 5 s grace-period alarm in `LumenizeClientGateway` needs replacing with `setTimeout()`, and to publish the dataset as a blog post.

## Motivation

Kenton Varda's Discord guidance ([link](https://discord.com/channels/595317990191398933/773219443911819284/1496295230884806676)): *"If you need second-level accuracy with alarms… setting an alarm less than a minute in the future, you should probably just do a setTimeout() wait instead."* This implies alarm jitter may be on the order of tens of seconds — potentially breaking the 5 s grace-period contract in [`LumenizeClientGateway`](../packages/mesh/src/lumenize-client-gateway.ts).

Two pressures make the answer non-obvious:

1. **State model sensitivity.** `LumenizeClientGateway` advertises zero-storage and derives "in grace period" from `getAlarm()`. Swapping to `setTimeout()` means either instance variables (CLAUDE.md footgun) or storage, plus documentation updates.
2. **No public data.** Kenton's message is the closest public signal on DO alarm jitter, and even his guidance is qualitative ("second-level accuracy", "tens of seconds"). Measured percentile data is publishable and replaces hand-waving — from Kenton, from us, from everyone else — with numbers.

**What is NOT a pressure** (was initially on this list, since removed): *fanout concurrency.* The original version of this task file argued that grace-period jitter multiplies fanout latency via a `(disconnected_count / 6) × grace_ms` term, where 6 was assumed to be the DO→DO RPC concurrency cap. Investigation of Cloudflare's documentation (see [`experiments/do-rpc-concurrency/FINDINGS.md`](../experiments/do-rpc-concurrency/FINDINGS.md)) shows that DO stub RPC is not in the enumerated list of APIs subject to the 6-connection limit, and the limit itself was relaxed in April 2026. So the fanout-multiplier argument is no longer load-bearing.

## Key Questions

1. **p50 / p90 / p95 / p99 jitter** at scheduled delays of `[1, 3, 5, 10, 30, 60, 120, 300]` seconds.
2. **Does the alarm ever fire *before* the scheduled time?** (Would break the grace-period invariant immediately.) Count and report; no special handling beyond reporting.
3. **Is jitter bounded by a constant, or does it scale with delay?**
4. **How often does fire-and-forget delivery from `alarm()` to the client fail?** (Secondary outcome — informs whether `this.lmz.call()` needs retry logic.)
5. **Does jitter vary by time of day or by region?** (Secondary — only if primary data is ambiguous. Per-trial DO instance naming spreads trials across colos, giving partial geographic coverage for free.)

## Decision Criteria

Primary metric: **p99 of `firedAt - scheduledFor` at the 5 s bucket** (see "Primary Metric" below for how this is measured).

- p99 jitter at 5 s is **< 1 s** and never fires early → keep current alarm design.
- p99 jitter at 5 s is **1 – 10 s** and never fires early → keep current design but document the ceiling; revisit when fanout notification service lands.
- p99 jitter at 5 s is **> 10 s** or alarm fires early → refactor `LumenizeClientGateway` to `setTimeout()`-based grace, accepting the instance-variable tradeoff.

## Primary Metric

**Both DO-local and Node-local measurements are recorded; DO-local is preferred if validation shows it's clean.**

**DO-local (preferred):** `jitter = firedAt - scheduledFor`, where `scheduledFor` is the absolute time stored at `setAlarm()`, and `firedAt` is `Date.now()` at the start of the `alarm()` handler. This is pure alarm accuracy — no network RTT confound.

**Caveat on `Date.now()` in DOs:** Cloudflare freezes `Date.now()` within an invocation, and invocation boundaries over WebSockets are not always clean — successive messages can share the same frozen clock value. However, `alarm()` is invoked by Cloudflare's alarm scheduler (not a WS message), so *that* handler should have its own clock snapshot. Similarly `scheduleTrial()` arrives at `AlarmMeasurementDO` via DO→DO RPC from the Gateway, not directly over WS. We *expect* both to have independent clocks, but we don't bet the experiment on it.

**Node-local (fallback):** `jitter = (t1 - t0) - delayMs - RTT_baseline`, where:
- `t0` = Node timestamp immediately before sending the `scheduleTrial` RPC
- `t1` = Node timestamp immediately on receipt of `onAlarmFired` push
- `RTT_baseline` = characterized from a `delayMs = 0` trial (Node → Gateway → DO → Gateway → Node with zero delay)

**Validation rule (run during Phase 2 and Phase 3 warm-ups):**
- If DO-local and Node-local agree within a few ms consistently → use DO-local as primary.
- If DO-local ever goes negative (firedAt < scheduledFor), or the two diverge systematically beyond baseline RTT → use Node-local as primary and document the reason in `EXPERIMENT_RESULTS.md`.
- Always record and publish both columns regardless of which is primary.

## Architecture

Dogfoods `@lumenize/mesh` server-to-client push so we exercise the real gateway path.

```
Node runner ─── LumenizeClient WebSocket ──► LumenizeClientGateway ──► AlarmMeasurementDO[trialId]
                                                                            │
                                                                            │ setAlarm(Date.now() + delayMs)
                                                                            ▼
                                                                        alarm() fires
                                                                            │
                                                                            │ this.lmz.call('GATEWAY', clientId, ctn().onAlarmFired(trialId, scheduledFor, firedAt))
                                                                            ▼
Node runner ◄─── onAlarmFired(trialId, scheduledFor, firedAt) ◄────── Gateway forwards
```

**One DO instance per trial** — the DO name is derived from `trialId`, so every trial gets a fresh instance. This parallelizes the sweep (no serialization through a single DO's alarm slot) and spreads trials across Cloudflare colos.

## Parallelization Model

- Node runner starts trials at a **configurable rate** (`concurrency` knob in the runner, default **5 trials/sec**).
- Each trial targets `AlarmMeasurementDO.get(trialId)` — different instance per trial.
- Full sweep timing: 400 trials × (1/5) s = 80 s of scheduling + tail wait for the 300 s bucket → **~7–8 min wall clock per full run**.
- If observed arrival rate on the Node side is bursty or the event loop shows backpressure in Phase 2 validation, dial `concurrency` down. If measurements look clean, dial up.

## Phase 1: Scaffold experiment package

**Goal**: Working `experiments/alarm-accuracy/` package that runs locally against miniflare.

**Success Criteria**:
- [ ] Package created at `experiments/alarm-accuracy/` mirroring the layout of `experiments/call-delay/`
- [ ] `wrangler.jsonc` with `AlarmMeasurementDO` binding, `LumenizeClientGateway` binding, and required mesh wiring
- [ ] `AlarmMeasurementDO` extends `LumenizeDO`:
  - `scheduleTrial(trialId: string, delayMs: number, clientId: string): { scheduledFor: number }` — computes `scheduledFor = Date.now() + delayMs`, calls `ctx.storage.setAlarm(scheduledFor)`, persists `pendingTrial: { trialId, scheduledFor, clientId }`, returns `{ scheduledFor }` so the Node runner has the DO-local scheduled time
  - `alarm()` — wraps body in try/catch (fire-and-forget delivery is lossy per CLAUDE.md); reads pending trial from storage; captures `firedAt = Date.now()`; calls `this.lmz.call('GATEWAY', clientId, ctn().onAlarmFired(trialId, scheduledFor, firedAt))`
  - On `lmz.call` failure inside the catch: write a delivery-failure record to a second storage key and log via `debug()` — Node runner will still miss the trial, but the DO retains evidence that the alarm fired
  - Storage shape: `pendingTrial: { trialId, scheduledFor, clientId }` — only one trial in flight per DO instance (but each trial has its own DO, so this is not a throughput limit)
- [ ] Node runner (`test/runner.ts`) using `LumenizeClient` with a local `onAlarmFired(trialId, scheduledFor, firedAt)` handler that logs one row per trial to `trials.csv`:
  - `trialId, delayMs, t0, t1, scheduledFor, firedAt, observedMsNode, jitterDoLocal, jitterNodeLocal, deliveryOk`
- [ ] Second CSV `delivery-failures.csv` written at the end by scanning each DO's delivery-failure storage (via a separate `getDeliveryFailure(trialId)` method) for trials that didn't arrive on the Node side within a timeout
- [ ] End-to-end smoke test: one 2 s trial against miniflare, verify CSV row is written

## Phase 2: Local validation runs

**Goal**: Confirm the methodology works before burning production time.

**Success Criteria**:
- [ ] Baseline RTT trial at `delayMs = 0` — characterize Node → Gateway → DO → Gateway → Node round trip (expect low tens of ms)
- [ ] 10 trials each at `[1, 3, 5]` seconds against miniflare complete without error
- [ ] DO-local vs Node-local comparison across those trials:
  - Plot both jitter columns on the same axes
  - Check for any `firedAt < scheduledFor` rows — if present, DO-local is unreliable, fall back
  - Check that (NodeLocal - DoLocal) ≈ RTT_baseline consistently
- [ ] Spot-check: one trial where client disconnects before alarm fires — confirm the `lmz.call` correctly throws `ClientDisconnectedError` into the try/catch, the delivery-failure storage record gets written, and the Node runner's post-run scan picks it up

## Phase 3: Production deployment

**Goal**: Deployed experiment on real Cloudflare infrastructure.

**Success Criteria**:
- [ ] Deployed via `npm run deploy` to a dedicated workers.dev subdomain
- [ ] Runner can target production via `TEST_URL=…` env var
- [ ] 3 warm-up trials succeed against production before committing to full sweep
- [ ] Re-run the DO-local vs Node-local validation on the warm-up trials; lock in primary metric choice before Phase 4

## Phase 4: Full production sweep

**Goal**: Statistically meaningful dataset.

**Success Criteria**:
- [ ] Sweep shape: `delays = [1000, 3000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000] ms`, **50 trials per bucket**, trials interleaved (not grouped by delay) and issued at the runner's `concurrency` rate (default 5/sec)
- [ ] Each trial uses a unique DO instance (name derived from `trialId`) so alarms run in parallel
- [ ] Run at 3 different times of day (morning / afternoon / late night local) to catch diurnal variance — total ~150 trials per bucket across all runs
- [ ] Raw CSV archived in `experiments/alarm-accuracy/results/` with timestamp + git SHA in filename
- [ ] Delivery-failure CSV archived alongside
- [ ] Runner is idempotent and resumable (trial ID is deterministic so partial runs can be replayed)

## Phase 5: Analysis

**Goal**: Percentile tables + histograms + decision.

**Success Criteria**:
- [ ] Analysis script (`analyze.ts` or `.py` — whichever is easier) produces:
  - Percentile table: rows = delay buckets, columns = p50, p90, p95, p99, max, min, early-fire count, delivery-failure count
  - Histogram per bucket (log-scale x-axis for jitter)
  - Combined scatter: scheduled delay (x) vs jitter (y)
  - Side-by-side comparison of DO-local vs Node-local jitter columns (validation exhibit)
- [ ] `EXPERIMENT_RESULTS.md` in the experiment directory summarizes findings against the Decision Criteria above
- [ ] Explicit recommendation captured: keep current design, document ceiling, or refactor to `setTimeout()`
- [ ] Delivery-failure rate reported separately with a recommendation on whether `this.lmz.call()` needs retry logic

## Phase 6: Blog post

**Goal**: Publishable content that establishes authority + SEO.

**Success Criteria**:
- [ ] Draft at `website/blog/YYYY-MM-DD-do-alarm-accuracy.md`
- [ ] Leads with the headline number (p99 at common delays) in the first paragraph
- [ ] Includes histograms as inline images (charts generated by the analysis script, committed as PNGs)
- [ ] Explains methodology so a reader can reproduce (link to the experiment source)
- [ ] Contextualizes against Kenton's Discord guidance — neither dunking nor hedging; just "here's what we measured"
- [ ] Closes with concrete guidance: *"If your alarm is ≥ X seconds in the future, don't bother with setTimeout chaining. Below X seconds, here's the tradeoff."*
- [ ] CTA links to `@lumenize/mesh` grace-period design for readers interested in the applied case

## Phase 7 (conditional): Apply findings to `LumenizeClientGateway`

**Trigger**: Only if Decision Criteria says "refactor."

**Goal**: Replace alarm-based grace period with `setTimeout()` + in-memory state while preserving the zero-storage design story. Wall-clock billing for a ~5 s `setTimeout` is negligible in practice and not a concern.

**Success Criteria** (sketch — to be fleshed out if triggered):
- [ ] Instance variables `#graceExpiresAt: number | null` and `#graceTimer: ReturnType<typeof setTimeout> | null`
- [ ] `#isSubscriptionRequired()`, `__executeOperation()`, `#waitForReconnect()` updated to consult the in-memory state
- [ ] Class header state table updated; zero-storage claim re-examined (setTimeout keeps DO alive so instance vars are safe *during grace* — document this carve-out)
- [ ] All existing mesh tests pass unchanged
- [ ] New test: simulate DO eviction mid-grace (if possible in vitest-pool-workers) — document the behavior

## Open Questions

- **Cost of 1200+ trials on Cloudflare?** Alarms and Workers invocations are cheap; expect < $1 total. Confirm before running.

## Non-Issues (noted to prevent re-litigation)

- **`LUMENIZE_MESH_TEST_MODE`** is irrelevant here — it only affects the gateway's own grace-period length (`#gracePeriodMs`). The experiment keeps the client connected throughout, so that code path never runs. Our measurement alarm lives on `AlarmMeasurementDO` and is independent of gateway internals.
- **Concurrent-subrequest ceiling** was previously spun out to `tasks/do-rpc-concurrency-experiment.md` and has since been answered from Cloudflare docs (see [`experiments/do-rpc-concurrency/FINDINGS.md`](../experiments/do-rpc-concurrency/FINDINGS.md)). DO→DO RPC is not subject to the 6-connection limit. This does not change the experiment's value; it only removes one of the original motivations.

## Notes

- Prior art lives in `experiments/call-delay/` (similar architecture, uses WebSockets for progress) — mirror its package layout.
- This experiment does NOT block any current work; run asynchronously to active Nebula/Mesh development.
- If results land in the "keep current design" bucket, Phase 7 never runs and the blog post is still valuable.
