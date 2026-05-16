# Playwright real-browser test template (prerequisite for nebula-frontend Phase 5.3.7-v2)

**Status**: not started. Prerequisite for `tasks/nebula-frontend.md` Phase 5.3.7-v2 (and any other package that bundles a NebulaClient-backed front end for real-browser testing).

**Goal**: a reusable real-browser test template for any `@lumenize/*` package that bundles a NebulaClient-backed front end. The template should be drop-in: a new package wanting real-browser coverage copies the vitest config + playwright shim + a test scaffold, and is up and running.

The Vue-in-DOM spike validated end-to-end behavior in jsdom + `@lumenize/testing`'s `Browser` class because three known transitive imports prevent real-browser bundling. Each is mechanical to fix; this task bundles all three with the test-template work so they ship together with regression-tests.

---

## Three known blockers

### 1. `@lumenize/debug` imports `cloudflare:workers`

Source: [packages/debug/src/index.ts](../packages/debug/src/index.ts) does `await import('cloudflare:workers')` in a try/catch for runtime auto-detection (per the CLAUDE.md "Cross-Platform Cloudflare Detection" pattern). Runtime in the browser succeeds (the catch fires); vite's ahead-of-time import-analysis fails before the catch can execute.

**Fix (recommended)**: rewrite the auto-detection to avoid the literal specifier. Options:
- Probe via `globalThis` for a known Workers-specific global (e.g., `globalThis.WebSocketPair` or `globalThis.caches?.default`) and only attempt the dynamic import when that probe passes.
- Use `Function('return import("cloudflare:workers")')()` to hide the specifier from static analysis. Uglier but cheaper change.

**Alternative**: document `optimizeDeps.exclude: ['cloudflare:workers']` + `build.rollupOptions.external: ['cloudflare:workers']` for consumers. Pushes config burden onto every package that depends transitively on `@lumenize/debug`, which is many — the rewrite is preferred.

- [ ] Pick the rewrite approach.
- [ ] Implement.
- [ ] Add a real-browser smoke test in `packages/debug/test/browser/` (vitest-browser-playwright) — import `debug` from a browser-bundled test file, assert it returns a no-op function in the browser and doesn't throw.

### 2. `@lumenize/mesh/client` pulls in `node:async_hooks`

Source: `lmz-api.ts` (used by both server and client paths) imports `AsyncLocalStorage` from `node:async_hooks`. The client-side path doesn't actually use ALS in any meaningful way — ALS is for server-side request-scoped `CallContext` propagation.

**Fix (recommended)**: split lmz-api into client-only / server-only modules. Re-export from `@lumenize/mesh/client` only the client-shaped surface; the server-shaped surface stays at `@lumenize/mesh` (or a `/server` subpath).

**Alternative**: lazy-load ALS-dependent code paths so the import only fires when actually needed. Works but leaves a runtime-only check around code that's structurally client-incompatible.

- [ ] Pick the split approach.
- [ ] Refactor.
- [ ] Add a real-browser smoke test in `packages/mesh/test/browser/` — bundle a `LumenizeClient` instance via the test, instantiate, assert it doesn't throw during module load.

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
