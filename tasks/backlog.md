# Backlog

Small tasks and ideas for when I have time (evening coding, etc.)

## Immediate work backlog

- [ ] Figure out how to give diagnostic channel power to my Agents and tests. For instance, maybe we could have used that for our email e2e test rather than standing up our own push mechanism. Maybe we should also upgrade debug to use this. See: https://developers.cloudflare.com/workers/runtime-apis/nodejs/diagnostics-channel/


## Lumenize Mesh

- [ ] Investigate use of waitUntil in lmz-api.ts. Do we actually need it? If we do, does it keep the DO in wall-clock billing mode? If we switched to making call always be two one-way calls, would we need it?

- [ ] (is this done already?) Add successful token refresh lifecycle test to mesh test suite — with real cookies
  - **Gap**: Mesh tests cover refresh *failure* (4401 → refresh throws → `onLoginRequired`) but never test successful refresh. All existing mesh tests use `createTestRefreshFunction` (function form) which bypasses cookie handling entirely.
  - **What to test**: `LumenizeClient` with `refresh: '/auth/refresh-token'` (string form, not function) + `browser.fetch` — exercises real cookie jar. Token expires (4401 close) → client calls `browser.fetch('/auth/refresh-token')` → Browser sends `refresh-token` cookie automatically → auth DO validates, returns JWT, rotates cookie → client reconnects → subsequent calls work.
  - **Infrastructure ready**: `packages/auth/test/e2e-email/` now has the email testing infrastructure + `Browser` cookie jar pattern. The auth e2e test proves real cookies work end-to-end. A mesh test can use the same `Browser` instance to: (1) click magic link → cookie captured, (2) pass `browser.fetch` and `browser.WebSocket` to `LumenizeClient`, (3) let LumenizeClient auto-refresh via the real cookie path.
  - **Needs**: Gateway DO binding added to a mesh e2e test wrangler.jsonc, plus auth DO + AUTH_EMAIL_SENDER service binding. The mesh `for-docs/getting-started` test harness is a good starting point — it already has Gateway + auth.
  - **Discovered during**: `tasks/resend-email-for-auth.md` Phase 2b — the backlog item was originally about simulated refresh; with the email infrastructure now in place, it can test the full real flow.

- [ ] Split `getting-started/index.test.ts` so it's a clean 1:1 match with `getting-started.mdx`
  - Currently lines 81-151 add Bob multi-client collaboration, `createTestingClient` storage inspection, and spell check verification — none referenced by the `.mdx`
  - Move the multi-client/Bob scenario to a separate test file (e.g., `test/for-docs/getting-started/multi-client.test.ts` or a different for-docs folder)
  - The remaining test should mirror the `.mdx` Step 4 closely

- [ ] Measure Gateway hop latency overhead (requires live deployment)
  - **Question**: How much latency does the 1:1 Gateway architecture add compared to connecting directly to a DO over WebSocket?
  - **What to measure**: Round-trip time for Client→Gateway→DO→Gateway→Client vs hypothetical Client→DO→Client direct
  - **Patterns to benchmark**: fire-and-forget calls, request/response calls, broadcast fanout
  - **Consider**: Whether always using the two one-way call pattern (to avoid DO wall-clock billing) changes the latency tradeoff
  - **Related**: gateway.mdx documents that intra-datacenter hops are typically <10ms, but cross-region can be several hundred ms
  - **Tooling**: Use `performance.now()` or Cloudflare analytics to measure; compare same-region and cross-region scenarios

- [ ] Improve continuation ergonomics (discovered during manual persistence test implementation)
  - **Reference**: `packages/mesh/test/for-docs/calls/document-do.ts` (`scheduleLocalTask`, `executePendingTask`) and `managing-context.mdx` Manual Persistence section
  - **Issue 1: Nested continuations execute immediately instead of being stored**
    - When passing a continuation as an argument (e.g., `persistTask(id, this.ctn().logMessage(msg))`), OCAN's `resolveNestedOperations` tries to execute it
    - Workaround: Create continuation inside the receiving method, not as an argument
    - Potential fix: Add `$defer` marker or make `getOperationChain()` work for remote types on client side
  - **Issue 2: Handler syntax easy to get wrong silently**
    - `this.ctn().handleResult` (no call) silently does nothing
    - Correct: `this.ctn().handleResult(this.ctn().$result)`
    - Potential fix: TypeScript lint for "continuation property accessed but never called", or proxy detection
  - **Issue 3: Void methods don't trigger local handlers (expected for remote, unclear for local)**
    - Remote: Expected (need response to confirm completion)
    - Local: Might be surprising when handler is never invoked
    - Consider: Document this clearly, or have void methods return `undefined` explicitly

- [ ] Add retry + skip logic for alarm handler failures
  - **Problem**: Currently, handler errors are caught and the alarm is deleted (one-time) or rescheduled (cron) — silent fire-and-forget with no retry
  - **Design**:
    1. Add `retryCount INTEGER DEFAULT 0` and `status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'skipped'))` columns to `__lmz_alarms` (migration needed)
    2. On handler failure, increment `retryCount` and set `time` to `now + 2^retryCount` seconds (exponential backoff)
    3. After 5 failures, set `status = 'skipped'` and log via `@lumenize/debug` (`lmz.alarms.Alarms` namespace)
    4. `triggerAlarms()` and `#scheduleNextAlarm()` filter with `WHERE status = 'pending'`
    5. Skipped alarms stay in the table as evidence — queryable via `getSchedules({ status: 'skipped' })`
  - **Why**: Prevents the 6-retry Cloudflare native alarm deletion (our `alarm()` never throws), gives transient failures a chance to recover, and makes persistent failures visible rather than silent
  - **Bonus**: This also closes the "dormant DO" durability hole — since we handle retries ourselves and `alarm()` never throws, Cloudflare never deletes the native alarm. Overdue alarms always get retried until they succeed or are explicitly skipped.
  - **Location**: `packages/mesh/src/alarms.ts` — modify `triggerAlarms()` error handling, add migration in constructor, update `#scheduleNextAlarm()` WHERE clause

- [ ] Investigate call chain depth and fanout limits
  - **Call chain depth**: We track `maxDepth: 50` in OCAN, but Cloudflare may enforce its own limit on RPC call depth
  - **Questions to answer**:
    1. Which limit is hit first — ours or Cloudflare's?
    2. Do sub-requests of sub-requests count toward Cloudflare's sub-request limit?
    3. What are the actual fanout limits for parallel calls?
  - **Potential workarounds for depth limits**:
    - Pass through an alarm (breaks the RPC chain)
    - Pass through LumenizeClient (WebSocket hop)
    - Establish WebSocket connection instead of Workers RPC
    - Cache/reuse RPC stubs (may only help with RpcTarget scenarios)
    - Return stub over RPC call (unclear if this helps)
  - **Experiment design**: Create test that chains N calls deep, measure where it fails
  - **Fanout experiment**: Create test that fans out to N parallel calls, measure limits
  - **Outcome**: Document findings, adjust `maxDepth` default if needed, document workarounds

- [ ] Experiment: make all `lmz.call()` with response handlers automatically use two one-way pattern
  - **Idea**: Instead of awaiting under the covers (which opens input gates and incurs wall-clock billing), `lmz.call()` with a response handler (4th param) would always fire-and-forget and have the callee call back with the result + handler continuation
  - **Key question**: Does the second hop add meaningful latency, or is it microseconds within a Cloudflare colo?
  - **If latency is negligible**: Developers never have to choose between patterns — every call is eviction-safe by default. The two one-way pattern becomes invisible infrastructure, not a design decision.
  - **If latency is significant**: Keep current behavior as default, maybe offer opt-in flag
  - **Experiment design**: Same operation measured both ways — current call-with-response vs automatic-two-one-way. Measure within same colo and cross-region.
  - **Related**: Gateway latency experiment (above) is higher priority since it adds an extra hop by design

- [ ] Consider adding explicit guidance that while async/await is discouraged, using Promise then/catch is fine. In that case, you are explicitly aknowledging that you know the input gates may open... or do they? We should answer that before deciding what to say.

- [ ] Consider adding these properties (.remote, .retryable, .overloaded, etc.) to lmz.call() errors: https://developers.cloudflare.com/durable-objects/best-practices/error-handling/. Maybe even consider using .idempotent, .safeToRetry or something to indicate that the error was thrown before any state change occured.

- [ ] Start using GitHub Releases

- [ ] Consider further decoupling LumenizeClient token refresh from `@lumenize/auth`
  - Current design: `refresh: string | () => Promise<string>` (docs updated 2025-01-14)
  - String form: POST to endpoint, expects `{ access_token }` response (default: `/auth/refresh-token`)
  - Function form: Custom refresh logic returning token string directly
  - Consider: Should we support additional response shapes for string form (configurable field name)?

- [ ] Consider expanding NADIS to LumenizeClient and/or LumenizeWorker. Right now, I can't think of a compelling reason for it. Alarms, sql, and fetch.proxy are all DO specific. However, debug is not.

- [ ] Build something that use the npm create functionality or Cloudflare's own deploy button or Cloudflare may have it's own create workers project plugin capability.


## Testing & Quality

- [ ] Audit all try/catch block to include cause chains. Make sure structured-clone supports arbitrarially deep cause chain reconstructions including custom errors.

- [ ] Fix type errors in `packages/testing/test/unit/websocket-shim.test.ts` from vitest 4's stricter `vi.fn()` return type
  - **What changed**: In vitest 4, `vi.fn()` returns `Mock<Procedure | Constructable>` (was looser in 3). Test code that casts/passes `vi.fn()` as a `fetch`-signature parameter now fails type-check with `TS2345`.
  - **Scope**: 3+ call sites in `test/unit/websocket-shim.test.ts` (lines 49, 55, 63, ...). Runtime tests still pass; this is type-check-only.
  - **Fix**: Either give the mock an explicit signature — `vi.fn<typeof fetch>()` — or cast the return with a fetch signature at the call site. `vi.fn<typeof fetch>()` is the cleaner pattern.
  - Discovered during the vitest 3→4 migration, 2026-04-20.

- [ ] Audit tests for unawaited expected-rejection cases and remove `dangerouslyIgnoreUnhandledErrors` flag
  - **Why**: During the vitest 3→4 migration we added `dangerouslyIgnoreUnhandledErrors: true` to every `vitest.config.*` because vitest 4 now fails the run (exit 1) on unhandled rejections that vitest 3 silently swallowed. The flag restores vitest 3's behavior but masks real issues (see follow-up notes in that task).
  - **Pattern to find**: Tests that fire-and-forget a promise which is expected to reject. Example:
    ```ts
    someOp();  // kicks off an op that will reject
    expect(somethingElse).toBe(x);  // test completes
    // someOp's rejection arrives AFTER the test → unhandled
    ```
  - **Fix pattern**: Either `await` the promise and use `rejects.toThrow()`, OR attach `.catch()` to silence the expected rejection:
    ```ts
    someOp().catch(() => {});  // expected to reject
    ```
  - **Also common**: teardown code that disconnects a client (e.g., `client[Symbol.dispose]()`) which rejects pending in-flight promises. These need `.catch` on the in-flight promises, or the disconnect should settle them gracefully.
  - **Success criteria**: Remove `dangerouslyIgnoreUnhandledErrors: true` from every vitest config, full suite runs green with exit 0.
  - **Overlap**: Very related to the RPC-await audit above — both surface through "Unhandled Errors" counts. Probably worth doing together.

- [ ] Audit RPC call sites for proper `await` and turn off SonarQube `no-return-await` rule
  - **Why**: Cloudflare DO best practice says always `await` Workers RPC calls — unawaited calls become fire-and-forget, which (a) may rejection-leak (surfaces as vitest 4 "Unhandled Errors"), and (b) can end the request context before the RPC completes. SonarQube's `no-return-await` rule pushes you to remove `await` from `return await rpc()`, which changes try/catch semantics in a DO-hostile way: `return await foo()` catches errors *locally* in the current try/catch; `return foo()` passes them to the caller. The `no-return-await` rule was retracted by ESLint/typescript-eslint in 2023–2024 for this exact reason — SonarQube hasn't caught up.
  - **Audit approach**:
    1. Grep for RPC call patterns: `grep -rn '^\s*\(env\|this\.\w\+\|stub\)\.\w\+(' src/ packages/*/src/`
    2. For each hit, classify: awaited / returned / fire-and-forget
    3. Fire-and-forget cases must be intentional (`ctx.waitUntil` / `lmz.call` with explicit callback per the fire-and-forget-error-delivery pattern in CLAUDE.md) — anything else gets an `await` or `return`
    4. Inside try/catch that wants local error handling, prefer `return await` over `return` (SonarQube will complain — that's the point)
  - **Config change**: Disable SonarQube rule `typescript:S7785` (or whichever `no-return-await` equivalent applies to this project) in the project's SonarQube config
  - **Related**: the "Unhandled Errors" count in vitest 4 output is a proxy metric — if the audit drives it down, we can eventually remove the `dangerouslyIgnoreUnhandledErrors: true` flag from vitest configs. (Discovered during vitest 3→4 migration, 2026-04-20)

- [ ] Add vitest-workers-pool tests for `@lumenize/debug`
  - Current tests run in Node.js only (plain vitest)
  - Need Workers pool tests to verify `cloudflare:workers` env auto-detection works end-to-end
  - Test that `env.DEBUG` set in wrangler.jsonc/miniflare bindings is picked up without any manual configuration

- [ ] Add consistent debug logging across all Lumenize packages
  - Currently only added debug logging where we actively debugged issues
  - Should have comprehensive logging at key points in all packages
  - Use appropriate levels: debug (everything), info (milestones), warn (expected issues)
  - All Lumenize internal namespaces should use `lmz.*` prefix

- [ ] Refactor RequestSync/ResponseSync to not use real Request/Response objects internally
  - **Problem**: Currently uses real Request/Response objects under the covers, inheriting platform-specific quirks
  - Workers returns `undefined` for credentials/mode/referrer, browsers return `'about:client'` for referrer
  - Defeats the purpose of having a synchronous, platform-independent serialization API
  - **Solution**: Store all properties as plain data, only create real Request/Response in `toRequest()`/`toResponse()` methods
  - Would provide consistent behavior across all environments (Workers, Node, Browser)
  - Properties would return exactly what you set, no platform surprises


## Documentation

- [ ] Review, edit, and convert `@skip-check` annotations in `website/docs/mesh/protocol.mdx` (13 pending)
  - File is explicitly labeled as a draft — decide which blocks should be `@skip-check-approved('conceptual')` vs converted to `@check-example`
  - Many are TypeScript interface definitions that could point at real source files

- [ ] Enforce `@skip-check` fails the build (only `@skip-check-approved` should pass)
  - **Current state**: `check-examples` silently skips both `@skip-check` and `@skip-check-approved` blocks
  - **Goal**: `@skip-check` (pending) should fail the build; only `@skip-check-approved` (human-reviewed) should pass
  - **Implementation**: In `tooling/check-examples/src/index.js`, add error collection for non-approved skips in verification mode
  - **Context**: `@skip-check` is meant to be temporary during Phase 1 drafting; we need enforcement to ensure examples are tested before publishing

- [ ] Review `@lumenize/auth` API Reference section for what should be public vs internal
  - JWT Utilities: `signJwt`, `verifyJwt`, `verifyJwtWithRotation`, `importPrivateKey`, `importPublicKey`, `parseJwtUnsafe` — which are truly needed by users?
  - WebSocket Utilities: `extractWebSocketToken`, `verifyWebSocketToken`, `getTokenTtl`, `WS_CLOSE_CODES` — internal implementation details?

- [ ] Add "Why continuations help with race conditions" explanation
  - The key insight: continuations make temporal gaps **explicit** rather than hidden in awaits
  - With async/await, you can accidentally read-await-write and create races
  - With continuations, the "this happens later" part is structurally visible
  - You can still have race conditions, but you're not accidentally creating them
  - Could be a section in continuations.mdx or a standalone concurrency guide

- [ ] Add optimistic concurrency example to calls.mdx or a new concurrency patterns doc
  - Show version/timestamp checking pattern
  - Read state + version, do work, check version hasn't changed before writing
  - Retry or fail strategies
  - More advanced topic — don't clutter basic docs

- [ ] Document Saga pattern for distributed transactions using `callContext.state`
  - **Use case**: Accumulate transaction steps across multiple hops (even across DOs), then commit atomically at the end
  - **Pattern**:
    1. **Accumulate** — Each hop adds its "intent" to `callContext.state.pendingOps` (writes, deletes, validations)
    2. **Validate** — At chain end, check optimistic concurrency (versions match, no conflicts)
    3. **Commit** — Apply all ops atomically within the final DO's synchronous execution
  - **Why `callContext.state` fits**:
    - State propagates through the entire call chain automatically
    - Each request gets isolated state via AsyncLocalStorage (no cross-request leakage)
    - Already established for "compute once, use everywhere"
  - **Tricky part**: Each DO has its own storage — no true distributed transaction across DOs. But you can:
    - Collect all ops in state
    - Have the "coordinator" DO apply its own ops
    - Make calls to other DOs to apply theirs (with version checks)
  - This is essentially the Saga pattern, where `callContext.state` becomes the saga's context
  - **Location**: New section in a concurrency/patterns doc, or expand `callContext.state` section in security.mdx

- [ ] Audit all docs and internal identifiers to favor `callContext` over `metadata` or `meta` where referring to the user-facing API
  - `envelope.metadata` is the transport layer field containing `{ callChain, callee, originAuth }`
  - `this.lmz.callContext` exposes this with convenience getters: `origin`, `caller`, `priorCaller`
  - Ensure docs consistently use "callContext" when describing what users access
  - Check `lmz-api.ts`, `CallEnvelope` interface, and any JSDoc comments

- [ ] Add this to the docs: https://discord.com/channels/595317990191398933/773219443911819284/1439941400778117292

- [ ] Migrate older packages from doc-testing/TypeDoc to hand-written docs with check-examples
  - Packages still using doc-testing generated files: rpc (quick-start, capn-web comparisons, operation-chaining), testing (agents, usage), mesh (services)
  - Packages still using TypeDoc: rpc, utils, testing, fetch, structured-clone (configured in `docusaurus.config.ts`)
  - For each: write hand-written `.mdx` with `@check-example` annotations, add API reference page (see `auth/api-reference.mdx` for the pattern), remove TypeDoc config and doc-testing sidebar entries
  - Can be done incrementally, one package at a time

- [ ] Add llms.txt support https://github.com/din0s/docusaurus-plugin-llms-txt

## Future bigger things

- [ ] Publish our test-endpoints as part of @lumenize/testing. It's particularly useful now that it can be run in-process. Does it still need a token when used that way? Should we rename it httpbin to match? What's different about it compared to httpbin?

- [ ] Research adding `ctnBatch()` API to `this.lmz.call` for atomic multi-operation execution
  - Syntax: `this.ctnBatch([this.ctn().methodA(), this.ctn().methodB()])`
  - Would execute multiple operations atomically on remote DO without yielding between them
  - Use case: Multiple related operations that should execute together (e.g., transfer funds = debit + credit)
  - Implementation: Use microtask batching pattern to ensure no interleaving
  - Could batch the continuations into single RPC call, then use microtask pattern on receiver side
  - Reference: [Discord - microtask transaction pattern](https://discord.com/channels/595317990191398933/773219443911819284/1440314373473046529)

- [ ] Add an alternative to ctn (maybe ctnTransaction) to use a transaction for execution


## Infrastructure

- [ ] See `tasks/github-actions-publishing.md` for automation plans

## Website, Blog, etc.

- [ ] Cross post on Medium like this
        > If you are not a premium Medium member, read the full tutorial FREE here and consider joining medium to read more such guides.

- [ ] Get a Substack account and cross post there

## @lumenize/auth

- [ ] Make `@lumenize/auth` an MCP-compliant OAuth 2.1 Authorization Server (agentic access)
  - **Why**: MCP spec (2025-06) pins remote MCP server auth to OAuth 2.1. Claude Desktop, Cursor, ChatGPT connectors all speak this. Without it, a Lumenize-backed MCP server can't auto-connect to standard MCP clients — users have to manually bolt on custom glue. This is the #1 agentic gap, not social login.
  - **Leverages existing work**: Ed25519-signed JWTs, refresh rotation, and the RFC 8693 `act` claim (Delegation) are already in place. The `act` claim is exactly the semantic primitive Token Exchange needs — missing piece is the standards-compliant façade around it.
  - **Endpoints/discovery to add**:
    - `/.well-known/oauth-authorization-server` (RFC 8414) — AS metadata
    - `/.well-known/oauth-protected-resource` (RFC 9728) — PRM discovery so clients can find the AS from the resource server
    - `/authorize` with consent screen (OAuth 2.1 + PKCE mandatory)
    - `/token` supporting authorization_code grant, refresh_token grant, and `urn:ietf:params:oauth:grant-type:token-exchange` (RFC 8693) — token exchange wraps the existing `delegated-token` flow
    - `/register` — Dynamic Client Registration (RFC 7591) so MCP clients can self-register without pre-provisioned credentials
    - Resource Indicators (RFC 8707) honored in `/authorize` and `/token` so tokens are scoped to the specific MCP server
  - **Open design questions**: consent screen UX (reuse admin approval email pattern?), client storage (new DO, or extend auth DO?), scope model (start coarse: `mcp:read`, `mcp:write`?), token format (keep current JWT shape or add audience-bound variant?)
  - **References**: [MCP auth spec](https://modelcontextprotocol.io/specification/basic/authorization), [RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693), [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591), [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728), [RFC 8707](https://datatracker.ietf.org/doc/html/rfc8707)
  - **Scope**: Big enough to promote to its own task file (`tasks/auth-oauth-provider.md`) when scheduled

- [ ] Add OpenID Connect provider endpoints so other apps can "Sign in with Lumenize"
  - **Why**: Federated identity provider capability — lets a Lumenize deployment serve as the IdP for third-party apps, SSO out to other tools, etc. Medium severity — matters if customers want to wire their Lumenize account into other SaaS, less critical than the MCP flow.
  - **What OIDC adds on top of OAuth 2.1**:
    - `/.well-known/openid-configuration` — OIDC discovery document (superset of `oauth-authorization-server`)
    - `openid` scope triggers issuance of an ID token alongside the access token
    - ID token is a JWT with identity claims (`sub`, `email`, `email_verified`, `name`, etc.) signed by the same Ed25519 key chain
    - `/userinfo` endpoint (optional but expected) for clients to fetch additional claims
    - JWKS endpoint (`/.well-known/jwks.json`) publishing the public signing keys — we already have key rotation, just need to expose it
  - **Dependency**: Much of this rides on the OAuth 2.1 AS work above (discovery, `/authorize`, `/token`, consent). Natural follow-on, not independent.
  - **References**: [OIDC Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html), [OIDC Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html)

## Nebula Auth

- [ ] Integrate Cloudflare Account Abuse Protection for disposable email and email risk detection
  - **Ref**: https://blog.cloudflare.com/account-abuse-protection/
  - **What**: Cloudflare's fraud detection computes `cf.fraud_detection.disposable_domain` (boolean) and `cf.fraud.email_risk` (low/medium/high/unknown) on eligible requests. These can be injected as request headers via Managed Transform Rules, then read in the Worker — no client-side widget needed, no siteverify API call. Simpler than Turnstile integration.
  - **Where in nebula-auth**: `src/router.ts`, alongside the existing Turnstile check on public unauthenticated endpoints (`claim-universe`, `claim-star`, `email-magic-link`). Read injected headers, reject disposable emails, escalate high-risk emails to require admin approval.
  - **Graceful degradation**: If the headers aren't present (vibe-coder hasn't configured Transform Rules), skip the check — same pattern as Turnstile being optional when `TURNSTILE_SECRET_KEY` isn't set.
  - **Caveat**: Currently Early Access for Bot Management Enterprise customers only. As of March 2026, this appears to require paid WAF/Bot Management — there is no free-tier or standalone API equivalent. If Cloudflare opens this up more broadly (GA expected later in 2026), it becomes a natural addition. Until then, a lightweight disposable-domain blocklist (MIT-licensed lists exist) could serve as a free stopgap.

## Blocked / Maybe later

- [ ] Consider always using a transactionSync for every continuation execution. Maybe make it a flag?

- [ ] Do some analysis on this and our current code: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#always-await-rpc-calls

- [ ] Refactor to use `using` keyword for Workers RPC stubs (Explicit Resource Management)
  - Cloudflare added support in Feb 2025: https://developers.cloudflare.com/changelog/2025-02-28-wrangler-v4-rc/#the-using-keyword-from-explicit-resource-management
  - **Why it matters**: Without `using`, stubs held in wall-clock billing mode
  - **Pattern**: `using` is lexically scoped (NOT reference-counted like WeakMap). Disposal happens when the declaring scope exits, regardless of who holds references. Therefore, `using` must be at the **call site**, not inside helper functions that return stubs.
  - **Blocker**: As of Jan 2025, `vitest-pool-workers` (workerd 1.20251011.0) throws "Object not disposable" when using `using` with DO stubs. The runtime doesn't implement `Symbol.dispose` on stubs yet. Wait for vitest-pool-workers/workerd to add support, then:
    1. Search codebase for `getDOStub(` calls and change to `using stub = getDOStub(...)`
    2. Update `getDOStub` JSDoc to recommend callers use `using`
    3. Update unit test mocks to include `[Symbol.dispose]: () => {}`