---
paths:
  - "**/*.test.ts"
  - "**/test/**/*.ts"
  - "**/vitest.config.*"
---

# Testing

## Philosophy
- **Integration testing is primary** for Worker/DO code — dogfood our own testing packages and exercise the real Cloudflare runtime via miniflare/vitest.
- **Unit testing only** for algorithmically tricky pure functions and UI components (and occasionally during development to confirm behavior before building a dependent part).
- **Coverage**: Branch >80%, Statement >90%. Defensive exception conditions that are hard to reach in tests may stay uncovered.
- Tests enable refactoring, not prevent it. Remove functionality and its tests rather than ossifying tests for deprecated behavior. Never create aliases or backward-compatible signatures just to avoid updating a test — fix it properly. Leave working integration tests alone when adding doc-validation tests; create separate minimal `test/for-docs/` projects instead.
- **Deferring ≠ deleting.** When a test exposes a real issue whose fix is deferred, use `it.skip` with the original assertions intact + a one-line comment naming the blocker + a task-file/TODO entry — never delete the test or weaken its assertions to ship green (false confidence). Removal is only for tests of deprecated behavior (previous bullet); `it.skip` shows up as `↓ skipped` in every run, keeping the deferral visible.

## Tests must be capable of failing
A test that passes regardless of the implementation's correctness is worse than no test. Before considering a test done, ask: **"If I gutted the code under test, would this assertion fail?"** If not, it checks the wrong thing. Common ways tests pass for the wrong reason:
- **Harness fidelity loss**: a path that JSON-stringifies (or otherwise serializes) silently degrades rich types — `Date`→string, `Map`/`Set`→`{}`/`[]`, `BigInt` throws/vanishes, cycles flatten. The validator accepts the degraded value and the test passes, but you validated the round-trip degradation, not the code.
- **Mocks returning expected values**: a stub that always returns what the test expects passes regardless of real behavior.
- **Placeholder assertions**: `expect(true).toBe(true)`, `expect(arr.length).toBeGreaterThan(-1)`.
- **Happy-path-only coverage**: failure modes invisible because nothing exercises them.
- **Cross-test state pollution**: the **"isolation flips the result"** signature — passes alone but fails in the full file, or vice versa. **Check instance names first**: two tests sharing a DO instance name share that DO. `isolatedStorage` only rolls back *storage writes* — the in-memory DO instance survives across `it` blocks regardless (and suites with `isolatedStorage: false`, e.g. auth's WS tests, share storage too). Fix = a unique name per test (`uniqueStar()` / `crypto.randomUUID()` — the established convention). Only when unique names don't cure it, suspect shared infra caches keyed by something *other than* instance name: Worker Loader `bundleId` ([durable-objects.md](durable-objects.md) § Dynamic Worker Loader cache), module loader, prompt cache.

When introducing a new test pattern (harness, fixture, mock layer), write a probe that *should fail* (feed a value the path can't preserve) and verify it fails, then fix the path to make it pass. If you can't write a failing probe, the test layer isn't testing anything.

**Mutation-check added tests, not just new harnesses.** A test added to an already-green or ported suite can be vacuous — a redundant guard or unrelated path already forces its assertion, and the green neighbors hide it. Comment out the exact code path the new test targets, confirm *that* test goes red, then restore. **For a compound condition (`a || b`, `a && b`, a multi-status check like `status === 401 || status === 403`), mutate each operand independently — toggling the whole branch off only proves *one* operand is covered and leaves the others untested.** Mirror the source's case-fan-out in the tests (if the code treats two codes as terminal, probe both, e.g. `it.each([401, 403])`). Ported tests inherit prior mutation-validation; tests added during a port do not. (Mutation proves a test is capable of failing — it does NOT prove a mock is faithful to real behavior; for that, back the unit suite with a real integration/e2e test.)

## vitest reports handled rejections as "errors"
A green run can still print `Errors N` — vitest-pool-workers counts workerd-level rejection events even when the test caught them (`.rejects.toThrow`, `.catch()`). Common with intentionally-erroring fire-and-forget mesh calls. It's reporting noise with **no JS-level fix** — don't try to shrink the count (e.g. `log.error`→`log.warn` doesn't change it, only hides real errors). What matters: **`failed` is 0** and none of the N messages are *new* ones from the code under test (grep the output for your error strings). A steady baseline (hundreds) is fine; a jump between commits (124→500) is worth investigating.

## Asserting on `@lumenize/debug` log output
Use `setDebugSink((entry) => entries.push(entry))` in `beforeEach` + `clearDebugSink()` in `afterEach`; filter captured entries by `entry.namespace` / `level` / `message`. `vi.spyOn(console, 'warn')` catches nothing — `@lumenize/debug` routes **every** level through `console.debug` and gates on the `DEBUG` env var; an installed sink replaces default output and bypasses that filter ("sink installed implies capture everything"). Canonical: `apps/nebula/test/test-apps/baseline/nebula-client-bindtostate.test.ts`. The API is exported from `@lumenize/debug` but intentionally undocumented in website docs (internal testing primitive) — use it in our tests; don't recommend it to end users in docs or PRs.

## Mesh testing pyramid
- **Integration** (`LumenizeClient` + `createTestRefreshFunction`) — full production path Client → Worker fetch → auth hooks → Gateway → DO. The `refresh` callback mints JWTs locally; auth hooks verify them normally. No test-mode infrastructure.
- **Isolated DO** (`createTestingClient`) — direct DO RPC, bypasses Worker/Gateway/auth. Good for storage, alarms, business logic, and manipulating DO state (e.g. force-close a WebSocket via `ctx.getWebSockets()[0].close(code)` to test reconnection).

See [website/docs/mesh/testing.mdx](../../website/docs/mesh/testing.mdx).

## Baseline test-app: `callXxx` initiators bypass client-side state
Test subclasses (e.g. `NebulaClientTest`) add `callXxx(...)` initiators that issue direct `this.lmz.call(...)`s. These **bypass the public API** — they don't populate client-side state (`#subscriptionRegistry`, `#pendingSubscribes`, `#perTypeResolvers`). They test the **server-side** path (Star, Galaxy) where the client is just a call source.

When the unit under test is **client-side state** (auto-resubscribe walks, pending-Promise correlation, resolver precedence, optimistic rollback), use the public API (`client.resources.subscribe/read/transaction(...)`) so that state is actually populated. Mixing the two yields "the subscribe ran on Star but the client doesn't know" failures that look like production bugs but are test-code bugs.

Also: initiator methods call `resetResults()`, which **zeroes** capture fields (`resourceUpdateCount`, `lastResourceUpdate`, `lastResult`, …). When asserting "did the count go up?", capture the baseline immediately before the action under test, not before setup helpers that call initiators.

## `vi.waitFor`, never `setTimeout`
Wait for async state changes with `vi.waitFor` (retries until the assertion passes). Never use `setTimeout` / arbitrary delays.
```typescript
await vi.waitFor(async () => {
  const status = await client.taskStatus;
  expect(status).toBe('complete');
});
```
Its default timeout is **1000 ms**, which can be fragile under parallel-test contention (another "isolation flips the result" source). For test-app suites with auth/WebSocket setup, install a project-wide default via `setupFiles`:
```typescript
// test/setup.ts
const orig = vi.waitFor;
vi.waitFor = ((fn, opts) => orig(fn, { timeout: 5000, interval: 50, ...(opts ?? {}) })) as typeof vi.waitFor;
```
```javascript
// vitest.config.js
test: { setupFiles: ['./test/setup.ts'] }
```
Per-test `{ timeout }` overrides still win. Canonical: `apps/nebula/test/test-apps/baseline/test/setup.ts`.

## Test organization
Two patterns for Cloudflare Worker packages:
- **Pattern A (simple)** — single environment: `wrangler.jsonc` in package root, one `defineWorkersProject()` config. Use for new packages by default.
- **Pattern B (multi-environment)** — `test/{environment}/wrangler.jsonc` per environment; a multi-project `defineConfig` separates Node unit tests from Workers integration tests (and deployment variants). Use only when you must separate runtimes or test multiple variants.

A single `vitest.config.js` can define multiple projects: one per `for-docs/` mini-app (each with its own `wrangler.jsonc`/migrations), the same suite across Node/Workers/browser, or e2e tests with different bindings. Set `isolatedStorage: false` for WebSocket support.

## `for-docs/` tests are mini-apps
Each `test/for-docs/` directory is a **self-contained mini application**. They serve two purposes: (1) bug-finding through realistic integration — historically `for-docs/` tests have found more bugs than all other tests combined; (2) doc accuracy — each is linked from a website doc (`.md`, or legacy `.mdx`) via `@check-example`. Each has its own `wrangler.jsonc`, Worker entry, DO classes, and a phased narrative test exercising realistic multi-node scenarios. Exemplar: `packages/mesh/test/for-docs/getting-started/`.

**Narrative for-docs tests → one big `it`.** When Step 2 depends on Step 1's state (Getting Started, walkthroughs), use a single `it` with sequential awaits that mirrors the doc flow — not one `it` per step (cross-`it` shared-state ordering is a flakiness vector). **Exception**: API-reference-style for-docs tests, where each `it` covers an independent code block (`parse(unknownType)`, `parse(typeMismatch)`), stay split. The rule is "follow the doc's structure" — narrative → one `it`; reference → one per example.

Use isolated `test/` tests instead for single-node logic, edge/error paths, internal implementation details, and performance/stress tests.

## App test pattern
For apps in `apps/`, use `test/test-apps/{name}/` with `instrumentDOProject`. See `apps/nebula/test/test-apps/README.md`.

## E2E with external services
vitest-pool-workers tests can make real external `fetch()` calls and `new WebSocket()` connections to deployed Workers — code under test runs in-process (no deploy) but interacts with real infrastructure. Canonical setups:
- `packages/auth/test/e2e-email/` — full magic-link loop with real email: the auth DO sends via **Cloudflare Email Sending**; a deployed `email-test` Worker receives it via Email Routing and pushes back over WebSocket. (`e2e-email-resend/` is the same loop via Resend.)
- `packages/fetch/test/` — proxy-fetch tests hit a deployed `@lumenize/test-endpoints` Worker (httpbin-like endpoints + an instrumented DO; source in `tooling/test-endpoints`; URL + token come from the root `.dev.vars` `TEST_ENDPOINTS_URL`/`TEST_TOKEN`).

**Prefer the real loop over test-mode bypasses.** The trained instinct "external service = slow and flaky, mock it or flip a test-mode flag" is miscalibrated here: the email loop stays entirely on Cloudflare infrastructure and completes in 1–3 s. Test-mode bypasses are for suites where the real loop is genuinely unavailable, not a default for saving test time.

**First-run-after-idle failures are cold starts, not bugs.** An external service that sat idle (e.g. Resend) adds latency on the first run after a gap; the same test passes on re-run. Fix = generous `vi.waitFor`/test timeouts on these suites (e2e-email-resend runs 60 s `testTimeout` / 45 s `waitForEmail`) — not mocking, skipping, or hunting a phantom race.

## Real-browser tests: same-origin proxy first
When a chromium test (`@vitest/browser-playwright`) must reach a self-signed-TLS server (`wrangler dev --local-protocol https`) or cross-origin to a `SameSite=Strict`-cookie endpoint, use a **same-origin Vite proxy plugin** — not chromium launch flags, server-side cookie-attribute rewrites, or CORS plumbing. The proxy terminates TLS server-side (`secure: false` skips Node cert checks; the browser never sees the upstream cert) and puts the test page and the worker on one origin, so `Secure; SameSite=Strict` cookies flow untouched. Canonical implementation: `dynamicEnvProxyPlugin` in `packages/mesh/vitest.config.js`; adoption checklist: `packages/mesh/test/browser/README.md`.
