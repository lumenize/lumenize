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
is a thin companion DO that only proxies calls, with the real logic in a sibling DO next door. **That
MUST NOT be built.** A sibling calling into the container's DO means orchestrating **three independent
state machines at once**: the sibling DO (asleep/awake) × the companion DO (asleep/awake) × the container's own lifecycle
(below). Waking all three in the right order, on a cold start, under retry, is where the wedges and the
brittleness live. Collapsing the sibling's logic *into* the companion DO dissolves that whole class of
problem — there's no cross-node wake to coordinate, because there's no cross-node hop.

Three corollaries worth internalizing:

- **The DO has time to spare.** Container work runs ~**300 ms–3 s** per call, and it's a *network*
  await from the DO's perspective — it opens the input gate. That leaves the DO thread almost entirely
  free to be the hub: call AI, call other DOs, orchestrate, serve. The *heavy/native* compute SHOULD stay
  in the container and the *light orchestration + gate-yielding awaits* on the DO thread.
- **A container is a platform, not a binary.** It MUST NOT be modelled as "one process this DO can invoke."
  It's a general compute box that can do many jobs — a supervisor on one port plus whatever else you
  need on others. Our image runs a command-server (PID 1) that spawns and manages the real workload.
- **Put the hub in the companion DO** and it's exactly **one hop** from the outside world and **one hop**
  from the container. That's the whole point.

Vertical scale is available (`instance_type`) if one tenant ever needs it, so a tenant-sharded system
can comfortably let its single container do everything that isn't a good fit for JS/WASM.

## ⚠️ There is NO source-push step — the container's `/workspace` IS the DO's tree

**`@cloudflare/computer`** (the successor to `@cloudflare/shell`; its migration doc renames
`workspace.shell.exec` → `workspace.runtime.exec`) makes a `Workspace` a **SQLite-backed VFS living in
the DO**, which an in-image `computerd` daemon **FUSE-mounts into the container**. The container's
`/workspace` is not a copy of the DO's tree — it *is* the DO's tree, live in both directions.

⇒ **File-shipping code MUST NOT be written.** An `applyChanges` / `syncToDevContainer` /
bespoke-dist-readback shape is not something to port, optimize, or delta-encode — with a FUSE mount it
**stops existing**.
Writes land via `ws.fs.writeFile` on the DO side and are already visible in the container; build output
returns on the exec's own sync bracket. If you catch yourself designing a transfer, re-read this.

Measured 2026-08-03 on real Cloudflare hardware (`experiments/computer-vfs-build/RESULTS.md`):

- **FUSE carries a real `vite build` at 1.05× median** (15 within-container pairs; five below 1.0).
- **Build output returns for FREE — 0 ms readback every run.** Writing the scaffold in is likewise 0 ms.
- **Startup is a net win:** shell → computer is **−12.4 ms / −207 KiB** (22.5 ms → 10.1 ms active CPU).

⚠️ **Costs that are real:**
- **`node_modules` MUST stay on ext4** — deps in the VFS work and survive container death, but cost
  ~2× the build; bulk-copying them out is worse. Registry egress from a tenant container works, so
  user extras go through `npm install` at build time.
- **Cold start + FUSE mount is ~3.2 s**, up ~1.5–2 s over the old 0.3–1.6 s.
- **The container holds a Cap'n Web session to `computerd`, so its lifetime MUST sit strictly inside
  one in-flight request.** `ctx.container.destroy()` while that session is open fails the request with
  `1006`. Not an ADR-003 violation (a DO and its own container are liveness-coupled by construction,
  state is in SQLite, and the vendor supplies reconnect + exec resume) — but an eviction mid-operation
  now orphans a container **and** tears a session.

### Version history is LOCAL; a git remote is TRANSPORT

`@cloudflare/computer/git` (`createGitClient()` → `GitClient`) binds to a `WorkspaceLike` whose
`provider()` is a `SQLiteWorkspaceProvider` — so git runs **host-side, directly on the DO's SQLite VFS,
with no container spin-up.** Its surface is a strict superset of `@cloudflare/shell`'s: beyond
init/add/commit/log/status/branch/checkout/diff/remote it adds merge, stash, tag, worktree, revParse,
lsTree, lsFiles, catFile, hashObject, updateRef, config, show, and typed errors.

⇒ **Commit-per-turn and shipped-version-is-a-tag need no git server and no hosted repo** — they are
local operations on the DO's own storage, off the interactive path. A remote (Cloudflare Artifacts or
anything else) buys only what its name says: **moving trees outside the DO+container pair** — off-DO
durability, external git-client access, forking. A remote MUST NOT be reached for to get *history*.

⚠️ Two gotchas:
- **`@platformatic/vfs` is an OPTIONAL peer dependency that npm does not install.**
  `@cloudflare/computer/git` needs it, so it MUST be installed explicitly.
- **Host-side `file://` remote transport does NOT work** — unimplemented in isomorphic-git, though
  computer's own scheme gate and docs advertise it. Repo-to-repo git MUST be container-side with real git.

ⓘ **Their docs lag their code — you MUST verify against the installed `.d.ts`**, not the published page (mounts
were documented "(planned)" while shipped). Current *policy* — which of these we've adopted and when —
lives in the task files, per this file's header.

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
you — that's **load-bearing, not sugar**. **So: you MUST attach `monitor()`, and MUST decide liveness by
a health probe, never by `.running` alone.** (All confirmed native to raw `ctx.container`, reproduced with no base
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
in flux, and lives in the task files — the policy MUST NOT be inferred from this paragraph, and if you
persist anything before an abort, see [durable-objects.md](durable-objects.md) § Persist before `ctx.abort()`.

**cold ⊋ stuck** — every stuck response is cold, but cold is strictly bigger. `429`/`503`/`502`,
provisioning, and **`Failed to start container`** are cold-but-**not**-stuck. You MUST NOT force-reset on
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
- **Container behavior MUST be verified under `wrangler dev` + Docker *before* deploying** — it does run
  there. (Pure-UI changes stay build-verified.) Broken container changes have shipped twice from skipping this.

## Local dev

- **Docker Desktop MUST be used, not Colima** — the variable is the container *engine*; Colima's macOS-VF
  networking can't sustain the workerd↔container(↔sidecar) connection.
- **`wrangler dev` MUST run with NO `--local`** — `--local` + a container hangs after the image build
  (workerd listens, never becomes ready). Recovery: `pkill -9 -f workerd`, then `rm -rf .wrangler`.
- **`extends Container` cannot be constructed under vitest-pool-workers** (`ctx.container` is undefined →
  the *base ctor* throws). ✅ **The fix is to not extend it.** Any DO drives a container via **raw
  `ctx.container`**, and a plain DO that touches `ctx.container` only in methods (never the constructor)
  **constructs + unit-tests fine** under pool-workers — `ctx.container` is simply `undefined` there, so
  container methods MUST be guarded with `if (this.ctx.container)`. The raw path **restores** the unit-testability
  `extends Container` forfeits; the thin-shell discipline becomes a nicety, not a workaround.
  (`experiments/plain-do-container` Q1; `packages/mesh/test/container/precheck.test.ts` stays the canary
  for the base itself.)
- **`wrangler delete <worker>` does NOT delete the container app or its running instances** — they linger
  and eat the account's running-instance quota, which then blocks *new* containers from starting. They MUST
  be cleaned up with `wrangler containers list` / `wrangler containers delete <app-id>`.

## The `Container` base is optional — drive raw `ctx.container`, steal the base's homework

You do **not** have to `extends Container`. Any DO drives a container through raw `ctx.container`, and
that's the preferred path: it restores pool-workers testability (above) and frees the DO to compose the
mesh core normally. `@cloudflare/containers` is open source — **read it and copy its patterns** rather
than inherit its lifecycle. A correct raw drive replicates:

- **`ctx.container.monitor()` MUST be attached** — the single source of truth for "the container exited,"
  and the thing that keeps `.running` honest (see the state machines); without it you wedge on every
  container death.
- **A readiness poll MUST have a timeout**, never an open-ended wait — and it MUST fail *loudly* if a port
  never comes up (a crashed entrypoint is a bug to surface, not a hang to sit in).
- **Lifecycle transitions MUST be serialized by an in-memory promise-chain latch, and `blockConcurrencyWhile`
  MUST NOT wrap them.** Chain each start/stop cycle on the previous one's promise, so concurrent callers
  coalesce onto one `start()` instead of racing a second — and the DO stays responsive throughout, because
  every await yields. `blockConcurrencyWhile` pauses delivery of EVERY other event to the DO, and a readiness
  probe is seconds long by nature (a container is booting) — wrapping it deafens the hub for exactly the
  window it is busiest, stalling the traffic the companion-DO model exists to keep serving. (This bullet
  previously prescribed `blockConcurrencyWhile`; caught in hand review 2026-08-24 after being transcribed
  twice.) The latch is coordination state, not business data — `durable-objects.md`'s no-instance-state rule
  is not in play.
- **`envVars` MUST be set before `start()`** — the container reads them at *start*, not at construction.

**On the raw path the `extends Container` frictions disappear:** there is **no base alarm loop**, so
`svc.alarms` / `svc.sql` / `svc.broadcast` are **free to use**. The old "never `svc.alarms` on a container
node; route scheduling through `Container.schedule()`" constraint was an artifact of inheriting the base's
perpetually-armed alarm — **gone** on a plain-DO container host. `onStart` is likewise yours (or just do
lazy construction in a first-use getter).

## Keeping the companion DO alive — you usually don't need to

- **Waking a hibernated/evicted DO is ~free** (~0.3 s, dominated by network RTT — measured after a full
  idle-and-evict). Effort SHOULD NOT be spent keeping the DO warm between calls; let it hibernate.
- **An in-flight request keeps the DO resident on its own** — idle-eviction doesn't fire while a request
  (e.g. a long `await`) is open; a long operation stays on the *same* isolate for its whole duration.
- **A periodic alarm does NOT preserve a running isolate.** An alarm that fires after an eviction
  *reconstructs a fresh isolate* — it can't keep an in-memory operation (a streaming model call, say)
  alive across an eviction. So a keep-warm heartbeat is the **wrong tool** for preserving in-flight work:
  that work MUST run inside an in-flight request, or be checkpointed and resumed.
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
