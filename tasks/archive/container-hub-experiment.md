# Experiment: raw `ctx.container` — stuck-state origin & keep-alive (gates the Galaxy collapse build)

> **✅ COMPLETE + ARCHIVED (2026-07-17) — frozen record.** The `plain-do-container` spike ran; findings live in
> [`experiments/plain-do-container/RESULTS.md`](../../experiments/plain-do-container/RESULTS.md) (Q3 stuck-is-**native** + `monitor()`-mandatory,
> Q4 keep-alive, lifecycle numbers) and the draft blog `website/blog/2026-07-17-rules-of-cloudflare-containers/`.
> **Recommendation to the Galaxy collapse:** the **ephemeral build-box** — pre-warm on codegen-start, `destroy()` after build — which retires
> container keep-alive / heartbeat / `ctx.abort()`-recovery. **Descoped** (not needed for the collapse, per Larry): the NebulaDO/mesh residency
> test + the deployed stuck-trigger. **Now the collapse's, not the container's:** codegen residency (in-flight vs detached `setTimeout` — a mesh
> concern; the heartbeat is *not* a valid fix, Q4). Below is the frozen experiment spec.

**Status**: Design complete — ready to run. Phases tagged **Exploratory** (real-infra, empirically discoverable).
**Role**: the **hard gate** on the Galaxy collapse *implementation* ([nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md)) — Larry gates starting that transcription until this finishes. It's the standing **"keep-fed" parallel task**, and that parallelism already paid off: poking at the alarm conflict *here* is what surfaced the `ctx.container`-on-any-DO discovery *there*.
**Builds on**: `experiments/plain-do-container/` (the Q7 spike, 2026-07-17) — **do not re-derive its results, extend them.** Its RESULTS.md is the home for the new findings (Q3–Q5 below).
**Code location**: continue in `experiments/plain-do-container/` (proven scaffold: Dockerfile, `wrangler.jsonc`, harness). *(Task-file name is legacy — the parent links to it; the code lives in the plain-do-container dir.)*

---

## What we now know — so this starts from a clean slate, not the old file

`plain-do-container` proved the model the old version of this file was built on is dead:
- **Any DO can attach a container via raw `ctx.container`** — no `extends Container`. Drives in ~10 lines (`start()` → `getTcpPort()` → `port.fetch()`); the base helper's sugar is **not load-bearing**. Verdict there: **GO plain `NebulaDO`.**
- **Constructs + unit-tests under vitest-pool-workers** (`ctx.container` is `undefined` there; guard with `if (this.ctx.container)`), *restoring* the testability `extends Container` forfeits.

So, deleted from scope by construction:
- **`extends Container` / `LumenizeContainer` / `NebulaContainer`** — the collapse extends `NebulaDO`; `LumenizeContainer` is being removed from Mesh. This experiment uses **plain `NebulaDO` (or bare `DurableObject` for the raw-mechanism arms) + raw `ctx.container`**.
- **The base-owned-alarm-slot conflict** (old finding M4) — **gone**: no `Container` base, no rolling keep-alive loop to clobber. The alarm slot is ours (`svc.alarms`).
- **`can't-construct-under-pool-workers`** — **relaxed**: DO logic is unit-testable; only the container *drive* needs `wrangler dev`+Docker / deployed.
- **Throughput isolation (old C2)** — **settled by reasoning** (separate microVM; sibling-noise floor, Larry). **Cut** (see below).

---

## The gate — what must be true before the collapse build starts

1. **Stuck-origin verdict** (Q3): base-library artifact → the collapse needs **no** recovery machinery (just don't replicate the culprit); native to `ctx.container` → it needs recovery, and we know what clears it.
2. **A proven keep-alive primitive** (Q4): demonstrably holds a `NebulaDO` resident across the **70–140s** window through a long *silent* `env.AI`-shaped await — with its mechanism (alarm vs `setTimeout`) and cost pinned.
3. **A proven raw-`ctx.container` drive module** (Q0): `build(source) → dist` end-to-end, the thing `galaxy.ts` transcribes.
4. **The base keep/reject table** (Q5): what of `@cloudflare/containers` to mimic vs avoid when we build our own drive.

When those four land, the "mostly-transcription" collapse build is de-risked. **These are the deliverables *and* the collapse's building blocks — the same hardened artifacts.**

---

## Q0 (Phase 0) — HELPER: the raw-`ctx.container` drive module — **Exploratory**

**Goal**: the real drive, not the ~10-line ping — `start-if-not-running` + readiness poll + `build(source)` exec + `dist` retrieval + idle-stop, over raw `ctx.container` on `NebulaDO`.

**Success criteria**:
- [ ] On `experiments/plain-do-container/` (extend it): a `NebulaDO`-based DO drives a real `build(source) → dist` under `wrangler dev` + Docker (Desktop, not Colima; `wrangler dev` **without** `--local`).
- [ ] Confirm the **2-port pattern** the build-box needs — a build/command channel on a 2nd port via `getTcpPort(9000)` alongside the app port — works on the raw API.
- [ ] Toolchain floor: the dir's `package.json` pins **`wrangler ≥ 4.111`** and registers the DO via **`exports` … `storage: "sqlite"`** (never `migrations`; a copied `^4.86` scaffold silently mis-handles `exports`).
- [ ] Deliverable: the drive module, ~50–100 lines, structured to lift into `galaxy.ts`.

## Q3 (Phase 1a) — UNKNOWN: is the stuck state a base artifact, or native to `ctx.container`? — **Exploratory**

*The single most decision-relevant question.* The stuck wedge ([[cf-container-stuck-flag-cloud]]) lived in `@cloudflare/containers`' `startContainerIfNotRunning` fast-path gating on `this.container.running`. Our own drive doesn't run that code.

**Method**: on the Q0 drive, inject the stuck scenarios — **`docker pause`** (local, the mechanism analog) and **deploy-while-running** (deployed, the real cloud trigger; WARP on, `wrangler containers delete` between runs). First **confirm the stuck signature is actually present** (an external probe returning the wedged behavior) — a run where nothing wedged is *inconclusive, not a clean pass*.

**Capable-of-failing verdict**:
- [ ] **Base-caused**: the raw drive does **not** reproduce a wedge where the base library did → the collapse skips recovery machinery (and we deliberately avoid the fast-path pattern). *(This is a real, falsifiable outcome — it reds if the wedge reappears.)*
- [ ] **Native**: the raw drive **does** wedge → recovery is required; hand off to the conditional "what clears it" below.
- [ ] Recorded in `plain-do-container/RESULTS.md` as Q3, and — because it bears on an always-loaded rule — **`.claude/rules/containers.md` is updated** (the stuck-flag section is currently written around the `Container` base; this says whether that scope is right).

## Q5 (Phase 1b, desk — runs alongside Q3) — UNKNOWN/DESIGN: dissect the base → keep/reject table

Read `@cloudflare/containers` `container.js` (the alarm loop, `running`-flag tracking, the `startContainerIfNotRunning` fast-path, the monitor, `sleepAfter`, the `onStart/onStop/onActivityExpired/onError` hooks) and decide **per behavior: mimic, replace, or avoid** in our own drive.

**Deliverable**:
- [ ] A `behavior → keep/reject/replace + why` table in RESULTS.md. It's the *mechanistic* partner to Q3's *empirical* answer: if Q3 is "base-caused," the fast-path is the thing we deliberately don't replicate; if "native," we steal the base's recovery approach. Reading + a table — cheap, no spike.

## Q4 (Phase 2) — HELPER + UNKNOWN: the keep-alive primitive, and does it defeat idle-eviction? — **Exploratory**

Now clean (no base loop to fight). This retires the backlog `keepAlive` item with a proven artifact.

**Method**: a self-rescheduling `svc.alarms` wrapper (≤60s, under the 70s floor) on `NebulaDO`; drive a **simulated long silent await** (an `env.AI`-shaped gap with no incoming events); measure survival with the **silent-window single-terminal probe** (the one old methodology finding that *survives* the base-class change — it's base-independent): the prober sends **ZERO** requests for the full window (a mid-window poll is itself an incoming event that resets the eviction clock → guaranteed false-PASS), then fires **ONE** terminal probe whose **own response latency** is the signal (cold ≈ evicted, warm ≈ survived).

**Success criteria** (all **deployed**, external observer — `Date.now()` is pinned in-DO, `feedback_cf_clock_traps`):
- [ ] The alarm arm holds the DO resident past 70–140s vs a **bare control** that doesn't → capable-of-failing.
- [ ] **Q4b — `setTimeout` arm** (cheap add): does a self-rearming `setTimeout` *also* reset the eviction clock, or only an alarm (an incoming event)? Determines the **simplest correct** keep-alive and answers the collapse's Phase-5 heartbeat mechanism directly.
- [ ] Deliverable: the keep-alive primitive, with mechanism + cadence + cost pinned.

---

## Conditional / follow-on (do NOT pre-build)
- **If Q3 = native: what clears the stuck state?** (`destroy()+start()` / re-fetch / idle-eviction / abort) — only if Q3 wedges; otherwise moot.
- **DO-awake / container-asleep steady state + re-drive** — does keeping the DO warm while the container idle-stops, then re-driving on the next build, work cleanly? Fold in as a cheap check on the Q0/Q4 harness, not a pillar.
- **Cheapest correct keep-alive** — tune cadence/cost once Q4 establishes *what* works.

## Explicitly cut (don't re-add)
- **Throughput isolation** — settled by reasoning (separate microVM, sibling-noise floor). At most one throwaway baseline-vs-under-load sanity delta *if free* while a harness is up; **no** N-rep cross-placement characterization.
- **Three-way wake latency** — the container is off the read path now (viewing waits only on Galaxy + Star), so it barely affects UX. Keep only the **DO-wake** number as a free byproduct of Q4 (informs how warm to hold); drop container/both-cold latency.

---

## Traps (the base-independent methodology that survives)
- **Silent-window on the eviction probe** — arm → **silence for the whole window** → **one** terminal latency probe. A mid-window poll resets the clock and guarantees a false "survived."
- **Clock trap** — external observer only; never in-DO `Date.now()`. The existing benchmark harness already is one.
- **Deployed is mandatory** for the cloud stuck trigger (Q3 deploy-while-running) and the eviction measurement (Q4); local maps mechanism, not trigger.
- **Ops** — WARP on to deploy the image; `wrangler containers delete <app-id>` between deployed runs (lingering instances eat the running-instance quota).
- **Docker Desktop, not Colima**; `wrangler dev` **without** `--local`.

## Notes
- **Throwaway** per `workflow.md` § Experiments — findings live in `plain-do-container/RESULTS.md`; prune from `workspaces` + `git rm` once captured. Durable subset updates **`.claude/rules/containers.md`** (Q3/Q5 rescope its Container-base framing to raw `ctx.container`) and hands the collapse its **drive module + keep-alive primitive**.
- **No hand-review pass** (experiment — Larry runs it, and the results raise the next round). Expect Q3/Q4 to surface follow-ons.
- Serves **ADR-014** (companion DO is the hub) — but note the hub is now a plain `NebulaDO` with an attached container, not a `Container` subclass.
