# residency-hold — does the heartbeat hold a DETACHED turn resident? (deployed)

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

