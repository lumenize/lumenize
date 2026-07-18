---
paths:
  - "packages/mesh/**/*.ts"
  - "apps/nebula/**/*.ts"
  - "**/Dockerfile"
---

# Working with a Container (and the DO it's attached to)

Cloudflare Containers pair a container instance with a **companion Durable Object**. This file is the
durable *platform* truth: the mental model, the state machines, and what is verifiable where. How that
DO *communicates* is still [mesh.md](mesh.md); how to write it as a DO is still
[durable-objects.md](durable-objects.md). Our current container **policy** (what we're building right
now) lives in the task files — this file should outlive them.

## The mental model — the companion DO is a full DO, not a proxy

**The attached DO is a full-fledged Durable Object that can do real work, *plus* it has a container
attached.** Read that twice; nearly every hard-won lesson below follows from getting it wrong.

The tempting design — and the one an LLM will propose, because it looks like separation of concerns —
is a thin companion DO that only proxies calls, with the real logic in a sibling DO next door. **Don't.**
A sibling calling into the container's DO means orchestrating **three independent state machines at
once**: the sibling DO (asleep/awake) × the companion DO (asleep/awake) × the container's own lifecycle
(below). Waking all three in the right order, on a cold start, under retry, is where the wedges and the
brittleness live. Collapsing the sibling's logic *into* the companion DO dissolves that whole class of
problem — there's no cross-node wake to coordinate, because there's no cross-node hop.

Three corollaries worth internalizing:

- **The DO has time to spare.** Container work runs ~**300 ms–3 s** per call, and it's a *network*
  await from the DO's perspective — it opens the input gate. That leaves the DO thread almost entirely
  free to be the hub: call AI, call other DOs, orchestrate, serve. Keep the *heavy/native* compute in
  the container and the *light orchestration + gate-yielding awaits* on the DO thread.
- **A container is a platform, not a binary.** Don't model it as "one process this DO can invoke."
  It's a general compute box that can do many jobs — a supervisor on one port plus whatever else you
  need on others. Our image runs a command-server (PID 1) that spawns and manages the real workload.
- **Put the hub in the companion DO** and it's exactly **one hop** from the outside world and **one hop**
  from the container. That's the whole point.

Vertical scale is available (`instance_type`) if one tenant ever needs it, so a tenant-sharded system
can comfortably let its single container do everything that isn't a good fit for JS/WASM.

## The state machines

**Container instance** (the CF-side truth):
`absent` → `provisioning` (HTTP **503**, no instance available yet) → `starting` → `healthy` →
`stopped`/`gone`. Plus two off-path states that matter enormously:
- **crash-on-boot** — a bad image / crashing entrypoint. Surfaces as `Failed to start container`.
- **frozen** — process alive but unresponsive. **This is the stuck state.** ⚠️ See below.

**What `ctx.container` natively exposes is ONE boolean, `.running`** (plus methods: `start`, `monitor`,
`destroy`, `getTcpPort`, `exec`, …). There is **no native `state`/`status`** — the `state.status` enum
(`'healthy'`, …) is a `@cloudflare/containers` **base construct** layered on top, precisely *because
`.running` alone isn't enough*. ⚠️ **`.running` is monitor-gated: it updates only if you attach
`ctx.container.monitor()`.** Without a monitor it is effectively write-once-`true` — it stays `true`
forever after the container dies (kill / stop / freeze), so a drive that gates on `.running` wedges on
every death. The base self-heals on a killed container *precisely because* it attaches the monitor for
you — that's **load-bearing, not sugar**. **So: attach `monitor()`, and decide liveness by a health
probe, never by `.running` alone.** (All confirmed native to raw `ctx.container`, reproduced with no base
class — `experiments/plain-do-container`.)

**Companion DO**: `awake` | `hibernating` | `evicted`.

## ⚠️ The `running` × `status` trap — the one bug class to know

`startContainerIfNotRunning()` reads **only** `running` and never consults `state.status`:
`if (this.container.running) return 0` — it returns *without starting*. So a **stale `running: true`**
(instance dead or frozen, flag never flipped) means the DO **refuses to launch a replacement**, and every
`containerFetch` fails fast (500 `not running` / `suddenly disconnected`) or **hangs** to the port timeout.
`stop()` guards on `running`; `destroy()` doesn't write the flag either — **so `destroy()` + retry does
not clear it**; and **`start()` throws `"cannot be called on a container that is already running"`** on a
stale-`true` flag, so you can't force a fresh one past it. No number of same-DO-lifetime retries helps.
This trap is **native to `ctx.container`**, not a base bug — the base's `startContainerIfNotRunning()`
merely inherits it by gating on the native flag; a raw drive that gates on `.running` wedges identically.

**The vicious cycle:** every proxy attempt calls `renewActivityTimeout()` + `inflightRequests++`, and
idle-eviction is the *only* natural clear in the cloud — so a reload/reconnect storm **prevents** recovery.
A "helpful" auto-reloading waking page makes it strictly worse (that regression shipped once).

**`ctx.abort()` is the forced idle-evict** — mechanic proven on real CF (abort → DO reconstructs →
re-reads `running` **from reality** → next fetch boots fresh). Whether we *use* it is current policy,
in flux, and lives in the task files — don't infer the policy from this paragraph, and if you persist
anything before an abort, see [durable-objects.md](durable-objects.md) § Persist before `ctx.abort()`.

**cold ⊋ stuck** — every stuck response is cold, but cold is strictly bigger. `429`/`503`/`502`,
provisioning, and **`Failed to start container`** are cold-but-**not**-stuck. Never force-reset on
crash-on-boot: abort → recrash → abort is a loop. `apps/nebula/src/dev-container.ts` holds the two
predicates (`isContainerColdResponse` ⊋ `isStuckFlagResponse`) and is the de-facto spec.

## What is verifiable where — do not over-trust a green local run

- **`docker kill` / `docker stop` self-heal — *only with a monitor attached*.** The monitor is what lets
  the runtime flip `running` → false when it sees the instance leave; then the next call boots a fresh
  instance (~1.4 s), and concurrent bursts coalesce to one start. **Without a monitor, `.running` stays
  stale-`true` and even a cleanly-killed container wedges** (confirmed on the raw API).
- **`docker pause` is the only local wedge** — it freezes the process with `running` still `true`, a
  faithful analog of the cloud's stale flag. It reproduces the **mechanism**, *not* the **trigger**.
- **The stuck state is cloud-only and rare.** It has never reproduced off-prod — not locally, not on a
  deployed throwaway harness. The real trigger is a deploy/eviction race. ⇒ **A stuck-flag fix can only
  be validated deployed**, and local green proves the common path, not this one.
- **Container behavior must be verified under `wrangler dev` + Docker *before* deploying** — it does run
  there. (Pure-UI changes stay build-verified.) Broken container changes have shipped twice from skipping this.

## Local dev

- **Docker Desktop, not Colima** — the variable is the container *engine*; Colima's macOS-VF networking
  can't sustain the workerd↔container(↔sidecar) connection.
- **`wrangler dev` with NO `--local`** — `--local` + a container hangs after the image build (workerd
  listens, never becomes ready). Recovery: `pkill -9 -f workerd`, then `rm -rf .wrangler`.
- **`extends Container` cannot be constructed under vitest-pool-workers** (`ctx.container` is undefined →
  the *base ctor* throws). ✅ **The fix is to not extend it.** Any DO drives a container via **raw
  `ctx.container`**, and a plain DO that touches `ctx.container` only in methods (never the constructor)
  **constructs + unit-tests fine** under pool-workers — `ctx.container` is simply `undefined` there, so
  guard container methods with `if (this.ctx.container)`. The raw path **restores** the unit-testability
  `extends Container` forfeits; the thin-shell discipline becomes a nicety, not a workaround.
  (`experiments/plain-do-container` Q1; `packages/mesh/test/container/precheck.test.ts` stays the canary
  for the base itself.)
- **`wrangler delete <worker>` does NOT delete the container app or its running instances** — they linger
  and eat the account's running-instance quota, which then blocks *new* containers from starting. Clean up
  with `wrangler containers list` / `wrangler containers delete <app-id>`.

## The `Container` base is optional — drive raw `ctx.container`, steal the base's homework

You do **not** have to `extends Container`. Any DO drives a container through raw `ctx.container`, and
that's the preferred path: it restores pool-workers testability (above) and frees the DO to compose the
mesh core normally. `@cloudflare/containers` is open source — **read it and copy its patterns** rather
than inherit its lifecycle. A correct raw drive replicates:

- **Attach `ctx.container.monitor()`** — the single source of truth for "the container exited," and the
  thing that keeps `.running` honest. **Mandatory** (see the state machines); without it you wedge on
  every container death.
- **A readiness poll with a timeout**, not an open-ended wait — and fail *loudly* if a port never comes
  up (a crashed entrypoint is a bug to surface, not a hang to sit in).
- **Serialize lifecycle transitions** — `blockConcurrencyWhile` around start/stop, plus an in-flight-start
  latch so concurrent callers coalesce onto one `start()` instead of racing a second.
- **Set `envVars` before `start()`** — the container reads them at *start*, not at construction.

**On the raw path the `extends Container` frictions disappear:** there is **no base alarm loop**, so
`svc.alarms` / `svc.sql` / `svc.broadcast` are **free to use**. The old "never `svc.alarms` on a container
node; route scheduling through `Container.schedule()`" constraint was an artifact of inheriting the base's
perpetually-armed alarm — **gone** on a plain-DO container host. `onStart` is likewise yours (or just do
lazy construction in a first-use getter).

## Keeping the companion DO alive — you usually don't need to

- **Waking a hibernated/evicted DO is ~free** (~0.3 s, dominated by network RTT — measured after a full
  idle-and-evict). Don't spend effort keeping the DO warm between calls; let it hibernate.
- **An in-flight request keeps the DO resident on its own** — idle-eviction doesn't fire while a request
  (e.g. a long `await`) is open; a long operation stays on the *same* isolate for its whole duration.
- **A periodic alarm does NOT preserve a running isolate.** An alarm that fires after an eviction
  *reconstructs a fresh isolate* — it can't keep an in-memory operation (a streaming model call, say)
  alive across an eviction. So a keep-warm heartbeat is the **wrong tool** for preserving in-flight work:
  that work must run inside an in-flight request, or be checkpointed and resumed.
  (`experiments/plain-do-container` Q4.)

## Cost / sizing

**Stopped containers cost $0** — charges start when it runs, so idle tenants are free and `sleepAfter`
trades idle cost against user-visible cold starts. **Cold start is image-dependent** (~1–2 s for a small
`node:22-slim` image; the ~3.2 s local / ~4.1 s deployed figures were a heavier vite image) — hide it
(pre-warm speculatively) rather than fight it.
A keep-warm DO is ≈ **$4/mo**. ⚠️ **Watch vCPU starvation:** on the default `basic` (¼ vCPU), a heavy build
saturates the CPU and **starves the other ports** — a trivial command on the side channel degraded from
~30 ms to seconds during a build, recovering only once idle. Size up (`instance_type`) before blaming the
channel.
