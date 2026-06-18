# FINDINGS — Agent command channel into the dev container (Q5 of the container-vite pivot)

Spike task file: `tasks/spike-container-agent-channel.md`. Throwaway, time-boxed 1–2 days.
Builds on `experiments/container-vite-spike` (the vite + lifecycle-DO proxy loop). **This spike
proves how Studio's server-side agent drives the dev container in production — where there is no
host `docker`** — via a DO-mediated exec channel.

**Run order:** Q1 (mechanism) + Q2 (deployed latency) are the kill-fast gates — done first.

---

## Architecture under test

```
 agent (server-side Nebula DO/facet)          [spike: a Worker fetch route /__cmd/* — the test driver]
        │  lmz.call  (mesh, onBeforeCall-gated)  [spike: plain DO RPC — raw RPC ok in a throwaway]
        ▼
 DevContainer DO  (extends @cloudflare/containers Container, defaultPort 5173)
        │  containerFetch(req, 9000)            ← the NOVEL/RISKY leg this spike proves
        ▼
 command-server  (node http on :9000 inside the image; SUPERVISOR — spawns vite as a child)
        │  child_process
        ▼
 git / grep / vite build / file writes / dev-server restart
```

- **Two ports, one container:** vite on **5173** (the public preview proxy, the container's raw
  `fetch()`); the command-server on **9000**, reachable **only** by the DO's `containerFetch(req, 9000)`.
- **The mesh leg (agent→DevContainer) is a known quantity** — already benchmarked elsewhere; the
  spike measures the leg that was unproven: **DO → container → back**. The agent's real path to the
  DO is **edge-local** (both are server-side DOs), so the relevant latency is `doRoundTripMs`
  (measured inside the Worker), **not** the measuring client's WAN to the edge.

## Environment / setup

- Docker 29.5.3, wrangler 4.86, `@cloudflare/containers` 0.3.7.
- Image: `node:22-slim` **+ git** (slim has none — the container-vite Q5 finding) + the vite app +
  `command-server.mjs`. CMD = `node /workspace/command-server.mjs` (it boots, listens on 9000, then
  spawns `npm run dev` for vite on 5173).
- Mechanism confirmed in the 0.3.7 type defs: `containerFetch(requestOrUrl, portOrInit?, portParam?)`
  takes an explicit **port** → a second port distinct from `defaultPort` is reachable; `getContainer`
  returns a `DurableObjectStub<T>` → the Worker can call custom DO RPC methods (`exec`/`writeFile`/…).

_Status: **2026-06-17** — Q1 ✅, Q2 ✅ (local **and deployed**), Q3 ✅, Q4 ✅, Q5 ✅. **No kill criterion
fired → GO.** One sizing finding: a `vite build` saturates the default ¼-vCPU instance and starves the
command channel (transient; recovers when idle) — see Q2 deployed. Q6 (ssh) not load-bearing._

---

## Q1 — Exec mechanism through the DO — *kill-fast gate* — ✅ PASS (local)

The agent (via a DO mesh-analog method) ran each of these in the container and got
**stdout + stderr + exit code** back:

| command | result |
|---|---|
| `git init` then `git status --porcelain` | code 0, returns the file list — **git baked in works** |
| `grep -rn marker src/` | code 0, returns the two matching lines |
| write `app/src/App.vue` (and `marker.txt`) | `{ok:true}`; `cat` confirms the bytes landed |
| `npm run build` (= `vite build`) | code 0; 1561 modules, `✓ built in 1.47s`; ~2.5 s buffered exec, **no timeout** |
| `POST /vite/restart` | `{ok:true, action:"restart"}` — dev server restarts |

- The command-server being the **vite supervisor** is what makes start/stop/restart trivial (it owns
  the vite child). A bare side-by-side process would need a separate signal path.
- **Verdict: success.** Edit files, run `vite build`, restart the dev server, run git/grep/exec — each
  returns output + exit code over the DO channel. Kill criterion (no usable in-container exec) did
  **not** fire.

## Q2 — Deployed command latency — *kill-fast gate* — ✅ PASS (local **and deployed**)

`doRoundTripMs` = Worker → DO → `containerFetch(9000)` → command-server → back — the **agent-relevant,
edge-local** number (the real Studio agent is a server-side DO, so its hop to DevContainer is edge-
local mesh, NOT the measuring client's WAN). `client` = curl `time_total` from this laptop, which adds
my ~45–70 ms WAN to the edge and is therefore an over-count.

**Local** (`wrangler dev` + Docker):

| probe | doRoundTripMs (local) |
|---|---|
| **cold** first command after a fresh container (`docker rm -f` → noop) | **~1336 ms** |
| warm `noop` (`/healthz`, no child spawn — pure channel) | **2–4 ms** |
| warm `git status --porcelain` (spawn + git) | 19–47 ms (in-container 14–20 ms) |

**Deployed** (`container-agent-channel.transformation.workers.dev`, via the GHA workflow):

| probe | doRoundTripMs (edge-local) | client (incl. my WAN) |
|---|---|---|
| **cold** first command (edge provision + boot + cmd-server on 9000) | **~1361 ms** | ~1.47 s |
| warm `noop` (pure channel), fresh/idle container | **~29–40 ms** (p50 ~31 ms) | ~50–110 ms |
| warm `git status --porcelain`, fresh container | **~36–42 ms** (code 0) | ~0.11 s |
| warm `grep -rn` (first invocation) | ~123 ms | ~0.18 s |

- **Cold start of the command channel (~1.36 s) is FASTER than vite's (~4.1 s deployed)** — the
  command-server binds 9000 *before* spawning vite, so the agent can scaffold / `npm install` / edit
  while the preview (5173) is still warming. A genuinely useful property.
- **Warm channel overhead at the edge is ~30 ms** — ~10× under the 300 ms interactive target. The
  `containerFetch`-to-a-second-port hop is cheap; the real cost of a command is the command itself.
- **⚠️ Sizing finding (not a channel fault):** streaming a `vite build` on the **default `basic`
  (¼ vCPU)** instance **saturated the CPU and starved the command channel** — requests returned `000`
  for ~60 s during/after the build, and a trivial `git status` degraded to **in-container 0.2–3.1 s**
  for ~1–2 min afterward. It **fully recovered to ~30 ms once idle**, confirming the degradation is
  transient CPU contention, not a channel defect. Implication (reinforces container-vite **Q4**):
  size the dev instance for build bursts (`standard-1` ½ vCPU+), and/or treat *publish* (`vite build`)
  as a non-interactive moment / run it off the interactive instance. The agent's *interactive* edit
  loop (small commands + HMR) is unaffected as long as no heavy build is hogging the vCPU.
- **Verdict: success (local + deployed).** Warm round-trip ~30 ms edge-local — well under target. Kill
  (`> ~1 s/command warm, can't be batched around`) did **not** fire for the interactive loop; the only
  >1 s case is a heavy build on an undersized instance, which is a sizing/scheduling choice, not the
  channel.

## Q3 — Long-running + streaming output — ✅ PASS (local)

`/exec-stream` writes NDJSON events (`{stream,data,tMs}` per chunk, then `{event:"exit",code}`) as
they arrive; the DO returns the body `ReadableStream` over RPC and the Worker pipes it out.

- Synthetic `for i in 1..5; do echo; sleep 0.4; done` → lines arrived at tMs **20, 437, 860, 1283,
  1705**, exit at 2132 — **incremental, ~0.4 s apart, NOT buffered to the end.**
- Real `vite build` streamed: `> build` @371ms → `transforming…` @1046ms → `✓ 1561 modules` @2431ms →
  results @2532ms → exit @2572ms. The multi-second build **did not block or time out the DO call.**
- **Deployed:** streaming confirmed at the edge too — `vite build` chunks arrived incrementally
  (`> build` @3.3 s → `transforming…` @20.8 s) and the DO call held the stream open for 20 s+ without
  timing out (the build is slow on the ¼-vCPU instance — see Q2 sizing finding — but the *streaming
  mechanism* is sound).
- **Verdict: success.** Chunked stdout reaches the agent live; long builds + log tails are viable.
  Kill (only blocking buffered exec) did **not** fire.

## Q4 — File-write parity with the dev loop — ✅ PASS (local)

Agent writes `app/src/App.vue` **via the command channel (port 9000)** → vite emits an HMR
`update` frame **through the DO proxy (port 5173)**:

```
[channel] write App.vue -> {ok:true, doRoundTripMs:7}
[hmr] UPDATE frame: kinds=[js-update,js-update] 64ms after write   ← in-place patch, NOT full-reload
```

- The two ports **cooperate**: the write goes in on 9000, the watcher fires, and the `js-update`
  comes back out on 5173 — exactly the warm save→HMR loop a human dev gets. Component state is
  preserved (js-update, not `full-reload`). ~64 ms write→update locally.
- **Verdict: success.** Reliable write path; the watcher fires (no overlayfs/watch quirk). Kill did
  **not** fire.

## Q5 — Trust boundary (named + demonstrated, not fully hardened) — ✅ PASS (local)

The command-server (9000) is **server-side only** — there is **no browser route** to it:

- `GET /healthz` **through the public proxy** returns **vite's `index.html`** (with `/@vite/client`),
  NOT the command-server's `{ok:true}` → the public `fetch()` hits vite (5173), never 9000.
- `POST /exec` and `POST /write` through the public proxy return **vite 404s**, and `pwned.txt` was
  **never written** (a follow-up `ls` confirms absence) → no browser path reaches the command-server.
- Structurally: the public `fetch()` uses `defaultPort` 5173; the only `containerFetch(_, 9000)` calls
  live inside the DO command methods (server-side, mesh/`onBeforeCall`-gated in prod).
- **Bonus confinement:** file writes resolve under `/workspace`; an escaping path
  (`../../etc/evil.txt`) is **rejected** by the command-server.
- **Deployed:** boundary holds at the edge — `GET /healthz` through the public proxy returns vite's
  `index.html`, `POST /exec` returns vite **404**, `GET /` still serves the app (200). No edge route
  reaches 9000.
- **Verdict: success.** The boundary is named and demonstrated (local + deployed). Full sandbox-escape
  / command-injection hardening is deferred (spec + `nebula-devcontainer-node-type.md` m4 — owned by
  the #1a dev-loop task). Kill (exec reachable only with browser exposure) did **not** fire.

## Q6 — ssh tunnel feasibility *(nice-to-have, not load-bearing)*

Not pursued — the DO-mediated command-server is the load-bearing path and is fully proven above. Note
for the record: an ssh adjunct for human power-user debug would require sshd in the image + a tunneled
port reachable only server-side (same boundary discipline as 9000); feasible but unnecessary for the
agent loop. Its absence does **not** kill the spike.

---

## Go / no-go

**GO.** The DO-mediated exec channel works, is cheap (~30 ms warm at the edge), and is fully proven
**local + deployed**.

No kill criterion fired across Q1–Q5. The mechanism is exactly the predicted shape — a command-server
on a second port reached via `containerFetch(req, 9000)`, with the agent leg as a DO method (mesh in
prod) — and every required capability works: edit files, `vite build`, start/restart the dev server,
git/grep/exec, **streamed** long-command output, and **HMR parity** (channel write → `js-update`),
behind a **server-side-only trust boundary** (no browser route to 9000), with ~30 ms warm channel
overhead at the edge. This clears the linchpin the container-vite spike left open (its Q5), so the
4th-node-type build (`tasks/nebula-devcontainer-node-type.md`) is **unblocked**.

**The one caveat to carry forward (not a blocker):** the dev container must be **sized for build
bursts** or the `vite build` will starve the interactive control channel on a ¼-vCPU instance (Q2
sizing finding). Pick `standard-1` (½ vCPU)+ for the dev instance, and/or run `vite build` such that it
doesn't compete with the live agent loop. This is the same instance-sizing dial the container-vite
spike's Q4 already flagged — now with a concrete failure mode attached.

### What the production 4th-node-type build inherits from this spike

- **Shape:** `DevContainer extends Container`, `defaultPort = 5173` (public vite proxy = raw `fetch()`),
  a second port **9000** for the command-server, reached **only** via DO methods that call
  `containerFetch(req, 9000)`. In prod those DO methods become `@mesh` methods (`lmz.call`,
  `onBeforeCall`-gated); here they were plain DO RPC (fine for a throwaway).
- **Image:** `node:22-slim` needs `apt-get install git`; the command-server is a good place to also be
  the **vite supervisor** (spawns vite as a child → trivial start/stop/restart).
- **Deploy:** local `wrangler deploy` can't push large image layers from this machine
  ([[cf-container-deploy-proxy]]) — deploy via `.github/workflows/deploy-container.yml` (CI build →
  push → rollout ≈ 1.5 min).
- **Hardening owed by #1a (named, not done here):** re-validate that exec is reachable *only* by the
  in-scope Nebula agent DO; confine commands/writes (this spike already rejects path escapes from
  `/workspace`).

### Cleanup — status

- ✅ Temporary push trigger in `deploy-container.yml` reverted (back to `workflow_dispatch`-only).
- ✅ Deployed Worker `container-agent-channel` **and** its `container-agent-channel-devcontainer`
  container app **deleted** (2026-06-17, via `wrangler delete` + `wrangler containers delete`).
- ⏸ **Experiment code kept tracked on purpose** — the #2 build
  (`tasks/nebula-devcontainer-node-type.md`) builds on this proven shape. Prune the
  `experiments/container-agent-channel` workspace entry + `git rm -r` *after* that build lands.
- ℹ️ Unrelated: the prior spike's `container-vite-spike-vitedevcontainer` container app is still
  `ready` (3 instances) in the account — left untouched (not this spike's).
