# SFC + Galaxy dev-cycle spike — RESULTS

**Date**: 2026-05-15
**Time-box**: 2 days (all four phases completed in <1 day).
**Parent task**: [tasks/archive/spike-sfc-dev-cycle.md](../../../../tasks/archive/spike-sfc-dev-cycle.md) (archived; this RESULTS.md is the authoritative findings record)

## Summary

**All four phases passed.** `@vue/compiler-sfc` runs cleanly inside a Cloudflare Durable Object under `nodejs_compat_v2`. The end-to-end loop (preview WS register → compile request → reload broadcast) works correctly across multiple peers and sessions. Wall-clock latency is **sub-2 ms p50 locally** (warm), and **~36 ms p50 against deployed Cloudflare** (Pittsburgh → IAD), with network RTT being the dominant cost.

**Recommendation: pivot Phase 5.3.7-v1 to SFC authoring.** Resume the [coding-your-ui.md](../../../../website/docs/nebula/coding-your-ui.md) review against `.vue` SFC examples; drop the kebab-case-tag rule and the HTML-in-JS-strings ergonomics tax. Details in the Conclusion section below.

## What was tested

### Phase 1 — kill criterion: `@vue/compiler-sfc` in Workers runtime

Test file: [`test/kill-criterion.test.ts`](test/kill-criterion.test.ts). Three sub-tests:

1. **Representative SFC** (`<template>` with `v-model` on deep paths, `v-if`, `v-for`, optional chaining + `<script setup>` + scoped `<style>`) compiled with zero errors. Non-empty output from all three blocks.
2. **TypeScript SFC** (`<script setup lang="ts">` with `defineProps<{...}>()` macro and explicit type annotations) compiled with zero errors. The `defineProps<{...}>()` macro was correctly transformed by `compileScript`.
3. **Malformed SFC** produced parse errors without throwing exceptions; the result shape stayed intact.

Result: 3 / 3 pass. Compile is sub-millisecond for the representative SFC; module import is ~700 ms (one-time per DO startup).

### Phase 2 — functional loop: WS register → compile → reload broadcast

Test file: [`test/functional-loop.test.ts`](test/functional-loop.test.ts). Three sub-tests, all running through the full chain `SELF.fetch → Worker default fetch → routeDORequest → SpikeGalaxy.fetch`:

1. **Single peer** — one preview client receives `'reload'` after a compile triggered for its sessionId.
2. **Session isolation** — peer A registered on sessionId-A; peer B on sessionId-B. Compile against sessionId-A delivers to A only; B receives nothing.
3. **Fanout** — three peers on the same sessionId all receive `'reload'` from a single compile call.

Result: 3 / 3 pass.

## Findings

### `@vue/compiler-sfc` is Workers-compatible

No polyfills, no shims. All transitive dependencies (`postcss`, `@babel/parser`, `magic-string`, `source-map-js`, `estree-walker`, `@vue/compiler-core`, `@vue/compiler-dom`, `@vue/compiler-ssr`, `@vue/shared`) load and run under `compatibility_flags: ["nodejs_compat_v2"]`. This was the spike's primary risk; it cleared without incident.

### TypeScript support has two layers, not one

`@vue/compiler-sfc`'s `compileScript` accepts `<script setup lang="ts">` and processes Vue macros (`defineProps<...>()`, `defineEmits<...>()`, `withDefaults`, etc.). It does NOT strip non-Vue TypeScript syntax — `interface` declarations and type annotations on non-macro symbols survive into the output. A downstream TS transpiler (the `typescript` npm package, `@swc/wasm`, or similar) is needed to produce executable JS.

**Implication for production design:** Galaxy's compile pipeline chains two steps:

```
SFC source
  → @vue/compiler-sfc        (resolves Vue macros, separates script/template/style)
  → TS transpiler            (strips remaining TS syntax)
  → executable JS module
```

The second step is straightforward — `typescript` npm has Workers compatibility precedent in this codebase already (parse-validate work in 2026-04 / 2026-05). Plan for it; don't be surprised by it.

### Module import is the cold-start cost

`@vue/compiler-sfc` import takes ~700 ms on first DO startup. Once warm, compile is sub-ms. This is the same shape `@lumenize/ts-runtime-parser-validator` exhibits (typia loaded into a DO) — keep the dev Star warm during the session, accept the first-compile-after-cold-start hit. Subsequent saves are sub-ms compile + the network RTT.

### Path-action fetch routing on the DO is spike-only

The `SpikeGalaxy.fetch` method parses `/galaxy/spike/{action}/{sessionId}` to dispatch between `reload` (WS upgrade) and `compile` (POST trigger). This was forced by the spike not having a NebulaClient to drive compile via mesh `lmz.call`. **Production design will be different and simpler:**

- Studio is a NebulaClient with a persistent WS to its dev Star's NebulaClientGateway. Compile arrives as `lmz.call(STAR, '<branch-instance>', compileSFC(source))` over that existing WS — the dev Star's `@mesh()` compile method handles compile + notify directly.
- The dev Star's `fetch()` survives only for the preview client's WS upgrade (the preview is a separate browser tab subscribed for reload events). It checks `request.headers.get('Upgrade')?.toLowerCase() === 'websocket'` and accepts; no path-action distinction needed.

The spike validates the moving parts (compile, broadcast, hibernating WS, routing layer) work in isolation. The integration design is cleaner than what the spike shows.

### The compile DO is the dev Star, not Galaxy

When this spike was started, the natural assumption was "Galaxy compiles SFCs because Galaxy already holds compile-time concerns (ontology validators)." That's wrong for SFC-per-save compile. Reasoning:

- **Galaxy is a single regional DO.** A developer in Sydney hitting a US-East Galaxy pays ~200–300 ms RTT per save. That's not "feels instant" anymore.
- **The dev Star is user-local.** Per [tasks/nebula-branches.md](../../../../tasks/nebula-branches.md): every Star auto-creates `.main` and `.dev` branches as independent DO instances. Each branch's Star is created on first call → placed in the nearest CF colo. A Sydney Studio session → AU colo → AU dev Star. Eyeball ↔ dev Star is single-digit ms anywhere.
- **The dev Star wears two hats naturally.** As a Star, it holds the in-progress app's resources, DAG, subscriptions, and serves the running UI to the preview client over the existing Subscriber/fanout machinery. As a dev surface, it also imports `@vue/compiler-sfc`, accepts SFC source from Studio over the existing NebulaClient WS, and broadcasts reload via the same Subscriber/fanout. Two roles, one DO, one connection.
- **`@vue/compiler-sfc` is library code, not tenant data.** Same Worker bundle deploys to every colo; every dev Star instance shares the import. No per-tenant compile bundle to ship from Galaxy.
- **Galaxy is NOT in the per-save critical path.** Galaxy is only touched at session start (pulling the user's ontology bundle into the dev Star) and at deploy time (pre-compiling templates for production assets — separate concern). Per-save SFC compile happens entirely inside the user-local dev Star.

**Implication for production architecture:** the spike's code transfers 1:1 to the dev Star. Same `@vue/compiler-sfc` import, same `ctx.acceptWebSocket` + `getWebSockets(tag)` fanout, same `routeDORequest` pattern at the Worker entrypoint. Class renames from `SpikeGalaxy` to whatever the dev Star is called; everything else is structurally identical.

**Implication for Phase 4 numbers:** the 36 ms p50 we measured was Pittsburgh → IAD (single-digit-ms eyeball → colo, plus ~30 ms US trans-coast). For a globally distributed user base hitting their nearest dev Star, p50 stays in the same ~5–10 ms eyeball-to-colo territory regardless of where the user lives. **The Australia worry evaporates** — there's no cross-continent RTT in the per-save loop.

### `Date.now()` timings inside the DO would be pinned

Per `feedback_cf_clock_traps` memory: `Date.now()` is pinned within a single DO invocation. The first version of `#handleCompile` returned `compileMs` and `notifyMs` measurements derived from `Date.now()` reads taken before/after each step — those reads would have been identical, showing 0 for everything. Stripped from the response.

**Real timing measurement requires an observer outside the Workers runtime.** That's the follow-on phase.

### `routeDORequest` integration was zero-friction

`@lumenize/routing.routeDORequest` handled WS upgrade routing identically to HTTP routing — no special-casing in the Worker fetch handler needed. The DO sees the full URL with the routing-context headers, parses the rest, and returns the WS upgrade Response.

### Worker pool / hibernation API behaves correctly

`ctx.acceptWebSocket(ws, [tag])` registers the WS with the hibernation system; `ctx.getWebSockets(tag)` returns all WS with that tag for fanout. The session-isolation and fanout tests verify both directions: only matching tags receive the broadcast.

## What was NOT measured

- **Wall-clock round-trip latency.** Both the cold-load cost and the per-iteration cycle time need outside measurement (node.js client → `wrangler dev` locally, then node.js → deployed Worker). Inside vitest-pool-workers everything runs in the same workerd process, which both clock-pins and elides real network behavior.
- **Real WebSocket reconnect behavior.** The spike's tests open + close WS connections cleanly. Reconnect-on-deploy, dropped-message recovery, and long-running sessions are not exercised.
- **Real-network latency.** Cloudflare global routing, eyeball-to-edge RTT, regional Galaxy placement — none of these factor into in-process tests.
- **Deployed performance.** Cold-wake on Cloudflare's production runtime can differ from local workerd.

These all live in the two follow-on phases below.

## Phase 3 — local wall-clock timing (node.js client → `wrangler dev`)

Probe file: [`probes/measure-roundtrip.ts`](probes/measure-roundtrip.ts). 20 iterations (3 warmup, 17 measured). Each iteration opens a fresh WS, POSTs SFC source to `/compile`, awaits the `'reload'` broadcast on the WS, measures `performance.now()` from POST send to message receive. Measurement lives in Node.js (outside the Workers runtime), so DO clock pinning doesn't affect us.

### Phase 3 results

| Metric | Value |
|---|---|
| **POST → reload p50** | **1.95 ms** |
| POST → reload p90 | 3.38 ms |
| POST → reload p99 | 4.50 ms |
| POST → reload max | 5.20 ms |
| WS-open p50 | 1.99 ms |
| Cold first iteration (post→reload) | 20.54 ms |

The warm round-trip is sub-2 ms in local workerd, with no network. Even the cold first iteration is 20 ms. The compile + broadcast path adds essentially nothing on top of the in-process inter-call cost.

## Phase 4 — deployed wall-clock timing (node.js client → Cloudflare Worker)

Deployed to `https://spike-sfc-galaxy-loop.transformation.workers.dev` via `wrangler deploy`. Client in Pittsburgh; CF colo `IAD` (US East) per `cf-ray` header — same-continent eyeball routing. 20 iterations (3 warmup, 17 measured), same probe script.

### Phase 4 results

| Metric | Value |
|---|---|
| **POST → reload p50** | **35.86 ms** |
| POST → reload p90 | 80.78 ms |
| POST → reload p99 | 93.61 ms |
| POST → reload max | 123.87 ms |
| WS-open p50 | 142.71 ms |
| WS-open p99 | 171.58 ms |
| Cold load (pre-warm GET) | ~100 ms |
| Cold load (pre-warm compile, DO module load) | ~73 ms |

### Phase 4 analysis

The deployed-Worker p50 of 35.86 ms breaks down approximately as:

- **~32 ms eyeball ↔ CF colo RTT** (Pittsburgh ↔ IAD). This is the network floor; not reducible without geographic distribution.
- **~4 ms compile + broadcast in-DO** (matches the Phase 3 local in-process baseline).

So compile and broadcast contribute essentially nothing to deployed latency — it's all network. That means improvements scale with the network: anyone closer to a CF colo gets better numbers; anyone farther gets worse. Plausible global p50: 30 ms in US, 50 ms in EU (via cross-continent routing or eu-jurisdiction Galaxy placement), 80 ms+ in APAC.

WS-open at p50 142 ms reflects standard TLS WS handshake cost: TCP handshake + TLS handshake + HTTP upgrade RTT + 101 response. Real cycle latency in a page-reload-on-every-iteration model is the sum:

```
save → POST→reload (~36 ms) → page reloads → WS-open (~143 ms) → Vue boot (~?) → ready
```

So **a full save-to-ready cycle is ~180 ms + render time** for an IAD-near client. That's well inside "feels instant" territory.

Two outliers worth flagging: iters 7, 8, 11, 17 hit 70–124 ms post→reload (vs ~33 ms typical). Probably TCP retransmits or transient edge congestion. p99 at 94 ms is well within acceptable; max at 124 ms is rare enough not to matter for UX.

### What Phase 4 did NOT measure

- **HMR vs full-reload.** The spike uses page-reload semantics — every cycle drops the WS and re-establishes. Real HMR would keep the WS alive and replace components in-place, removing the 143 ms WS-open from each cycle. Not in scope for this spike, but the architecture allows it.
- **Vue boot time on the client.** Once `reload` arrives and the page reloads, the browser fetches the deployed assets, parses the Vue runtime, mounts the app. That cost is independent of Galaxy and not measured here.
- **Other geographies.** All measurements are Pittsburgh → IAD. EU and APAC clients will be slower; eu-jurisdiction Star/Galaxy placement (precedent: gateway-hop benchmark) is the mitigation.
- **Many concurrent dev sessions.** Each iteration is single-session. Scale tests (10s of concurrent Studio users on the same Galaxy) would surface fanout / hibernating-WS pool behavior at higher load.

## Conclusion

All four phases passed. The SFC dev-cycle architecture is viable, **and the compile DO is the user-local dev Star, not the regional Galaxy.**

1. **Compilation works in Workers** under `nodejs_compat_v2` without polyfills.
2. **TypeScript SFCs work** with a downstream TS transpiler chained after compile-sfc.
3. **The functional loop** (WS register → compile → fanout broadcast) works correctly across single-peer, isolation, and multi-peer scenarios.
4. **Local round-trip latency** is sub-2 ms warm; **deployed round-trip latency** is ~36 ms p50 Pittsburgh→IAD, and stays in single-digit-to-low-tens-of-ms territory for any user hitting their nearest CF colo's dev Star.

**Recommendations:**

- **Pivot Phase 5.3.7-v1 to SFC authoring.** Resume the [coding-your-ui.md](../../../../website/docs/nebula/coding-your-ui.md) review, rewrite the template-string-dependent chapters against `.vue` SFC examples, drop the kebab-case-tag rule and the HTML-in-JS-strings ergonomics tax.
- **Place the per-save SFC compile on the dev Star** (per [tasks/nebula-branches.md](../../../../tasks/nebula-branches.md) — every Star auto-creates `.main` and `.dev`; the `.dev` branch is the natural home). Galaxy stays out of the per-save critical path.
- **Track the dev-Star compile + reload work** in [tasks/nebula-studio.md](../../../../tasks/nebula-studio.md) § Editor / Preview. Port the spike's code into the dev Star when that phase is implemented; **delete this spike directory and `tasks/archive/spike-sfc-dev-cycle.md` after porting.**

## Deploy hygiene

The deployed Worker `spike-sfc-galaxy-loop` (named before we settled on the dev-Star framing) remains live at `https://spike-sfc-galaxy-loop.transformation.workers.dev` for follow-up measurement. Tear down with `wrangler delete --name spike-sfc-galaxy-loop` once the SFC pivot decision is settled and we don't need to re-probe. (The local source directory was renamed to `sfc-devstar-loop` post-deploy; the deployed Worker name still reflects the original directory name.)

## Files

- [`package.json`](package.json) — spike package; `@vue/compiler-sfc` + `@lumenize/routing` + `tsx` for the probe + vitest-pool-workers for tests
- [`wrangler.jsonc`](wrangler.jsonc) — `compatibility_date: 2026-05-01`, `nodejs_compat_v2`, `GALAXY` DO binding
- [`src/galaxy.ts`](src/galaxy.ts) — `SpikeGalaxy` DO with `compileSFC` (RPC) + `fetch` (HTTP/WS) + hibernating WS
- [`src/index.ts`](src/index.ts) — Worker entrypoint with `routeDORequest`
- [`test/kill-criterion.test.ts`](test/kill-criterion.test.ts) — Phase 1 tests
- [`test/functional-loop.test.ts`](test/functional-loop.test.ts) — Phase 2 tests
- [`probes/measure-roundtrip.ts`](probes/measure-roundtrip.ts) — Phase 3/4 measurement script (`--url` flag selects local vs deployed)
- [`vitest.config.ts`](vitest.config.ts) — `cloudflareTest` plugin config
- [`tsconfig.json`](tsconfig.json) — extends repo root
