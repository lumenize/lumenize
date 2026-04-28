# Nebula: Deployable + Browser Test Harness

**Status**: Not started — split out 2026-04-28 from `tasks/parse-validate-release.md` after discovering Nebula doesn't currently start under real `wrangler dev`.
**Depends on**: 5.2.4.2 (landed)
**Unblocks**: `tasks/parse-validate-release.md` Phase 1 (integrated bench), `tasks/nebula-5.3-subscriptions.md` (reactivity tests), any future production deployment of Nebula
**Considered for retrofit**: Lumenize Mesh tests (same auto-spawn pattern is broadly useful — see Phase 2 below)

## Why this exists

Two coupled concerns surfaced together:

1. **Nebula doesn't start under real `wrangler dev`.** Importing any one of `@lumenize/nebula`'s DO classes (even just `Universe`) into a Worker that runs under `wrangler dev` crashes at module-load with `Cannot read properties of undefined (reading 'slice')`. Vitest-pool-workers' miniflare hides the bug because it has different env-initialization timing. **Implication**: Nebula has never been deployed to production, and currently *cannot* be deployed via standard `wrangler deploy` either (deploy bundles the same way dev does). This is a production-blocking bug, not a test-only quirk.

2. **There is no Node/browser-driven test platform for NebulaClient end-to-end.** All existing Nebula tests run inside vitest-pool-workers, where `performance.now()` is pinned by Cloudflare's Worker isolate semantics — honest wall-clock timing is impossible. Worse, NebulaClient itself is meant to run in a real browser (it uses `sessionStorage`, `BroadcastChannel`, native `WebSocket`), and we've never exercised it in that environment. The `@lumenize/mesh/client` Node-compatible entry point exists but is currently unproven.

These solve together because the harness needs `wrangler dev` to work, and `wrangler dev` working unblocks deploy.

## Phase 1: Diagnose and fix the `wrangler dev` startup bug

**Goal**: Make `wrangler dev` (and by extension `wrangler deploy`) work for any Worker that imports from `@lumenize/nebula`.

### What we know (bisection findings, 2026-04-28)

- **Symptom**: `Uncaught TypeError: Cannot read properties of undefined (reading 'slice')` at module load. Error reported as `index.js:<bundle-line>:1003` (column 1003 is constant across runs; line varies with bundle size).
- **Trigger**: Just `export { Universe } from '@lumenize/nebula'` is enough. No `@lumenize/nebula-auth`, no `@lumenize/auth` direct import needed. The crash is in nebula's transitive import chain.
- **NOT the trigger**:
  - `@lumenize/debug` alone — starts cleanly.
  - `@lumenize/nebula-auth` alone (using its own `packages/nebula-auth/test/wrangler.jsonc`) — starts cleanly.
  - `@lumenize/auth` standalone — passes static checks (we couldn't get past static checks to runtime, but the crash didn't reproduce in isolation).
- **Why miniflare hides it**: vitest-pool-workers' miniflare initializes the env binding state earlier than wrangler dev's runtime does, so module-level reads of `something.SOMETHING` succeed in miniflare but fail in dev. The `.slice(undefined)` is consistent with `someEnvVar.slice(...)` where `someEnvVar` is undefined at the moment of evaluation.
- **Bundling clue**: column 1003 is suspiciously constant. Suggests a fixed offset from a module-level pattern that gets consistently bundled in the same shape across runs.

### Diagnostic next steps

- [ ] Use the source map (`/tmp/wrangler-out/index.js.map` from a `--dry-run --outdir`) to map a crashing line/col back to a source file. Note: dev's minified bundle differs from `--dry-run`'s un-minified output, so the col/line numbers don't transfer directly. Try producing a minified bundle outside wrangler and matching positions.
- [ ] Alternatively: configure wrangler to emit a non-minified dev bundle (or use `WRANGLER_BUILD_CONDITIONS` / `--minify=false` if available) so stack frames are readable.
- [ ] Search the dependency tree for module-level patterns of the form `globalThis.X.slice(...)`, `env.X.slice(...)`, or top-level-await constructs that resolve and then dereference.
- [ ] Check `@lumenize/structured-clone` — it has runtime registries populated at module load that the other packages depend on. Suspect: a registry expecting a specific global to exist by initialization time.

### Fix

- [ ] Patch the offending module-level code to handle the "env not yet ready" case (likely defer the read to first-use, or guard with `??`).
- [ ] Add a regression test: a vitest project that runs the equivalent of "spawn `wrangler dev` against a Worker that imports `@lumenize/nebula`, verify it becomes ready." Could live in this task's harness (see Phase 2) — that *is* the regression test.
- [ ] Confirm `wrangler deploy --dry-run` succeeds with the same Worker (catches deploy-time bundle quirks that dev might mask).

### Success criteria

- [ ] `wrangler dev` starts cleanly against a minimal Worker that exports the standard Nebula DO bindings.
- [ ] Root cause documented in this task file (file + line + minimal repro).
- [ ] Regression coverage: the Phase 2 harness exercises the imports, so a future regression resurfaces immediately.

## Phase 2: Vitest browser harness with auto-spawn `wrangler dev`

**Goal**: A real-browser (Playwright/Chromium) test platform that runs alongside an auto-spawned `wrangler dev` Worker, exposes the URL via vitest's `provide()`, and tears down on teardown. Reusable for parse-validate-release Phase 1 (integrated bench), 5.3 reactivity tests, and any future Nebula end-to-end testing.

### Uncommitted state at handoff (2026-04-28)

The previous session left these uncommitted on `feat/nebula-resources` and they should all be **kept** (no revert needed). Bisection-only probe files (`wrangler-bisect.jsonc`, `minimal.ts`, `probe-nebula-only.ts`) were already cleaned up before handoff:

| File | Status | Why keep |
| --- | --- | --- |
| `apps/nebula/package.json` | modified | Added `@vitest/browser`, `@vitest/browser-playwright`, `playwright` devDeps + `bench` script. Needed for the harness. |
| `apps/nebula/vitest.config.js` | modified | Added `browser` and `browser-bench` projects (Playwright/Chromium, headless, with globalSetup). Needed for the harness. |
| `package-lock.json` | modified | Reflects the new devDeps. Needed. |
| `apps/nebula/test/browser/global-setup.ts` | new | Auto-spawn wrangler dev, free-port pick, ready-detection, teardown. Phase 2 deliverable. |
| `apps/nebula/test/browser/smoke.test.ts` | new | Minimum probe (fetch base URL, assert status 200-599). Will expand once Phase 1 fix lands. |
| `apps/nebula/test/browser/worker/index.ts` | new | Mirrors baseline test-app DO wiring minus `instrumentDOProject()`. Currently triggers the Phase 1 bug — that's expected and is the regression test. |
| `apps/nebula/test/browser/worker/wrangler.jsonc` | new | Full Nebula bindings + auth + rate limits. Has a `.dev.vars` symlink (auto-created by `scripts/setup-symlinks.sh`). |
| `tasks/nebula-deployable-and-browser-harness.md` | new | This file. |
| `tasks/nebula-5.3-subscriptions.md` | modified | Added "consider exporting harness" note + "consider Mesh retrofit" note. Wanted regardless of when this task lands. |
| `tasks/parse-validate-release.md` | modified | Phase 0 findings recorded; tsc-baseline dropped; Phase 1 marked blocked on this task. All real decisions; keep. |

If a fresh session is unsure whether to commit the harness scaffolding before fixing the bug: **commit it.** The scaffolding is correct work and the smoke test currently failing is the regression test that proves Phase 1 is fixed.

### What's already scaffolded (2026-04-28, before this task split out)

Living at `apps/nebula/test/browser/` and `apps/nebula/test/browser/worker/`:

- `apps/nebula/vitest.config.js` — adds two new projects (`browser` and `browser-bench`) using `@vitest/browser-playwright`, headless Chromium, with `globalSetup` pointing at the auto-spawn script.
- `apps/nebula/package.json` — adds `@vitest/browser`, `@vitest/browser-playwright`, `playwright` devDeps and a `bench` npm script.
- `apps/nebula/test/browser/global-setup.ts` — picks a free port via `net.createServer`, spawns `npx wrangler@4.84.0 dev` against the worker config, parses `Ready on http://...` from stdout, exposes URL via `project.provide('wranglerBaseUrl', url)`. Returns a teardown function that SIGINTs (then SIGKILLs after 5s) the wrangler process. Includes a TypeScript module augmentation declaring `wranglerBaseUrl` on `ProvidedContext`.
- `apps/nebula/test/browser/smoke.test.ts` — minimum probe (`inject('wranglerBaseUrl')`, fetch base URL, assert 200-599 status).
- `apps/nebula/test/browser/worker/index.ts` — currently a bisection probe (varies); should ultimately mirror `apps/nebula/test/test-apps/baseline/index.ts` minus `instrumentDOProject()` (the lumenize-rpc instrumentation isn't needed for mesh-driven tests).
- `apps/nebula/test/browser/worker/wrangler.jsonc` — copy of baseline's wrangler.jsonc (full Nebula DO bindings + auth + rate limits). Has a `.dev.vars` symlink (auto-created by `scripts/setup-symlinks.sh`).
- `apps/nebula/test/browser/worker/wrangler-bisect.jsonc` — minimal bindings, used during bisection. Can be deleted once Phase 1 is fixed.

### What's left to build

- [ ] Phase 1 must be done first — the harness can't smoke-test until `wrangler dev` actually starts.
- [ ] Restore `apps/nebula/test/browser/worker/index.ts` to the full baseline-test-app shape (DOs + StarTest, no instrumentDOProject).
- [ ] Delete `wrangler-bisect.jsonc` once it's no longer needed.
- [ ] `apps/nebula/test/browser/auth-bootstrap.ts` — `?_test=true` magic-link → access JWT helper. Same shortcut already used by vitest tests via `Browser`, but driven from browser-side fetch + cookie capture. This runs in the browser test context (real Chromium has cookies-and-fetch built in).
- [ ] `apps/nebula/test/browser/bench-client.ts` — `NebulaClientBench extends NebulaClient` with `@mesh()` overrides for `handleTransactionResult` / `handleReadResult`, mirroring `NebulaClientTest`'s pattern but living browser-side. Captures results into instance fields + `callCompleted` flag.
- [ ] Expand `smoke.test.ts` to a real round-trip: bootstrap auth → register an ontology → fire a `callStarTransaction` → poll `callCompleted` → assert the transaction succeeded. Proves the full client → Gateway → Star → Galaxy → facet → callback path works from a real browser.
- [ ] (Reactivity tests live in `tasks/nebula-5.3-subscriptions.md` — they'll inherit this harness, not be built here.)

### Success criteria

- [ ] `npm test` (from `apps/nebula/`) runs the browser project; smoke test passes.
- [ ] Smoke test exercises the full client → Gateway → Star → Galaxy → facet → callback round-trip.
- [ ] Auto-spawn pattern documented in this file's "How it works" section so it's transparent to future maintainers.
- [ ] No manual prerequisite: `npm test` doesn't require a separately-running wrangler dev.

## Phase 3 (optional, if scope allows): retrofit the auto-spawn pattern to Lumenize Mesh

**Goal**: Same vitest-browser globalSetup pattern in `packages/mesh/`, so any future mesh test that needs honest wall-clock timing or browser-platform fidelity (sessionStorage, native WebSocket) has a runway.

Out of scope for parse-validate-release. Treat this as a follow-on once Nebula's harness is proven.

## Relationship to other tasks

- **`tasks/parse-validate-release.md` Phase 1** is currently blocked on this task. Two paths once this lands:
  - Phase 1 of parse-validate-release becomes a thin `bench.bench.ts` on top of this harness.
  - OR parse-validate-release skips Phase 1 entirely (goes straight to drafting 2a/2b with bare-facet numbers and a "integration overhead is its own post" footnote). Decide once we're not in the middle of debugging.
- **`tasks/nebula-5.3-subscriptions.md`** will use this harness for reactivity/subscription tests. It already has a "Consider promoting harness to public subpath export" note.
