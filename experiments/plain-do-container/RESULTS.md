# RESULTS — plain-DO + raw `ctx.container` spike (Q7)

Ran 2026-07-17. Toolchain mirrored from `packages/mesh` (pool-workers **0.18.5**, vitest **4.1.10**,
wrangler **4.111.0**), installed isolated in this dir (`--no-save --no-package-lock`) so the root
lockfile was never touched (parallel toolchain work was in flight).

## Q1 — construct + unit-test under vitest-pool-workers → **YES (decisive)**

A `DurableObject` subclass that (a) is the target of a `containers` binding but (b) does **NOT**
`extends Container` and (c) touches `ctx.container` only in methods, never the constructor:

- **Constructs and runs methods under pool-workers.** `2/2` tests pass — `stub.ping()` returns, i.e.
  the DO instantiates without the failure `extends Container` hits (`[[container-no-construct-pool-workers]]`).
- **`ctx.container` is `undefined` under pool-workers** (`{"hasContainer":false,"startType":"undefined"}`).
  This is the *clean* outcome: the DO's non-container logic is fully unit-testable, and only the
  container-driving methods (which read `ctx.container`) are absent — they simply aren't exercised in
  pool-workers (guard with `if (this.ctx.container)` or don't call them in unit tests).

**Interpretation:** the hypothesis holds — `extends Container`'s construction failure comes from *its
constructor* touching container APIs, not from the mere presence of a container binding. So the
**plain-`NebulaDO` + raw `ctx.container`** path RESTORES the pool-workers unit-testability that
`extends Container` forfeits. This is the load-bearing win for Q7.

## Q2 — drive the container via raw `ctx.container` under `wrangler dev` + Docker → **YES**

Under `wrangler dev` (image built locally + `cloudflare/proxy-everything` pulled, server on :8787):
- `/present` → `{"hasContainer":true,"startType":"function"}` — `ctx.container` is **live** here (contrast pool-workers: `undefined`).
- `/drive` → `OK(200): container-ok` — the plain DO drove the full path with **no `Container` helper class**:
  `ctx.container.start()` → `ctx.container.getTcpPort(8080)` → `port.fetch('http://container.local/')` → 200 + body.

The driving code (`driveContainer` in `src/plain-container-do.ts`) was **~10 lines**: start-if-not-running +
a bounded readiness poll + fetch. So the "~50–100 lines of lifecycle" estimate for a real build-box (add:
build-command exec, `dist` retrieval, optional idle-stop) is confirmed **real-and-small**, and the `Container`
helper's sugar is **not load-bearing** for our use.

## Bearing on Q7 (task: nebula-galaxy-collapse-and-chat.md) → **GO plain `NebulaDO`**

Both gates pass. Combined with the CF docs blessing `ctx.container` on any DO, the plain-`NebulaDO` path:
- **constructs + unit-tests under pool-workers** (Q1) — restores testability `extends Container` forfeits;
- **drives the container fine via the raw API** (Q2) — the helper class isn't needed;
- therefore keeps **`svc`** (→ dissolves chat-fanout **Q4**), gets **`svc.alarms`** (no `.schedule()` conflict),
  and stays a uniform full `NebulaDO` — for ~50–100 lines of lifecycle.

**Recommendation to the task: flip Q7 from "lean" to decided — Galaxy = plain `NebulaDO` + raw `ctx.container`;
retire `LumenizeContainer` as Nebula's node (revisit whether it survives as an MIT-framework offering).**

## Q3 — is the stuck state a `@cloudflare/containers` artifact, or native to `ctx.container`? → **NATIVE** (2026-07-17)

Instrumented `src/plain-container-do.ts` (`/inspect`, `/probe`, `/running`, `/force-start`, `/attach-monitor`, `/recover`) and drove fault injection under `wrangler dev` + Docker Desktop. External `curl` timing (clock trap).

**The raw `ctx.container` surface** (`/inspect`): a boolean **`.running`** + methods `start, monitor, destroy,
signal, getTcpPort, setInactivityTimeout, interceptOutbound{Http,Https}, interceptAllOutboundHttp,
snapshot{Directory,Container}, exec`. **No `state` / `getState` / status** (`stateType: undefined`) ⇒ the
`state.status` "second variable" in `containers.md` is a **base-library** construct (`this.state`), not native.
On the raw API **`.running` is the only lifecycle signal.**

**`.running` is monitor-gated, not free:**

| Fault | `monitor()` attached? | `.running` after | Port | Result |
|---|---|---|---|---|
| `docker kill` / stop (instance **gone**) | yes | → **false** in ~2 s | rejects | next `start()` boots fresh → **self-heal** ✅ |
| `docker pause` (frozen, **present**) | yes | **stays true** (5×2 s) | **hangs** | `.running`-gated drive **wedges** — the genuine stuck state ✗ |
| any death | **no** | **stays true** ≥12 s | hangs/rejects | wedge on *everything* ✗ |

Two hard constraints:
- **`start()` throws `"cannot be called on a container that is already running"`** while `.running` is stale-true
  ⇒ **you cannot force-start past a stale flag**; you must make `.running` accurate first.
- **`destroy()` does not flip `.running`** on a paused/present container locally, and `destroy()+start()` does
  **not** clear a frozen-present wedge locally (matches `containers.md`).

**Verdict — the stuck mechanism is NATIVE to `ctx.container`, not a base artifact.** The `.running` + `monitor()`
+ frozen-wedge semantics are the platform's; `@cloudflare/containers` is a faithful wrapper. Crucially, the
base's *self-heal on kill is also not automatic* — it depends on the base attaching `monitor()`. Our naive
~10-line Q2 drive omitted `monitor()`, so it wedged on kill **and** pause. ⇒ **plain-`NebulaDO` does NOT dissolve
the stuck risk** — it inherits the same semantics and must handle them.

## Q5 — dissect the base, keep/reject for our own drive (2026-07-17)

`@cloudflare/containers/dist/lib/container.js` read against the Q3 evidence:

| Base behavior (`container.js`) | Verdict | Why |
|---|---|---|
| `monitor()` attached in start/fast-path (`:1298`) | **KEEP — MANDATORY** | The subscription that keeps `.running` honest; without it `.running` never updates → wedge on every death. **Not sugar** (Q3). |
| `.running`-gated fast-path (`if (this.container.running) return 0`, `:1297`) | **KEEP — only *with* the monitor** | Safe only because the monitor keeps `.running` accurate for gone-instances. |
| `startInFlight` start-coalescing (`:1293`) | **KEEP** | Prevents double-start races; cheap. |
| readiness poll in `doStartContainer` | **KEEP** | Our drive already does the bounded port-fetch retry. |
| **health-probe as liveness** (ours, new) | **ADD** | `.running`(+monitor) detects *gone*; only a bounded probe detects *frozen*. Drive liveness off the **probe**, not `.running` alone. |
| stuck (frozen) recovery | **DEFER — deploy-only** | Not DO-side recoverable (can't `start()` past a stale flag; `destroy()` doesn't clear present-frozen). Cloud clear = idle-evict / `ctx.abort()`. |
| alarm keep-alive loop (`:1502`; re-arm ≤3-min while running, stop on `!running`/activity-expiry) | **REPLACE with `svc.alarms`** | Plain `NebulaDO` doesn't inherit this loop — **Q4** builds our own. The base pattern (a *firing* alarm = an incoming event that holds the DO resident, bounded by activity) is the **model**. |
| `sleepAfter` / `onActivityExpired` idle-stop | **MIMIC if wanted** | The build-box auto-stop lever. Optional. |
| `state`/`state.status` health abstraction | **OPTIONAL** | Convenience over `.running`+monitor+probe; the primitive is those three. |

## Bearing on the collapse

1. **The plain-`NebulaDO` drive MUST attach `ctx.container.monitor()`** — the #1 must-do for `galaxy.ts`; omit it and the DO wedges on every container death.
2. **Drive liveness off a bounded health-probe, not `.running` alone** — even with the monitor, `.running` can't see a frozen container.
3. **With monitor + probe, `kill`/`stop` faults self-heal** (~1.4–2 s) — most faults handled cleanly.
4. **Plain-`NebulaDO` did NOT retire the `ctx.abort()`-deletion question.** The genuine stuck state (frozen / cloud deploy-stale) is native, still exists, and is still only clearable by idle-evict / abort — **deploy-verifiable** (the collapse's deploy-while-running row / a deployed Q3). Local `docker pause` proves the *mechanism*, not the *cloud clear*.

## `containers.md` correction (durable subset — fold in when the collapse lands)

The rule frames the state machine around the `Container` base; Q3 shows the load-bearing facts are **native to
`ctx.container`** and belong regardless of base: (a) `.running` is **monitor-gated** — attach `monitor()` or it
never updates; (b) the raw API has **no `state.status`** (base construct); (c) `start()` **throws** on a
stale-running instance; (d) the frozen/stuck case is native + deploy-only-recoverable. The rule's "Capabilities
the `Container` base owns" section over-attributes to the base what is actually platform.

## Q4 — does anything keep the DO resident across a long silent gap? (deployed, 2026-07-17)

Detector = `#bootId` (in-memory, changes on eviction + reconstruction), silent-window single-terminal probe.

**Round 1 — idle keep-alive (flawed detector, one clean finding).** Armed a self-rescheduling `setAlarm` (45s), a self-rescheduling
`setTimeout` (5s), and a bare control; 200s silent; all three returned a CHANGED bootId ("evicted"). ⚠️ Caveat: `#bootId` conflates
"evicted and stayed dead" with "evicted and **reconstructed by the alarm**" (an armed alarm persists through eviction and wakes a fresh
isolate), so it can't score the alarm pass/fail. **The finding that survives the flaw:** a periodic alarm/`setTimeout` does **not** keep a
DO *continuously resident* — it wakes a **fresh isolate**, so it cannot preserve a mid-await heap.

**Round 2 — the real question: does a long IN-FLIGHT await keep the DO resident? → YES.** A single `/long-await?ms=180000` (pure timer
await, no keep-alive armed) returned the **same** `bootId` after 180s. **Idle-eviction does not fire while a request is in flight** — a long
`env.AI`-shaped await holds the DO resident on its own.
- ⇒ **The Phase-5 "can't hibernate mid-stream" heartbeat is unnecessary for eviction-prevention** — *if* codegen runs inside an in-flight request.
- ⚠️ **Open for the collapse:** chat is fire-and-forget continuations (ADR-003 — no reply channel held across a hop), so Galaxy may process
  codegen **detached** (`waitUntil`/continuation), not holding an open request. Whether a detached `waitUntil` context stays resident is the
  same question the mesh continuation spike flagged — settle it on the **NebulaDO/mesh** harness.

## Lifecycle numbers (deployed, 2026-07-17)

- **DO wake ≈ free.** After 220s idle + full eviction (bootId changed), reconstruct-and-respond = **0.31s**, indistinguishable from the warm
  baseline (0.41s) — pure network RTT. **Keeping the DO unhibernated buys nothing.**
- **Container cold start ≈ 2s** (fresh drive, this tiny `node:22-slim` image; the ~4s in `containers.md` was the heavier vite image).
  Image-dependent — Nebula's build-box will be closer to this.
- **Container does NOT linger through a multi-minute idle.** Clean single-container re-test: 220s idle → the container is stopped
  (`running:false`, "not running, call start()") and the DO had evicted. The mechanism — the container's own idle-stop vs teardown-with-DO-
  eviction — isn't cleanly separable from outside (probing either resets the DO clock or touches the container), but both point the same way
  for the design: **containers don't linger, so there's nothing to keep warm.** *(The first attempt's "30s cold start" was a `max_instances: 1`
  collision artifact — discarded.)*

## Design recommendation for the collapse — the EPHEMERAL build-box (Larry, 2026-07-17)

The numbers point at a model that **dissolves** the hard problems rather than managing them:

- **Speculatively pre-warm the container when codegen begins.** `start()` is async/non-blocking; the ~2s boot overlaps LLM composition +
  file-writes, so it's warm by the time there's source to compile. Cold start is hidden, not fought.
- **Ephemeral per build — `destroy()` after compile + deliver.** A fresh container per build has no accumulated state to go stale, so the
  native frozen/stuck wedge (Q3) is sidestepped by construction, and there's nothing to keep warm. `destroy()` on a *healthy* container is
  clean (Q3's trouble was only the frozen one).
- **This makes the keep-alive / heartbeat / stuck-recovery machinery largely moot** on both sides: the container is mounted per-call (not
  kept warm), and the DO wakes for free and is resident during a turn (Q4, modulo in-flight-vs-detached). **The `ctx.abort()`-deletion
  anxiety in particular evaporates — you never keep a container long enough to get stuck.**

## Incidental finding (not new to the repo)

pool-workers **0.18.x changed its config API**: the old `import { defineWorkersConfig } from
'@cloudflare/vitest-pool-workers/config'` is gone; it's now `import { cloudflareTest } from
'@cloudflare/vitest-pool-workers'` used as a **vite plugin**. The repo already adopted this
(`packages/mesh/vitest.config.js`); noted here only because the old form cost two failed runs.

## Incidental finding (not new to the repo)

pool-workers **0.18.x changed its config API**: the old `import { defineWorkersConfig } from
'@cloudflare/vitest-pool-workers/config'` is gone; it's now `import { cloudflareTest } from
'@cloudflare/vitest-pool-workers'` used as a **vite plugin**. The repo already adopted this
(`packages/mesh/vitest.config.js`); noted here only because the old form cost two failed runs.
