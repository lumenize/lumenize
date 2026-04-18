# Task: Dynamic Worker Bundler Spike

**Status:** Complete → Archived
**Depends on:** None (standalone spike)
**Outcome:** Created `tasks/nebula-5.2.6-switch-validate-to-plain-worker.md`
**Location:** `experiments/dw-bundler-spike/`

---

## Goal

Answer: **What's the best way to run tsc validation outside a Durable Object?** Tested three approaches: `@cloudflare/worker-bundler` (runtime bundling), Dynamic Workers (pre-bundled), and plain Worker via Service Binding.

## Final Results (2026-03-25, deployed, measured from user's machine)

| Path | Warm single check | E2E (6 checks) | Cold/first call |
|---|---|---|---|
| **Ping** (network baseline) | 33 ms | — | — |
| **In-process** (tsc in parent Worker) | 49–53 ms | 209 ms | 129 ms |
| **Plain Worker** (Service Binding RPC) | **38–53 ms** | **138 ms** | 479 ms |
| **Dynamic Worker** (pre-bundled DW) | 45–55 ms | 993 ms | 687–839 ms |

**tsc compute cost: ~15-25ms per validation** (after subtracting 33ms ping).

### Critical correction

The tsc-dwl-spike originally reported ~1ms per check using `performance.now()` inside the Worker. This was wrong — **Cloudflare clocks don't advance during synchronous execution**, so internal timings were meaningless. The real cost is ~15-25ms, only measurable via external wall-clock from a Node.js client.

## Verdict: Plain Worker with Service Binding

**Winner: Plain Worker via Service Binding.** Same warm latency as all approaches (~50ms wall), but:
- **Better sequential throughput** — E2E 138ms vs DW's 993ms
- **Better cold story** — 479ms only on deploy, not on DW eviction (687-839ms each time)
- **Simpler** — no `worker_loaders` binding, no `get(id)` callback, just a standard Service Binding

### Why not in-process?
The DO processes requests sequentially. If each blocks ~15-25ms on tsc, throughput caps at ~40-65 req/s per DO. Unacceptable. The DO must `await` an external Worker, which opens input gates and allows interleaving. Wall-clock billing (~15-25ms per validation) is the acceptable tradeoff.

### Why not Dynamic Workers?
Same warm single-call latency, but dramatically worse for sequential calls (993ms vs 138ms for 6 checks). Cold start on every eviction vs only on deploy. No practical benefit over a plain Worker for this use case.

### Why not `createWorker()` (runtime bundling)?
Exceeds Worker resource limits deployed for typescript-sized packages (~10MB). Works locally but hits Error 1102 in production. RED LIGHT.

## Bundling Notes

The pre-bundled `.mjs` for in-process/Worker use requires esbuild with:
- `platform: 'neutral'` (not `browser` — its Node.js shims are broken for `os.platform()`)
- `alias` to redirect `os`, `path`, `fs`, `perf_hooks`, `crypto`, `inspector` to custom shims
- `inject` for `__filename`/`__dirname` globals

See `experiments/dw-bundler-spike/scripts/bundle-tsc.mjs` and `scripts/shims/`.

## Earlier Results (kept for reference)

### `createWorker()` deployed
- `/spike/bundler-timing`: **1102 — Worker exceeded resource limits**
- `/spike/cold`: 8-16s wall-clock (intermittent 1102 failures)
- `get(id)` callback re-ran every request because `createWorker()` was inside it

### Pre-bundled DW deployed (before plain Worker comparison)
- Cold: ~600ms wall
- Warm: 48-73ms wall
- E2E (6 checks): 805ms wall
- `get(id)` caching works — isolate persists across requests

## Non-Goals

- Not building the actual validator API (see `tasks/nebula-5.2.6-switch-validate-to-plain-worker.md`)
- Not integrating with Nebula (deferred to 5.2.6)
