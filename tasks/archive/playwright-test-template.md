# Playwright real-browser test template (prerequisite for nebula-frontend Phase 5.3.7-v2)

**Status (2026-06-03)**: **All v2 prereqs done AND the real-browser template itself is live in `packages/mesh/`.** The mesh package now has a working two-tier browser test suite (bundle + full e2e through a real `wrangler dev` worker), and the template's reusable parts (proxy plugin, global-setup pattern, deploy bootstrap) are documented for other packages to adopt. Suggested next: when standing up the nebula-frontend Phase 5.3.7-v2 real-browser tests, copy from `packages/mesh/test/browser/` per the checklist in `packages/mesh/test/browser/README.md`.

`npm test` baseline (apps/nebula): **174 passed | 4 skipped | 0 failed** across unit + baseline + browser projects (up from 169 passed | 2 skipped pre-fixes — net +5 passing tests, the previously-flaky concurrent browser tier now reliable).

`@lumenize/mesh` browser tier: **4/4 green** (3 bundle-and-instantiate + 1 full WS round-trip through real Cloudflare Email Sending → Email Routing → `wrangler dev` worker → DocumentDO + SpellCheckWorker).

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

### 2. `@lumenize/mesh/client` pulls in `node:async_hooks` — ✅ DONE 2026-06-03

**Two-step journey** worth recording because the first try ran into a V8 reality the original framing didn't anticipate:

**Step 1 (2026-06-02)** — package.json `imports`-field conditions with two impls of `getCurrentCallContext` / `runWithCallContext`: `lmz-api-context.workerd.ts` (real `AsyncLocalStorage`) for workerd/worker/node, `lmz-api-context.browser.ts` (module-scoped variable shim) for browser. Bundle clean. But the browser shim couldn't preserve context across `await` because the module var gets stomped when concurrent calls re-enter. Original plan was to ship with a documented caveat + lint rule.

**Spike (2026-06-03)** — tried building a real ALS polyfill in the browser via Promise.prototype.then patching to fix the cross-await issue. Confirmed empirically that V8 has an `await` fast-path that bypasses user-visible `.then` even when patched. Tried the well-known mitigation of replacing `globalThis.Promise` with a subclass (forces V8 to slow path). The slow path WAS reached for explicit `.then` chains but NOT for native `await` resumes — V8 schedules the `.then` call via a microtask that fires AFTER `run()`'s `finally` has already restored the previous context, so by the time patched `.then` captured a snapshot it was empty. Polyfilling ALS for native await in the browser requires zone.js-style intervention (global Promise replacement + scope-stack instead of restoration-on-return), which we judged too heavy. Polyfill spike reverted.

**Step 2 (final, 2026-06-03)** — refactored `lumenize-client.ts` framework code to thread `CallContext` **explicitly** through closures + a private instance field, dropping its dependence on ALS-style lookup:

- `#handleIncomingCall` sets `this.#currentCallContext = callContext` synchronously, no `runWithCallContext` wrap.
- `#callRaw` takes an explicit `parentContext: CallContext | undefined` parameter; builds the outgoing context via a new local `buildClientOutgoingContext(callerIdentity, parentContext, options)`.
- `#call` captures `this.#currentCallContext` synchronously at the call site, threads it as a closure to the handler executor (which restores `#currentCallContext` to the captured value for the duration of handler execution) AND as an explicit argument to `#callRaw`.
- Removed value imports of `runWithCallContext`, `captureCallContext`, `buildOutgoingCallContext`, `createHandlerExecutor` from `./lmz-api.js`. Only `extractCallChains`, `setupFireAndForgetHandler`, and the `CallEnvelope` type remain.
- Public `LmzApiClient.callRaw` signature unchanged (back-compat); internally adapted by capturing `#currentCallContext` at the binding site.

`lmz-api-context.workerd.ts` and `lmz-api-context.browser.ts` are kept — the conditional split still serves the SERVER-side files (`lumenize-do.ts`, `lumenize-worker.ts`, the shared helpers in `lmz-api.ts`). They don't get loaded by the client bundle because client framework no longer imports the ALS helpers as values.

`this.lmz.callContext` (user-facing API) reads `self.#currentCallContext` directly. Synchronous reads in a `@mesh()` handler are correct. The cliff (reads AFTER an `await` when concurrent calls are in flight) remains, but no current `@mesh()` handler in `apps/nebula/` triggers it, AND framework correctness no longer depends on it: the framework captures parent context synchronously at every `lmz.call(...)` entry, before any await yields control.

For future cleanups: see [tasks/nebula-scratchpad.md](nebula-scratchpad.md) § Mesh Infrastructure for the ALS-polyfill watch item — when TC39 `AsyncContext` ships natively or a battle-tested userland polyfill emerges, swap in for `lmz-api-context.browser.ts` to close the user-facing cliff too.

**Verification**:
- `npx esbuild packages/mesh/src/client-index.ts --bundle --platform=browser --format=esm` succeeds with **0** `cloudflare:workers` AND **0** `node:async_hooks` references (64.4 kB).
- Mesh vitest: 365/366 (1 skipped, 0 failed).
- Mesh `test:node-import`: 2/2.
- Nebula unit + baseline: 169/171 (0 failed).
- All 13 packages type-check cleanly.

- [x] Pick approach. (Explicit threading, not polyfill — V8 await-optimization makes the polyfill impractical without zone.js-style intervention.)
- [x] Refactor.
- [ ] Real-browser smoke test in `packages/mesh/test/browser/` — deferred to the v4 real-browser template scaffolding.

### 3. NebulaAuth has no CORS headers — ✅ DONE 2026-06-03

`routeDORequest()` already had comprehensive CORS support (allowlist / permissive / function-validator modes, preflight handling, server-side origin rejection). The actual gap was two-sided: `routeNebulaAuthRequest` (hand-rolled router, not delegating to `routeDORequest`) had no CORS at all, and `apps/nebula/src/entrypoint.ts` wasn't passing `cors` to either router. The fix extracts the shared policy into one helper and wires the env var at the entrypoint.

**What landed**:
- `@lumenize/routing` exports a new `applyCorsPolicy(request, corsOptions)` helper (returns `{ earlyResponse?, allowedOrigin }`). `routeDORequest` is refactored to use it (zero behavior change — all 125 existing tests pass unmodified).
- `routeNebulaAuthRequest` now accepts a `cors?: CorsOptions` option (new exported `RouteNebulaAuthOptions` interface) and uses `applyCorsPolicy` + `addCorsHeaders` from `@lumenize/routing`. Path matching happens first so non-matching paths still fall through to `undefined` cleanly.
- `apps/nebula/src/entrypoint.ts` reads `env.LUMENIZE_APPROVED_ORIGINS`, parses comma-separated → array, builds `cors: { origin: [...] }` (or `false` when empty/unset), and threads the SAME config through the three router calls (nebula-auth, gateway, direct-DO). One source of truth per deploy.
- `apps/nebula/wrangler.jsonc` declares `LUMENIZE_APPROVED_ORIGINS: ""` (safe same-origin default).
- `apps/nebula/test/browser/worker/wrangler.jsonc` sets `LUMENIZE_APPROVED_ORIGINS: "http://localhost:5173,http://localhost:4173"` so the deployed-via-miniflare browser-test worker is ready for the Playwright origins when the v4 template lands.

**Tests** (`packages/nebula-auth/test/nebula-auth-cors.test.ts`, 11 cases): no Origin → no headers (default + with cors set); `cors: true` reflects any origin; allowlist mode covers no-Origin / disallowed-Origin (403, no headers) / allowed-Origin (wraps response + Vary) / multiple allowed origins; preflight `OPTIONS` covers allowed (204 + headers) and rejected (204 no headers); path-mismatch with cors set still returns `undefined` (composability).

**Why env-driven**: same `entrypoint.ts` binary across same-origin production (`lumenize.com`), custom-domain deploys (`apps.acme.com`), and Playwright test rigs (`localhost:5173`). Each environment supplies its own approved-origin list via wrangler vars; no code change per deploy.

**Docs**: `website/docs/routing/cors-support.mdx` documents `applyCorsPolicy` as a reusable helper (with a `@check-example` pointer to the actual nebula-auth router showing the canonical pattern); `website/docs/nebula/auth-flows.md` has a new "Cross-origin browser deploys" section explaining when `LUMENIZE_APPROVED_ORIGINS` is needed and the example wrangler-vars syntax.

**Verification**: routing 125/125, nebula-auth 283/283 (272 + 11 new), nebula app 169/171 (2 pre-existing skips, 0 failed). Type-checks clean for routing, nebula-auth, apps/nebula.

- [x] Add `LUMENIZE_APPROVED_ORIGINS` to NebulaAuth's wrangler.jsonc binding documentation. (Lives in `apps/nebula/wrangler.jsonc` since that's the consumer; library packages don't bind it.)
- [x] Implement the parse + match + header-set logic. (Shared `applyCorsPolicy` helper; `routeNebulaAuthRequest` uses it.)
- [x] Add unit tests for the four cases.
- [x] Document in NebulaAuth's docs that this binding is required for non-same-origin browser clients.

### 4. `smoke.test.ts > round-trip` errors with null/undefined object conversion — ✅ DONE 2026-06-03

**Root cause: stale test-helper signature (option 1 from the diagnostic list — pre-existing breakage).** Not a Phase 1+2 wire-format regression.

Commit `9c6dd7c` ("5.3.3b from nebula-frontend.md done", 2026-05-12) added `newETag` as `Star.transaction`'s 2nd parameter (signature: `transaction(ontologyVersion, newETag, ops)`). The baseline test app's `NebulaClientTest.callStarTransaction` (`apps/nebula/test/test-apps/baseline/index.ts:374-389`) was updated to match — generates `newETag = newETag ?? crypto.randomUUID()` and passes three args. The **browser** smoke test's `HarnessNebulaClient.callStarTransaction` was missed:

```typescript
// HarnessNebulaClient (stale, 2-arg call):
this.lmz.call('STAR', starName, (this.ctn() as any).transaction(ontologyVersion, ops));
// Star saw ontologyVersion='v1', newETag=<the ops Record>, ops=undefined
// → Resources.transaction at apps/nebula/src/resources.ts:265 does
//   `Object.entries(ops)` → throws "Cannot convert undefined or null to object"
```

Static analysis alone was sufficient — instrumentation not needed.

**Fix applied**: refactored `apps/nebula/test/browser/smoke.test.ts` step 3 to use the **public API** `await client.resources.transaction({...})` instead of the stale test-initiator pattern. Public API generates the eTag internally, threads ontologyVersion from the client config, and returns a `TransactionResolution` discriminated union; test now asserts `outcome.resolution === 'committed'` and `outcome.eTag` is a string. Dropped the now-unused `handleTransactionResult @mesh()` override and `callStarTransaction` test-initiator from `HarnessNebulaClient`. Galaxy ontology registration remains on the test-initiator pattern (no public API — admin-only).

**Verification** (local `wrangler dev`, no `BENCH_BASE_URL` override): `npx vitest run --project browser test/browser/smoke.test.ts` → 3/3 across both isolated and serial runs. Non-browser baseline (unit + baseline projects): 169/171 (2 pre-existing skips, 0 failed) — exactly the prior steady-state.

**Why it survived from 2026-05-12 to 2026-06-03 undetected**: `apps/nebula/package.json`'s default `test` script DOES include `--project browser`, but the browser tier carries a different pre-existing issue (see below) which produces multiple failures any time it runs — burying the smoke step 3 failure in the broader pile. Once the cross-contention issue is sorted, the regression-style smoke test catches arity-skew like this within one CI run.

**Why the structured-clone investigation didn't catch it**: the 2026-05-16 diagnostic on `feat/structured-clone-object-based-wire-format` correctly ruled out Phase 1+2 (baseline test app passed; preprocess→postprocess byte-identical on the exact payload shape). The actual cause was four days older and lived in a file the structured-clone commits never touched. Plausible cause #1 (pre-existing breakage) was the right diagnosis.

- [x] Instrument `Star.doTransaction` / `Resources.transaction` — not needed; static analysis was conclusive.
- [x] Definitively classify pre-existing vs regression — pre-existing, since 2026-05-12 (commit 9c6dd7c).
- [x] Fix the actual bug. (Switched to public `client.resources.transaction()` API per user preference for durability against future signature changes.)

### 4b. Pre-existing cross-test contention in the browser tier — ✅ DONE 2026-06-03

**Root cause**: not Star/Galaxy/Universe state (every test already used `uniqueStar()` / `uniqueGalaxy()`). The actual shared resource was the **deployed `email-test.transformation.workers.dev` Worker**. Every `bootstrapAdmin` call did `POST /clear` (wiped storage) then opened a WS to `/ws` (subscribed to "next email"). All tests used the same `testToken` → all hit the same `EmailTestDO` instance → concurrent tests raced for the same email channel.

**Fix**: per-instance email routing via a custom email header, end-to-end:

1. **`@lumenize/auth`** (mechanism — generally useful, not test-only):
   - `ResolvedEmail` gains a `headers: Record<string, string>` field.
   - `AuthEmailSenderBase` gains five overridable hooks (`magicLinkHeaders`, `adminNotificationHeaders`, etc., default `{}`), parallel to the existing subject/HTML hooks.
   - `send()` populates the headers on the assembled `ResolvedEmail`.
   - `CloudflareEmailSender.sendEmail` and `ResendEmailSender.sendEmail` pass `email.headers` through to their providers (Cloudflare's `binding.send({...})` already accepts a `headers?: Record<string, string>` field per `worker-configuration.d.ts:11333`; Resend's API accepts it too).

2. **`@lumenize/nebula-auth`** (the Nebula-specific override):
   - `NebulaEmailSender.magicLinkHeaders(message)` parses `instanceName` from `message.magicLinkUrl` via `/\/auth\/([^/]+)\/magic-link\?/` and returns `{ 'X-Lumenize-Auth-Instance': instanceName }`. Falls back to `{}` if the URL doesn't match.

3. **`tooling/email-test/src/email-test-do.ts`** (the routing consumer):
   - Storage shifts from one `emails` KV array to per-instance buckets `emails:<instance>` (orphans the legacy `emails` key — auto-cleared via `clearEmails()` with no `?instance=` filter; test data is ephemeral so no migration concern).
   - On `receiveEmail`: parse `X-Lumenize-Auth-Instance` from the email's headers, store under the matching bucket, broadcast only to WS subscribers whose attached `instance` matches (empty string attachment = match-all, preserves backward compat).
   - `/ws?instance=<scope>` persists the filter via `serializeAttachment({ instance })` (survives hibernation).
   - `/clear?instance=<scope>` and `/emails?instance=<scope>` scope filtering.
   - Legacy callers without `?instance=` continue to work unchanged (broadcast subscribe, wipe-all clear, see-all read).

4. **`apps/nebula/test/browser/auth-bootstrap.ts`** (the test plumbing):
   - `waitForEmail` takes an optional `instance: string` and appends `?instance=` to both `/clear` and `/ws`.
   - `bootstrapAdmin` passes `scope` as `instance`. All four browser tests already pass unique scopes via `uniqueStar()` / `uniqueGalaxy()` — no test-file changes needed; the routing cascades through automatically.

5. **Deploy**: `wrangler deploy` for the email-test Worker (`https://email-test.transformation.workers.dev`, Version ID `ca646b11`).

6. **Cross-region test correction** (incidental finding during verification): `cross-region.test.ts` was failing even in isolation, not from contention but because EU jurisdiction Star placement only works against deployed workers (wrangler-dev miniflare doesn't honor Cloudflare's `jurisdictionalRestrictions`). Gated with `describe.runIf(process.env.BENCH_BASE_URL)` — matches the existing `MULTI_CLIENT_STRESS` pattern in multi-client.test.ts.

**Verification**:
- `--project browser` concurrent: **3 files passed | 1 skipped | 0 failed** (was 4 files with 5 failures in serial run before fix).
- Full `npm test` scope (unit + baseline + browser): **174 passed | 4 skipped | 0 failed** (was 169 passed | 2 skipped).
- Net +5 passing tests.

**Why no dedicated unit tests for the new plumbing**: `tooling/email-test/` has a pre-existing broken vitest config (v3.2.4 vs the v4.x other packages use — `cloudflareTest` plugin pattern changed between versions). Out of scope to fix. The end-to-end test (concurrent `--project browser` pass) is the meaningful regression check; if any link in the chain (header injection, KV bucketing, WS routing, attachment persistence, bootstrap filter wiring) regresses, that suite goes red. Tests for `auth-email-sender-base.send()`'s header threading already exist in `packages/auth/test/` (the existing 160 tests all still pass and cover the `send()` path; the new `magicLinkHeaders` hook is covered transitively).

---

## The test template — ✅ LIVE in `packages/mesh/` 2026-06-03

The canonical implementation is `packages/mesh/test/browser/`. See `packages/mesh/test/browser/README.md` for the per-package adoption checklist.

**Architecture in one paragraph**: vitest browser project (using `@vitest/browser-playwright`) runs in real chromium. A Vite plugin (`dynamicEnvProxyPlugin` in `vitest.config.js`) proxies `/worker/*` to whatever URL `wrangler dev` ends up on, resolved per-request from an env var that vitest's `globalSetup` populates after spawning wrangler. Tests construct URLs as `globalThis.location.origin + '/worker'` so the test page and the worker share an origin — `SameSite=Strict` cookies (LumenizeAuth's refresh-token) flow naturally without rewriting.

**Per-package adoption** (from the README):
1. Add devDeps: `@vitest/browser`, `@vitest/browser-playwright`, `playwright`, `http-proxy`.
2. Copy `dynamicEnvProxyPlugin` from `packages/mesh/vitest.config.js` (or factor it into a shared file if/when a third package needs it).
3. Add a `browser` project to `vitest.config.js` with the plugin and an instances entry for chromium.
4. Author `test/browser/global-setup.ts` to spawn `wrangler dev` against your test worker, set the proxy target env var, provide `'/worker'` as the relative baseUrl prefix.
5. Author `test/browser/worker/wrangler.jsonc` + `index.ts` mirroring whatever your package's getting-started documents.
6. Write a `*-browser.test.ts` that bundles + instantiates your client, and (ideally) a separate `ws-roundtrip-browser.test.ts` that exercises the documented end-user flow against the deployed worker.

### Deploy bootstrap — chicken-and-egg

JWT secrets must exist on the deployed Worker before `await createRouteDORequestAuthHooks(env)` at module top-level passes Cloudflare's deploy-time module-load validation — but `wrangler secret put` requires the Worker to exist first. Resolution:

1. Deploy once with placeholder JWT keys (use real PEM-format strings — `--var JWT_PUBLIC_KEY_BLUE:"$(cat any-real.pem)" ...`). The Worker entry is created.
2. `wrangler secret bulk secrets.json` to set the real secrets.
3. Re-deploy normally. The placeholder vars are replaced by the secrets.

Documented procedure used during mesh template bringup — keep this here so future test-worker first-time setups don't have to rediscover it.

### Lesson: cross-origin/HTTPS issues → reach for the proxy, not chromium flags

The same-origin proxy approach resolved several classes of issue that initially looked like chromium-cert problems. **General rule**: if a real-browser test needs to talk to a self-signed-TLS server, or cross-origin to something with `SameSite=Strict; Secure` cookies, **dynamic Vite proxy first**. Chromium never sees the upstream cert (proxy is server-side, `secure: false` on http-proxy bypasses Node-side cert checks). Cookies on `http://localhost` are accepted with `Secure` flag (Secure Contexts spec). Specific avoided workarounds: `--ignore-certificate-errors` launch flags, `--allow-insecure-localhost`, manual cookie-attribute rewriting, custom CORS plumbing. See `packages/mesh/vitest.config.js`'s `dynamicEnvProxyPlugin` JSDoc.

---

## Deletion

This file gets archived to `tasks/archive/playwright-test-template.md` once the template is live and at least one consumer package (likely `@lumenize/nebula-frontend`) has adopted it.

---

## Open question (defer)

Whether the `@lumenize/debug` rewrite generalizes to a "Cross-Platform Cloudflare Detection" helper exported from one of the foundation packages, so that any future Lumenize package needing the same pattern doesn't reinvent it. Not blocking; revisit if a second package needs it.
