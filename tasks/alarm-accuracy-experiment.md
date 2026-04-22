# Alarm Accuracy Experiment

## Objective

Measure real-world jitter of Cloudflare Durable Object alarms across a range of scheduling delays, to make a data-backed decision about whether the 5 s grace-period alarm in `LumenizeClientGateway` needs replacing with `setTimeout()`, and to publish the dataset as a blog post.

## Motivation

Kenton Varda's Discord guidance: *"If you need second-level accuracy with alarms… setting an alarm less than a minute in the future, you should probably just do a setTimeout() wait instead."* This implies alarm jitter may be on the order of tens of seconds — potentially breaking the 5 s grace-period contract in [`LumenizeClientGateway`](../packages/mesh/src/lumenize-client-gateway.ts).

Three pressures make the answer non-obvious:

1. **State model sensitivity.** `LumenizeClientGateway` advertises zero-storage and derives "in grace period" from `getAlarm()`. Swapping to `setTimeout()` means either instance variables (CLAUDE.md footgun) or storage, plus documentation updates.
2. **Fanout concurrency.** With Workers' 6-concurrent-subrequest limit, grace-period delay *multiplies* fanout latency: `(disconnected_count / 6) × grace_ms`. Alarm late-firing directly inflates this — a 5 s grace that actually fires at 30 s turns a 100-client fanout from ~83 s into ~500 s.
3. **No public data.** Kenton's message is the closest public signal on DO alarm jitter. Measured percentile data is publishable and establishes authority.

## Key Questions

1. **p50 / p90 / p95 / p99 drift** at scheduled delays of `[1, 3, 5, 10, 30, 60, 120, 300]` seconds.
2. **Does the alarm ever fire *before* the scheduled time?** (Would break the grace-period invariant immediately.)
3. **Is jitter bounded by a constant, or does it scale with delay?**
4. **Does jitter vary by time of day or by region?** (Secondary — only if primary data is ambiguous.)

## Decision Criteria

- If p99 drift at 5 s is **< 1 s** and never fires early → keep current alarm design.
- If p99 drift at 5 s is **1 – 30 s** and never fires early → keep current design but document the ceiling; revisit when fanout notification service lands.
- If p99 drift at 5 s is **> 30 s** or alarm fires early → refactor `LumenizeClientGateway` to `setTimeout()`-based grace, accepting the instance-variable tradeoff.

## Architecture

Dogfoods `@lumenize/mesh` server-to-client push so we exercise the real gateway path.

```
Node runner ─── LumenizeClient WebSocket ──► LumenizeClientGateway ──► AlarmMeasurementDO
                                                                          │
                                                                          │ setAlarm(Date.now() + delayMs)
                                                                          ▼
                                                                      alarm() fires
                                                                          │
                                                                          │ this.lmz.call('GATEWAY', clientId, ctn().onAlarmFired(trialId, scheduledFor))
                                                                          ▼
Node runner ◄─── onAlarmFired(trialId, scheduledFor) ◄────── Gateway forwards
```

- Node runner records `t0` when the schedule RPC is **sent** (avoids RTT noise on the outbound side), `t1` when `onAlarmFired` arrives.
- `observedMs = t1 - t0`, `drift = observedMs - delayMs`. Drift includes client→DO RTT + push RTT; those are small (low tens of ms) and can be characterized with a baseline `ping` trial at `delayMs = 0`.

## Phase 0: Verify the 6-concurrent-subrequest claim

**Goal**: Confirm or refute the assumed concurrency ceiling that makes the fanout argument load-bearing. If the real limit is much higher (or doesn't apply to DO → DO RPC), the grace-period multiplier shrinks and some motivation for this experiment weakens — but we'd still want the alarm accuracy data for the blog.

**Success Criteria**:
- [ ] Check Cloudflare's [platform limits docs](https://developers.cloudflare.com/workers/platform/limits/) and search their Discord for "concurrent subrequest" — if the answer is clearly documented, skip the empirical test
- [ ] If docs are ambiguous, run a minimal empirical probe:
  - Caller DO does `Promise.all(range(20).map(i => this.env.TARGET_DO.get(\`inst-\${i}\`).slowOp(i)))` — **20 different instances** so input gates don't serialize the targets
  - Each target's `slowOp(i)` records `{i, enteredAt: Date.now()}`, sleeps ~2 s (setTimeout is fine in a test fixture), returns
  - Plot `enteredAt` vs `i`: a flat line means no concurrency cap on this path; a staircase with step height ~2 s and step width K means cap = K
  - Test both caller topologies: **Worker → DO** and **DO → DO** (fanout is the DO-caller case)
- [ ] Document result in `experiments/alarm-accuracy/CONCURRENCY_FINDINGS.md` (or spin out as `experiments/do-rpc-concurrency/` if the probe grows)

## Phase 1: Scaffold experiment package

**Goal**: Working `experiments/alarm-accuracy/` package that runs locally against miniflare.

**Success Criteria**:
- [ ] Package created at `experiments/alarm-accuracy/` mirroring the layout of `experiments/call-delay/`
- [ ] `wrangler.jsonc` with `AlarmMeasurementDO` binding, `LumenizeClientGateway` binding, and required mesh wiring
- [ ] `AlarmMeasurementDO` extends `LumenizeDO`:
  - `scheduleTrial(trialId: string, delayMs: number, scheduledFor: number): void` — calls `ctx.storage.setAlarm(scheduledFor)`, returns immediately
  - `alarm()` — wraps body in try/catch (fire-and-forget delivery is lossy per CLAUDE.md); reads pending trial from storage; calls `this.lmz.call('GATEWAY', clientId, ctn().onAlarmFired(trialId, scheduledFor, Date.now()))`
  - Storage shape: single key `pendingTrial: { trialId, scheduledFor, clientId }` — only one trial in flight per DO instance
- [ ] Node runner (`test/runner.ts`) using `LumenizeClient` with a local `onAlarmFired(trialId, scheduledFor, firedAt)` handler that logs `{trialId, delayMs, t0, t1, observedMs, drift, firedAtServer, scheduledFor}` to CSV
- [ ] End-to-end smoke test: one 2 s trial against miniflare, verify CSV row is written

## Phase 2: Local validation runs

**Goal**: Confirm the methodology works before burning production time.

**Success Criteria**:
- [ ] Baseline trial at `delayMs = 0` characterizes RTT overhead (expect low tens of ms)
- [ ] 10 trials each at `[1, 3, 5]` seconds against miniflare complete without error
- [ ] Drift values look sane (small positive numbers dominated by RTT)
- [ ] Spot-check: one trial where client disconnects before alarm fires — confirm the `lmz.call` correctly throws `ClientDisconnectedError` into the try/catch rather than hanging

## Phase 3: Production deployment

**Goal**: Deployed experiment on real Cloudflare infrastructure.

**Success Criteria**:
- [ ] Deployed via `npm run deploy` to a dedicated workers.dev subdomain
- [ ] Runner can target production via `TEST_URL=…` env var
- [ ] 3 warm-up trials succeed against production before committing to full sweep

## Phase 4: Full production sweep

**Goal**: Statistically meaningful dataset.

**Success Criteria**:
- [ ] Sweep shape: `delays = [1000, 3000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000] ms`, **50 trials per bucket**, trials interleaved (not grouped by delay) to spread across time
- [ ] Run at 3 different times of day (morning / afternoon / late night local) to catch diurnal variance — total ~150 trials per bucket across all runs
- [ ] Raw CSV archived in `experiments/alarm-accuracy/results/` with timestamp + git SHA in filename
- [ ] Runner is idempotent and resumable (trial ID is deterministic so partial runs can be replayed)

## Phase 5: Analysis

**Goal**: Percentile tables + histograms + decision.

**Success Criteria**:
- [ ] Analysis script (`analyze.ts` or `.py` — whichever is easier) produces:
  - Percentile table: rows = delay buckets, columns = p50, p90, p95, p99, max, min, early-fire count
  - Histogram per bucket (log-scale x-axis for drift)
  - Combined scatter: scheduled delay (x) vs drift (y)
- [ ] `EXPERIMENT_RESULTS.md` in the experiment directory summarizes findings against the Decision Criteria above
- [ ] Explicit recommendation captured: keep current design, document ceiling, or refactor to `setTimeout()`

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

## Notes

- Prior art lives in `experiments/call-delay/` (similar architecture, uses WebSockets for progress) — mirror its package layout.
- This experiment does NOT block any current work; run asynchronously to active Nebula/Mesh development.
- If results land in the "keep current design" bucket, Phase 7 never runs and the blog post is still valuable.
