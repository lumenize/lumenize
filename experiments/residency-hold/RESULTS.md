# residency-hold — does the heartbeat hold a DETACHED turn resident? (deployed)

> **Round 2 (2026-10-01) re-measures this at the compatibility date that turns on
> `durable_object_io_tasks_prevent_eviction`, and finds one round-1 inference false: see
> § *Round 2*. Round 1 below is kept as measured.**

**Question** (Galaxy collapse Phase 3): mesh runs a chat turn DETACHED after early-ack —
a floating promise with no in-flight request pinning the DO. `experiments/plain-do-container`
proved an IN-FLIGHT await holds residency (round 2); this closes its stated open question
(*"whether a detached `waitUntil` context stays resident"*) with the exact floating-promise
shape, and measures whether the Phase-3 re-arming `setTimeout` heartbeat (5 s ticks) is what
makes the difference.

**Method.** `experiment-residency-hold` (deployed 2026-08-28): a raw DO whose `fire(arm, ms)`
kicks `void #work(...)` and returns at once. Two arms on SEPARATE fresh instances, one run:
`held` (heartbeat re-arming every 5 s for the window) vs `control` (the identical single
`setTimeout(ms)` await, no heartbeat). Detector: in-memory `#bootId` + storage markers —
`finish` only lands if the floating await completed in the SAME isolate. The driver goes
SILENT for the whole window (any poll would reset the idle clock and rescue the control).

**Faithfulness note.** The mesh chain's detachment is a floating promise after the response
(`executeEnvelope`'s post-ack task; `waitUntil` is a DO no-op), so the raw-DO shape is the
same runtime shape with none of the mesh graph. One divergence to keep in mind: the control
arm's long await IS a timer, and a pending `setTimeout` may itself influence the runtime's
idle accounting — a real `env.AI` await is network I/O. If the control SURVIVES, that caveat
is one candidate explanation (alongside "the window exceeds the run length").

## Result (2026-08-28, two 4-minute runs, `ms=240000`)

**BOTH arms EVICTED, both runs — the heartbeat does NOT hold a detached DO resident.**
Neither arm's `finish` marker ever landed and every post-window `status` read found a fresh
`bootId`. The beat trace (run 2) puts a number on it: the held arm's last heartbeat tick was
**70 s** after start (`22:03:56.952 → 22:05:06.952`), then the isolate died with ~170 s of
the await still to run — a re-arming 5 s `setTimeout` buys roughly a minute, not a window.
Consistent with `plain-do-container` round 1 (a self-rescheduling `setTimeout` returned a
changed bootId after a 200 s silent window); that round's detector caveat does not apply
here, because the `finish` marker separates "reconstructed later" from "completed".

## What this changed in the build

- **The Phase-3 heartbeat was REMOVED, not shipped as insurance** — insurance that
  measurably does not insure is a false-safety artifact. The generation DEADLINE +
  single-flight latch stay (they guard against a hung await wedging the loop, and are
  validated in-lane).
- **What actually holds a Galaxy through a turn is the turn's own OUTBOUND I/O**: the
  `env.AI` fetch and the build's capnweb WebSocket are open network connections, and those
  hold a DO resident (`cf-long-stream-limits` — hazard-bounded, ≤15 min). The probe's
  timer-only await is exactly the shape that does NOT hold — and a codegen turn has no
  multi-second span that is timer-only.
- **An eviction mid-turn is covered as designed**: input is durable before the LLM runs,
  the in-memory latch dies with the isolate, and a fresh message starts a fresh generation.

## Guidance implication

`durable-objects.md`'s *"setTimeout/setInterval MAY be used only to keep a DO from
hibernating for up to a few minutes"* is generous against this measurement: **~70 s**
observed, deployed, n=1 with a consistent n=2 companion (run 1's held arm also died
mid-window). Treat a timer hold as ~a minute, and never as turn-length insurance.


## Round 2 (2026-10-01) — the `durable_object_io_tasks_prevent_eviction` default

**Question.** Cloudflare's [2026-10-01 changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-pending-io-keep-alive/)
says pending I/O, `ctx.waitUntil` promises and pending timers now keep a DO in memory after its
client disconnects, for up to 15 minutes per operation, by default from compatibility date
2026-10-01. Does that hold a detached await in the shapes Nebula uses — and what actually held
one before the flag?

**Method.** The same code deployed twice: `experiment-residency-hold` at 2026-10-01 and
`experiment-residency-hold-pre` at 2026-08-15, Nebula's date today (`wrangler versions view`
confirms both). Seven arms, each on its own fresh instance, all fired within ~3 s, then 285 s of
silence, then one status read. Window `ms=240000`. Round 2's new arms:

- `waitUntil` — the `control` timer await handed to `ctx.waitUntil` (mesh's post-ack shape).
- `binding` — a service-binding request to the sleeper's `/sleep`, pending for the window.
- `fetch` — a global `fetch()` to the sleeper's `workers.dev` URL, pending for the window.
- `fetchStream` — a `fetch()` whose body drips one byte every 5 s for the window.
- `ai` — a real `env.AI.run` on the Studio model (`max_tokens` 16 000).

A smoke pass at `ms=3000` ran first and every arm finished on both deployments; the `fetch` arm
returned `200 slept 2000`, not an error page, so same-zone `workers.dev` fetches work here.
A thrown await writes an `error` marker, so a failed call never reads as an eviction.

**Result — two full runs, 2026-10-01 12:40Z and 12:46Z.**

| Arm (detached, 240 s) | 08-15 run 1 | 08-15 run 2 | 10-01 run 1 | 10-01 run 2 |
|---|---|---|---|---|
| `control` (one timer) | evicted | evicted | held | held |
| `held` (timer + 5 s beat) | evicted, last beat 70.0 s | evicted, last beat 70.0 s | held | **evicted, last beat 120.0 s** |
| `waitUntil` | evicted | evicted | held | held |
| `binding` | evicted | evicted | held | held |
| `ai` | evicted | evicted | held 235 s ¹ | held 235 s ¹ |
| `fetch` | **held** | **held** | held | held |
| `fetchStream` | **held** | **held** | held | held |

¹ Workers AI answered `3046: Request timeout` at 235.4 s in both runs. The error marker was
written in the starting isolate, so the DO was still resident when the binding call ended — the
call failed upstream, not by eviction. A 16 000-token request is far past Nebula's 4 096.

**Timer replication (12:51Z, 10-01 only).** Run 2's `held` eviction prompted a third pass of the
timer arms alone, five instances each: **10 of 10 held**, every one finishing at 240 s in its
starting isolate. Across all 10-01 runs, the timer arms held **13 of 14**. The one eviction, at
120 s, is unexplained. It falls inside the 70–140 s idle window, which suggests idle eviction
rather than a host restart, but one case cannot tell the two apart.

Over every 10-01 run, 23 of 24 detached instances held for the full window.

**What it shows.**

1. **The flag does what the changelog says for every shape Nebula leans on.** `waitUntil`, a
   service binding and the `env.AI` binding all flip from evicted to held.
2. **Before the flag, a plain `fetch()` already held a detached DO**, streamed or not, both runs.
   That contradicts the `cf-long-stream-limits` memory and `tasks/backlog.md` § *keepAlive*,
   which say plain `fetch()` gets nothing. Both came from reading the docs in June; neither was
   measured until now.
3. **Before the flag, `ctx.waitUntil` on a DO really was a no-op** — it died exactly like
   `control`. The comment in mesh's `executeEnvelope` was right.
4. **Round 1's "What this changed" was wrong about the Galaxy turn in production.** It said the
   turn is held by "the `env.AI` fetch". Deployed Nebula takes the BINDING lane — neither the
   `nebula` nor the `test-nebula` worker has a `WORKERS_AI_TOKEN` secret, so `modelLane()` picks
   `env.AI` — and the binding did not hold at 08-15. So a deployed turn ran exposed from ~70–140 s
   after its triggering request, except while a build held its outbound capnweb WebSocket (the
   2026-06-19 TCP/WebSocket shield). Unmeasured: a STREAMED binding response, which is what
   deployed turns make (`onDelta` is always wired). Whether any deployed turn actually died this
   way is unchecked.
5. **The round-1 heartbeat removal stands** — a timer never held at 08-15 (n=4 with round 1).
   At 10-01 a timer mostly holds, but that is not a reason to bring the heartbeat back: what
   the turn needs held is its I/O, and that is now held directly.

**What it changes in the build.** Bump Nebula's `compatibility_date` to 2026-10-01. Hand the
floated turn to `ctx.waitUntil` too. Today, at 10-01, the turn would be held by whatever happens
to be pending, including the deadline timer. `waitUntil` makes the hold a stated property of the
call: it covers the whole turn from its start, and the 14-minute generation deadline sits under
the 15-minute cap. This is not because `waitUntil` measured more reliable than a timer: 2 of 2
against 13 of 14 distinguishes nothing.
