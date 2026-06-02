# Playwright real-browser test template (prerequisite for nebula-frontend Phase 5.3.7-v2)

**Status**: not started. Prerequisite for `tasks/nebula-frontend.md` Phase 5.3.7-v2 (and any other package that bundles a NebulaClient-backed front end for real-browser testing).

**Goal**: a reusable real-browser test template for any `@lumenize/*` package that bundles a NebulaClient-backed front end. The template should be drop-in: a new package wanting real-browser coverage copies the vitest config + playwright shim + a test scaffold, and is up and running.

The Vue-in-DOM spike validated end-to-end behavior in jsdom + `@lumenize/testing`'s `Browser` class because three known transitive imports prevent real-browser bundling. Each is mechanical to fix; this task bundles all three with the test-template work so they ship together with regression-tests. A fourth item (item #4 below) is a Node-side test failure of different category, filed here because it belongs to the same "browser-tier needs work before we trust it" theme.

---

## Known blockers

### 1. `@lumenize/debug` imports `cloudflare:workers` — ✅ DONE 2026-06-02

Shipped via cowork's `740274e` (debug split into `index.workerd.ts` / `index.node.ts` / `index.browser.ts` / `index.ts` with package-export conditions) + this-session's `a57bbc2` (added `@lumenize/auth/client` subpath, since the auth barrel was a separate transitive leak the debug refactor exposed). Esbuild bundle of `@lumenize/mesh/client` no longer references `cloudflare:workers`; the only remaining `cloudflare:workers`/`node:` blocker is item #2 below.

**Chose neither** of the originally-listed options (`globalThis` probe / `Function('return import')` hack) — they were premised on keeping a single `index.ts` with a runtime probe. The exports-conditions approach is cleaner: each entry file is statically import-correct for its runtime; the bundler never sees the unresolvable specifier in the wrong path because conditions pick the right file at resolve time. CLAUDE.md's "Cross-Platform Cloudflare Detection" section was updated in `986e27d` to document both approaches and when to use each (try/catch runtime guard for non-browser-bundled code; conditions for code that must be browser-bundleable).

**Verification** (this session): `npx esbuild packages/mesh/src/client-index.ts --bundle --platform=browser --format=esm --external:node:async_hooks` succeeds with 0 `cloudflare:workers` references. The `--external:node:async_hooks` workaround is the gap item #2 fills.

A real-browser smoke test for `packages/debug/` isn't in scope yet (no `test/browser/` directory exists in the debug package); will be picked up when the broader real-browser test template lands in v4.

- [x] Pick the rewrite approach. (Exports conditions, not literal-rewriting.)
- [x] Implement. (740274e + a57bbc2.)
- [ ] Real-browser smoke test in `packages/debug/test/browser/` — deferred to the v4 real-browser template scaffolding.

### 2. `@lumenize/mesh/client` pulls in `node:async_hooks` — ✅ DONE 2026-06-02

Note: the original framing — "the client-side path doesn't actually use ALS in any meaningful way" — turned out to be inaccurate. `LumenizeClient` DOES use ALS-style context preservation for the round-trip `runWithCallContext` at incoming-call handling (`lumenize-client.ts:902`), for `buildOutgoingCallContext`'s inheritance lookup, and for handler-execution context restoration at outgoing-call dispatch (`lumenize-client.ts:1054, :1061`). A naive removal would corrupt cross-await context reads inside `@mesh()` handlers.

**Chose package.json `imports`-field conditions** (the same pattern `@lumenize/debug` uses for its exports, but applied to internal `#`-imports). Two implementations of the same 2-function surface — `getCurrentCallContext()` / `runWithCallContext<T>(context, fn): T`:

- `packages/mesh/src/lmz-api-context.workerd.ts` — uses real `AsyncLocalStorage`. Selected by `workerd`/`worker`/`node` conditions (so Node, Bun, Deno, vitest-pool-workers, and Workers all get it).
- `packages/mesh/src/lmz-api-context.browser.ts` — module-scoped variable. Selected by `browser` condition. Does NOT preserve across `await` boundaries — file header documents the caveat in detail.

`packages/mesh/package.json` `imports` map:

```jsonc
"imports": {
  "#lmz-api-context": {
    "types": "./src/lmz-api-context.workerd.ts",
    "workerd": "./src/lmz-api-context.workerd.ts",
    "worker": "./src/lmz-api-context.workerd.ts",
    "node": "./src/lmz-api-context.workerd.ts",
    "browser": "./src/lmz-api-context.browser.ts",
    "default": "./src/lmz-api-context.workerd.ts"
  }
}
```

The `types` + `default` entries are load-bearing for TypeScript (`moduleResolution: bundler` doesn't match the runtime-specific conditions without a fallback) and for runtimes that don't match anything else.

`lmz-api.ts` now imports `getCurrentCallContext` / `runWithCallContext` from `#lmz-api-context` and re-exports them; `captureCallContext()` is unchanged and calls `getCurrentCallContext()` via the conditional binding.

**Browser caveat — safe vs unsafe usage**:
- ✅ Reading `this.lmz.callContext` synchronously inside an `@mesh()` handler before any await.
- ❌ Reading `this.lmz.callContext` AFTER an await inside an `@mesh()` handler when concurrent mesh calls might be in flight.

Verified 2026-06-02 that no existing client-side `@mesh()` handler in `apps/nebula/` reads `callContext` after an await — `handleTransactionResult`, `handleReadResponse`, `handleResourceUpdate` all branch on a synchronous result and never re-read callContext post-await. Future client code that needs full async-context preservation in the browser has documented escape hatches (TC39 `AsyncContext` proposal, zone.js monkey-patch, explicit closure threading).

**Verification**:
- `npx esbuild packages/mesh/src/client-index.ts --bundle --platform=browser --format=esm` succeeds with **0** `cloudflare:workers` references AND **0** `node:async_hooks` references — `@lumenize/mesh/client` is fully browser-bundleable now.
- Mesh vitest: 365/366 (1 skipped, 0 failed) — unchanged.
- Mesh `test:node-import`: 2/2 — unchanged.
- Nebula unit + baseline: 169/171 (0 failed) — unchanged.
- All 13 packages type-check cleanly.

- [x] Pick the split approach. (Package.json `imports` conditions, not subpath / lazy-load.)
- [x] Refactor.
- [ ] Real-browser smoke test in `packages/mesh/test/browser/` — deferred to the v4 real-browser template scaffolding.

### 3. NebulaAuth has no CORS headers

Source: `routeDORequest()` (or its NebulaAuth-specific caller) returns responses without `Access-Control-Allow-*` headers. For production this is a no-op — everything serves from `lumenize.com` / `nebula.lumenize.com` single-origin. For the real-browser test template, the test page lives at a `localhost:NNNN` Playwright origin and needs to call out to the deployed-via-miniflare NebulaAuth on a different port.

**Fix**: env-var-driven approved-origins list passed into `routeDORequest()`'s config. Default: empty list = same-origin only (safe by default). Test config sets `LUMENIZE_APPROVED_ORIGINS="http://localhost:5173,http://localhost:4173"` or similar.

Concretely:
- Wrangler binding name: `LUMENIZE_APPROVED_ORIGINS` (env var; comma-separated origins).
- `routeDORequest()` reads it once at request-handle time, compares the incoming `Origin` header, sets `Access-Control-Allow-Origin: <matched>` if the origin is in the list, otherwise omits the header.
- Preflight (`OPTIONS`) handling: respond `200` with `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers` reflecting the request, plus the matched origin.
- The env var is also relevant for future custom-domain aliases (e.g., `https://apps.acme.com/...`) — same mechanism applies, just with the alias origin in the list.

- [ ] Add `LUMENIZE_APPROVED_ORIGINS` to NebulaAuth's wrangler.jsonc binding documentation.
- [ ] Implement the parse + match + header-set logic in `routeDORequest()` (or its NebulaAuth wrapper).
- [ ] Add a unit test (worker test) asserting (a) no `Origin` header → no CORS headers in response; (b) `Origin` not in list → no CORS headers; (c) `Origin` in list → matching `Access-Control-Allow-Origin`; (d) preflight `OPTIONS` returns correct headers.
- [ ] Document in NebulaAuth's docs that this binding is required for non-same-origin browser clients.

### 4. `smoke.test.ts > round-trip` errors with null/undefined object conversion

**Different category from #1–#3** (those are browser-bundling failures caught by vite static analysis; this is a Node-side runtime test failure). Filed here because both belong to "browser-tier test issues that need investigation before we trust the tier for regression-gating."

Source: [apps/nebula/test/browser/smoke.test.ts](../apps/nebula/test/browser/smoke.test.ts) step 3 (`"3. round-trip — NebulaClient → Gateway → Star → Galaxy → result"`). Run in isolation against a local `wrangler dev` (no `BENCH_BASE_URL` override), a `client.callStarTransaction(...)` call sets:

```
client.lastError = "Cannot convert undefined or null to object"
```

Steps 1 (smoke baseline) and 2 (auth flow) pass when smoke runs alone. The message is the exact form thrown by `Object.{keys,entries,values,assign}(null|undefined)`.

**Diagnostic state (2026-05-16, on `feat/structured-clone-object-based-wire-format` after Phase 1+2 W4 wire-format work):**
- Baseline test-app (covering the same transaction round-trip code path through Star→Galaxy) **passes**.
- Direct `preprocess`→`postprocess` round-trip on the exact transaction payload shape (`{ [uuid]: { op, typeName, nodeId, value: { title } } }`) is **byte-identical** — the new W4 wire format is NOT mangling this shape.
- Phase 1+2 commits do not touch `apps/nebula/src/`, `packages/mesh/`, or `packages/rpc/` — only `packages/structured-clone/`. A regression localized to one browser-tier test while baseline passes through the same path is statistically unlikely.
- Pre-branch state at `feat/nebula-resources` tip (`70f1667`) **not bisected**: `npm install` at that tip fails with `zwitch@2.0.4 not found` (lockfile/registry mismatch), so the cheap bisect path was blocked.

**Plausible causes (likelihood order):**
1. **Pre-existing flakiness/breakage.** The browser tier was moved off the default `npm test` (run on-demand via `npm run bench`, per memory + the bench/regular tests sharing the directory). This test may have been broken for a while without anyone noticing.
2. A code path in `Star.doTransaction` or `Resources.transaction` calling `Object.keys` on a value that's null under timing-specific conditions baseline doesn't trigger (e.g., a cache-miss-then-Galaxy-fetch race).
3. Real Phase 1+2 regression in a code path baseline doesn't exercise — possible but unlikely given the probe + zero consumer-code changes.

The `InstrumentedNebulaClientGateway` (bench-only subclass) is bound in the local browser-test wrangler config as `NebulaClientGateway` via aliased export. The bench_marker frames it emits trigger an `"Unknown Gateway message type: bench_marker"` warning on the unchanged client — that's stderr noise, not the failure, but it's another small contract-drift hint worth checking during investigation.

**Investigation approach:**
- [ ] Instrument `Star.doTransaction` / `Resources.transaction` (or the request-handling chain on the server) to capture the stack trace of the actual throw, not just propagate the message. The current `lastError` carries only `.message` — the stack would localize the null/undefined origin.
- [ ] Definitively classify pre-existing vs regression — either fix the deps issue at `70f1667` and bisect, or check CI history for prior smoke runs.
- [ ] Fix the actual bug, OR document the test's expected operating mode (e.g., "requires `BENCH_BASE_URL` pointing at a deployed worker; otherwise xfail"), OR `it.skip` with a clear TODO if the root cause needs deeper rework.

---

## The test template itself

After the three blockers land:

- [ ] Author a reference `vitest.config.ts` + `playwright.config` pair for vitest-browser-playwright, mirroring `packages/structured-clone/vitest.config.js`'s shape where applicable.
- [ ] Author a reference `test/browser/setup.ts` that wires up a NebulaClient against a miniflare-served Nebula stack with the CORS env var set for `http://localhost:5173` (Playwright's default).
- [ ] Author a reference test file showing the canonical pattern: import the bundled front end, instantiate `createNebulaClient(...)`, drive a transaction, assert the optimistic store + the committed eTag.
- [ ] Document the template in a new docs page or section: "Real-browser testing for `@lumenize/*` packages" — link from `packages/nebula-frontend/README.md` and from any other package using the template.

---

## Deletion

This file gets archived to `tasks/archive/playwright-test-template.md` once the template is live and at least one consumer package (likely `@lumenize/nebula-frontend`) has adopted it.

---

## Open question (defer)

Whether the `@lumenize/debug` rewrite generalizes to a "Cross-Platform Cloudflare Detection" helper exported from one of the foundation packages, so that any future Lumenize package needing the same pattern doesn't reinvent it. Not blocking; revisit if a second package needs it.
