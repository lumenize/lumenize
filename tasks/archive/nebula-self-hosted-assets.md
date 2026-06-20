# Nebula — Self-hosted platform libraries + strict `script-src`

> **⚠️ PARKED 2026-06-17 — proven baseline, likely superseded.** Built + green, but the
> in-DO-compile + vendored-assets approach hit the ceilings catalogued in § As-built
> (workerd isolate-load limit, no Tailwind JIT / minimal CSS, no per-app platform-lib
> pinning). We're spiking a **dev-only Cloudflare Container running real vite + `vite build`
> → static assets for prod** (`tasks/container-vite-spike.md`). If that pivots, the
> UI-build half here (in-DO SFC compile, the specifier rewrite, the vendored-asset serving)
> is superseded; the data layer is untouched either way. The two bug fixes below
> (`nodejs_compat`, `bindingMetadata`) are correct regardless. Don't build on this until
> the spike's go/no-go.

**Status**: ✅ BUILT 2026-06-17 (`feat/nebula-studio`, uncommitted) — both phases green; unit+frontend+baseline = 444 passed/2 skipped, the real-chromium mount test passes under strict `script-src 'self'`, `tsc --noEmit` clean. A detour off #1a's committed serving path. **Parked pending `tasks/container-vite-spike.md` (see banner above).**
**Phase**: Studio build-seq #1a-hardening.
**App**: `apps/nebula/` — Mesh platform layer.

## As-built (2026-06-17)

Decisions/divergences settled in build (all intended; the design left these open or empirical):
- **Platform assets served from CODE, not per-Star storage.** `Star.onRequest` resolves the Vue runtime / DaisyUI CSS / Lucide icons / the `nebula-frontend` placeholder via `getPlatformAsset()` ([platform-assets.ts](../apps/nebula/src/platform-assets.ts)) from a committed generated bundle ([vendor/platform-assets.generated.mjs](../apps/nebula/vendor/platform-assets.generated.mjs)), checked **before** the `AppBundle` storage lookup. Rationale: platform-fixed + prod parity + avoids ~1700 SQLite row writes/Star (durable-objects.md write costs). The staged `vue.js` is a re-export shim of `./vendor/vue.js` (the task's "VUE_RUNTIME_JS re-exports the vendored same-origin Vue").
- **Lucide: full ~1700-icon set vendored, but SHARED core + tiny per-icon data.** `vendor/lucide/_core.js` (esbuild-bundled `createLucideIcon`, `vue` external→`../../vue.js`) is imported by each tiny per-icon module (~300 B). Self-contained per-icon bundling duplicated the ~1.5 KB runtime ×1700 (~2.5 MB) and **the 5.5 MB generated module crashed the workerd isolate at load**; sharing the core keeps it ~1.8 MB (loads fine). Served per-icon → only imported icons cross the wire (chromium test asserts only `house.js` + `_core.js`).
- **Lucide v1.0.0 renamed `home`→`house`** (no `home.js`) → fixture uses `house`. **Lucide is ISC** (not MIT as the draft said; both permissive/allowlisted) → ATTRIBUTIONS says ISC. **DaisyUI v5 `daisyui.css` is browser-valid plain CSS** (only native `@layer`) → vendored verbatim, **no `tailwindcss` needed/installed**.
- **Two latent #1a bugs found + fixed (folded in here — they blocked the real-chromium mount):**
  1. **`nodejs_compat_v2` → `nodejs_compat`** across all 4 nebula wranglers. The standalone `nodejs_compat_v2` flag does **not** resolve `node:` builtins in real `wrangler dev` (4.86), so `@vue/compiler-sfc`'s `node:os` import crashed worker startup (`No such module "node:os"`). vitest-pool-workers polyfilled it independently, masking the bug — but **prod deploy + the real-browser harnesses were latently broken** since #1a. `nodejs_compat` (with our compat_date) gives v2 semantics AND resolves `node:` builtins. → [[nodejs-compat-not-v2-suffix]]
  2. **`compile-module.ts` now threads `compileScript().bindings` into `compileTemplate({ compilerOptions: { bindingMetadata } })`.** Without it the separately-compiled template emitted generic `_ctx.x` + `_resolveComponent("X")`, so a `<script setup>` SFC (whose `count`/`House` live in setupState) rendered **blank values + unresolved components** — the deferred #1a T3 "module never actually run" path. Does NOT change emitted specifiers (still bare `vue`; the rewrite stays at the DevStar write boundary). → [[sfc-compile-needs-bindingmetadata]]
- **Chromium adapter (in-scope sub-task):** a path-preserving `/dev-star` vite proxy (no prefix strip) with `approvedOrigin` rewrite, so the iframe loads the preview same-origin at the path the worker-injected `<base href>` expects and module-script CORS passes. Compile runs via the factory admin session (`client.lmz.call('DEV_STAR', …, compileSFC)`); the ungated static GET needs no auth.

## Why

1. **Secure-by-default.** #1a serves the Vue runtime from `https://cdn.jsdelivr.net` ([app-bundle.ts:106-108](../apps/nebula/src/app-bundle.ts)) under `script-src 'self' https://cdn.jsdelivr.net` ([star.ts:47](../apps/nebula/src/star.ts)). A loose `script-src` with an external origin is visible to the first tester who opens devtools and contradicts Nebula's secure-by-default tagline.
2. **The platform libraries are prerequisites.** Every generated app needs **styling (DaisyUI, pinned in `nebula-studio.md` § Code-generation)** and **icons (Lucide)**; self-hosting them is prerequisite to Studio generation, the same as the compile/serve substrate.

A latent gap this closes: the compiled SFC emits **bare `vue`** ([compile-module.ts](../apps/nebula/src/compile-module.ts)), but the shell has no import map — so a real browser load can't resolve it today (1a verifies the compiled module *structurally*, never runs it — the deferred T3 preview). Self-hosting requires pinning how bare specifiers resolve.

## Goal

Serve Vue runtime + DaisyUI + Lucide **same-origin** (platform-fixed; fixed location, never per-version, never CDN), and tighten **`script-src` to `'self'`** — a `script-src`-only change (`style-src 'self' 'unsafe-inline'` **stays** for Vue's inline scoped styles).

**Resolution = compile-time specifier-rewrite at the DevStar *write* boundary** — post-`compileSFCToModule`, in `dev-star.ts` where `App.js` is written, **NOT** in the shared `compile-module.ts` (which keeps emitting canonical bare specifiers, so the jsdom test's own bare-`vue`→stub rewrite and the documented `CompileModuleResult.module` contract are untouched). Bare → relative same-origin: `vue` → `./vue.js`, `lucide-vue-next/icons/home` → `./vendor/lucide/home.js`. **Only allowlisted platform specifiers (`vue`, `lucide-vue-next/icons/*`) are rewritten; any other bare specifier is a compile error returned in `CompileModuleResult.errors`** (feeding Studio's iterate-on-errors loop) — never silently emitted (an unrewritten bare specifier under `script-src 'self'` is a silent same-origin 404). No import map (which strict `script-src` would block inline without a nonce); per-icon files keep icons granular without a bundler.

## B1 — DaisyUI/Lucide sourcing (decided 2026-06-17)

**Install `daisyui` (+ `tailwindcss` if needed to emit the CSS) + `lucide-vue-next` as devDeps** (approved — these were not previously installed), plus a **regen script that produces the committed vendored artifacts** (DaisyUI precompiled CSS; the Lucide per-icon ESM) — mirroring `bundle-tsc.mjs` (documented, scripted, reproducible). Pin exact versions, an in-repo vendored location, and add **ATTRIBUTIONS.md entries (DaisyUI + Lucide, both MIT)**.

## Phases

### Phase 1 — Vendor same-origin + the rewrite
- Vendor Vue 3.5 runtime-only ESM (~22 KB, CSP-safe), DaisyUI precompiled CSS (linked from the shell `<link rel="stylesheet">`, under the unchanged `style-src`), Lucide per-icon ESM — per the § B1 sourcing decision.
- Add the specifier-rewrite at the DevStar write boundary (above). `app-bundle.ts` `VUE_RUNTIME_JS` re-exports from the vendored same-origin Vue (drop jsdelivr).
- **Success criteria (real chromium — `apps/nebula/test/chromium`):** a checked-in fixture SFC (a DaisyUI `btn` class + `import Home from 'lucide-vue-next/icons/home'` + a `ref`), served by a wrangler-dev DevStar through the existing same-origin proxy, **mounts in real chromium with no CSP console violation**; a network assertion that **`lucide/home.js` loaded and no other `lucide/*` did**; DaisyUI CSS applies; an un-vendored bare specifier **fails compile** (asserted). *(If pointing the chromium harness at a DevStar-served preview — vs. the existing factory-mount harness — needs a small adapter, that adapter is an in-scope Phase-1 sub-task.)*

### Phase 2 — Tighten `script-src`
- `star.ts` `APP_CSP` → `script-src 'self'` (drop `https://cdn.jsdelivr.net`); keep no-`unsafe-eval`; `style-src` unchanged.
- **Success criteria:** a serving test asserts the CSP header carries **no `https://` script source, no `unsafe-eval`, and no inline import map**; the existing #1a serving tests (`dev-star-compile.test.ts`, onRequest/CSP) stay green.

## Deferred (separate)
- **Dynamic `import('<bare>')` is neither rewritten nor flagged** by `rewriteServedSpecifiers` (only static `import`/`export … from` + bare side-effect imports are). Compiled SFCs from `@vue/compiler-sfc` don't emit dynamic platform imports, and a strict `script-src` blocks eval-style dynamic resolution anyway, so it's not a demo gap — but a bare dynamic import would pass compile silently instead of feeding the iterate-on-errors loop. Backlog: extend the rewrite to also catch `import(<string-literal>)`. (Flagged by the build verifier.)
- The real `@lumenize/nebula/frontend` factory bundle + running against the live store — #1a's T3 "make the preview run the factory" (the `./vendor/nebula-frontend.js` placeholder is already same-origin, so it satisfies `script-src 'self'`).
- The granular-icon convention in the Studio-LLM docs — lands with Studio generation (the serving supports granular now; the Phase-1 fixture verifies it).
- A clarifying note in `using-vue.md` § Security that the *served* path uses self-hosted libraries + the compile-time rewrite (no inline import map). The § already scopes the CDN/import-map shape to non-Studio/standalone use, so this is a clarification, not a contradiction — small doc follow-up.
- Per-app Tailwind JIT (DaisyUI precompiled only); **a real tree-shaking bundler** (deferred + feasibility-uncertain in a single DO — esbuild build-time-only here; esbuild-wasm Go-glue finicky in workerd; a spike when revisited — esbuild-wasm in a facet vs. a Worker Loader; prior art `experiments/{dwl-spike,dw-bundler-spike}`). Revisit only if served-bundle size bites.

## References
`tasks/nebula-studio-compile-pipeline.md` (#1a — `app-bundle.ts` `VUE_RUNTIME_JS`/`SCAFFOLD`, `star.ts` `APP_CSP`, `compile-module.ts`, the `dev-star.ts` write boundary); `tasks/nebula-app-versioning.md` (#1b); `tasks/nebula-studio.md` (§ Code-generation details — DaisyUI); `apps/nebula/test/chromium` (the real-browser harness); `website/docs/nebula/using-vue.md` § Security.
