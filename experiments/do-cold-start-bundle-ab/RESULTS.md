# What a Worker's bundle costs every Durable Object in it

**Date:** 2026-07-23

A Durable Object is **not** a separate deployment — its class is exported from the Worker
bundle. So every DO instance pays for the *whole* Worker's import graph, including code that
call never touches. This measures how much.

---

# What?

## Method

Seven Workers projects, each deploying a **byte-identical Durable Object**: `EchoDO`, a
`LumenizeDO` with one `echo` method, reached by raw Workers RPC from a plain `fetch` handler.
No Gateway, no WebSocket, no auth — each layer removed is one fewer confounder.

The arms differ in **exactly one thing**: which package the Worker additionally imports. All
seven (source + wrangler config) are emitted from a single manifest by `gen-arms.mjs`, so they
cannot drift apart. The `nebula-lite` arm is source-identical to `nebula`; its difference is
applied at bundle time by a wrangler `alias` that substitutes a stub for the validator,
yielding a faithful "nebula minus validator."

**10 rounds.** Each round: `create` → `warm` → **20 s idle** → `wake`. All arms are hit in
lockstep within a round, so one idle wait serves all seven and Cloudflare-side drift hits every
arm equally; arm order rotates each round so none is systematically measured first.

## Raw data

| arm | additionally imports | bundle KiB | startup ms | **create ms** | warm ms | **wake ms** | wake−warm ms | observed |
|---|---|---:|---:|---:|---:|---:|---:|---|
| mesh | — (baseline) | 131 | 7 | **337.6** | 38.9 | **105.6** | 66.6 | do-rebuilt ×10 |
| auth | `@lumenize/nebula-auth` | 218 | 6 | **367.4** | 41.2 | **103.0** | 61.7 | do-rebuilt ×10 |
| shell | `@cloudflare/shell` | 241 | 19 | **388.3** | 40.8 | **113.8** | 73.0 | do-rebuilt ×10 |
| git | `isomorphic-git` | 684 | 25 | **373.4** | 37.5 | **104.5** | 67.0 | do-rebuilt ×10 |
| nebula-lite | `@lumenize/nebula`, validator aliased out | 2,704 | 35 | **357.1** | 39.2 | **89.8** | 50.5 | do-rebuilt ×9, isolate-rebuilt ×1 |
| validator | `@lumenize/ts-runtime-parser-validator` | 9,241 | 583 | **1,306.1** | 40.2 | **120.4** | 80.2 | do-rebuilt ×10 |
| nebula | `@lumenize/nebula` (full barrel) | 11,827 | 749 | **1,433.4** | 43.8 | **1,413.4** | 1,369.6 | do-rebuilt ×10 |

## What each column means, exactly

| column | definition |
|---|---|
| **bundle KiB** | `Total Upload` reported by `wrangler deploy`, **uncompressed**. |
| **startup ms** | `Worker Startup Time` reported by wrangler **at deploy** — Cloudflare booting ONE isolate of that script (load + parse/compile + evaluate top-level). A server-side number, *not* a client measurement. |
| **create ms** | **p50 of the end-to-end round trip measured at the client** (Node, over the public internet), for a request naming a DO id that **has never existed**. Includes network RTT. |
| **warm ms** | p50 end-to-end at the client, **same** DO id, immediately after `create`. |
| **wake ms** | p50 end-to-end at the client, **same** DO id, after **20 s idle**. |
| **wake−warm ms** | `wake` with the network + dispatch floor subtracted. |
| **observed** | What the DO's two self-reported ids said happened on the `wake` call. `do-rebuilt` = the DO was reconstructed but the **isolate survived** (module graph already evaluated). `isolate-rebuilt` = both were rebuilt. |

All timings are **p50 over n=10 rounds**, end-to-end from the client unless stated otherwise.

## Stability

`create` and `warm` **reproduce** across repeat runs. **`wake` on large bundles does not**: a
repeat run measured `validator` wake at **1,255.8 ms** instead of 120.4 ms — a 10× swing on the
identical worker. Small-bundle `wake` is stable across runs. This instability is a finding in
its own right (see So-what #4), not just noise to average away.

---

# So what?

**1. Creating a DO and waking one are different costs. Always read both.**

- Small bundle → **create ~340–390 ms, wake ~90–115 ms.** Waking is **~3× cheaper**, because a
  wake skips placement and first-time initialization.
- Large bundle → **create ~1,430 ms, wake ~1,410 ms.** They converge: bundle cost swamps the
  creation overhead.

**2. Bundle size is free until it isn't. Three tiers:**

| tier | bundle | create | wake |
|---|---|---:|---:|
| **Small** | ≤ ~2.7 MB | ~340–390 ms | ~90–115 ms |
| **Middle** | ~2.7–9 MB | *unmeasured* | *unpredictable* |
| **Large** | ≥ ~9 MB | ~1,300–1,430 ms | unstable, up to ~1,410 ms |

A **20× size range within the small tier** (131 KiB → 2,704 KiB) moves `create` by under 60 ms.
Below ~2.7 MB, size effectively does not matter.

**3. If you remove `ts-runtime-parser-validator`, you get almost all of the win.** That package
alone (9.2 MB, create 1,306 ms) costs essentially what the entire nebula barrel costs (11.8 MB,
create 1,433 ms). Aliasing it out — `nebula-lite`, 2.7 MB — yields **create 357 ms**,
indistinguishable from the 131 KiB baseline. Everything else you might suspect
(`nebula-auth`, `@cloudflare/shell`, `isomorphic-git`) sits inside the noise.

**4. If your bundle lands in the middle tier, you cannot predict its wake latency.** `validator`
wake measured 120 ms in one run and 1,256 ms in another with an identical bundle, and the
isolate/instance ids do **not** predict which you get (both cases read `do-rebuilt`). Best
hypothesis — **unproven**: eviction is memory-pressure driven and may preferentially reap the
largest-footprint instances, so whether a 20 s idle evicts *deeply* varies with host conditions.
This is consistent with reports in the Cloudflare Discord `#durable-objects` channel. Practical
consequence: a middle-tier bundle may behave like the small tier or like the large tier
depending on the host, and **no bench can tell you which you'll get in production.**

**5. Warm calls cost nothing regardless of bundle** — 37–44 ms across a 90× size range. The
bundle is paid at DO construction, never per request.

---

# Now what? (for Nebula)

**1. Move tsc into the container.** Every tsc user is build-side — `galaxy.ts` (compiles the
`validatorBundle`), `codegen-gate.ts`, `dev-studio.ts`, `devstudio-resource-ontology.ts`. The
request path only *loads* a precompiled bundle through the Worker Loader (`star.ts` →
`getParserValidatorFacet(…, env.LOADER)`), which needs no tsc. The container already performs
the user-developer's build, and compiling schema → validator is legitimately part of a build.

- Expected: **create 1,433 → ~357 ms**, moving the main Worker from the large tier to the small
  tier, and taking `wake` out of the unstable regime.
- **No DO class migration**, so none of the `transferred` one-way-door risk.
- Bonus: retires the `bundle-tsc.mjs` machinery, which exists only because we compile in-Worker.
- ⚠️ Only **four value exports** are imported from that 9.2 MB package (`checkTypeScript`,
  `generateParseModule`, `getParserValidatorFacet`, `extractTypeMetadata`). Add a light subpath
  afterward so tsc can't creep back in — but note a subpath **alone does not help** while the
  tsc users share a Worker, because **cost is per-Worker-project, not per-DO.**

**2. Consider splitting out any DO whose presence puts the main Worker bundle into the middle
tier.** Middle-tier behavior is unpredictable (So-what #4), so landing there is a latency risk
no bench can retire. After the tsc move the main Worker should be ~2.7 MB — the top of the small
tier — so this may not be needed at all. Let real user latency decide, one DO at a time.

**3. Do any splitting BEFORE the production wipe.** Moving a DO class between Workers projects
is a `transferred` migration: cheap now, materially harder once live tenants exist. The *design*
stays flexible either way, but the *migration cost is not flat over time*. If there is a strong
prior on a specific DO — the Gateway is the candidate, since it is on every client connect —
act during the wipe window rather than waiting for production data.

---

## Reproduce

```
node gen-arms.mjs      # emit all arms from the manifest
npm run deploy         # deploy all seven
npm run curve          # 10 rounds: create / warm / 20s idle / wake
```

Deployed workers are named `do-cs-<arm>`.
