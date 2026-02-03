# Backlog

Small tasks and ideas for when I have time (evening coding, etc.)

## Immediate work backlog

## Lumenize Mesh

- [ ] Confirm that alarms, fetch, and sql NADIS modules have what they need in the hand-written docs and confirm the rest of mesh has what it needs. (Related: [migrate older packages from doc-testing/TypeDoc](#documentation) backlog item covers the broader migration.)

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

- [ ] Code review and simplification pass for all mesh code (following alarms.ts pattern)
  - **Context**: Successfully simplified `alarms.ts` from ~570 to 363 lines (36% reduction)
  - **Patterns to look for**:
    1. Redundant fields (e.g., storing both `#ctx` and `#storage` when one suffices)
    2. Dead code parameters (e.g., `extra.time` that was never used)
    3. Defensive checks that can't trigger (e.g., `!result` when sql always returns array)
    4. Methods that are pure indirection (e.g., `triggerAlarmsForTesting` → `triggerAlarms`)
    5. Unnecessary async/await on synchronous operations
    6. Redundant initialization flags/methods
    7. Overly verbose JSDoc (shorten and link to docs)
  - **Files to review**: `lumenize-do.ts`, `lumenize-worker.ts`, `lumenize-client.ts`, `lumenize-client-gateway.ts`, `lumenize-auth.ts`, `ocan/*.ts`

- [ ] Replace LumenizeAuth's in-memory rate limiter with Cloudflare's native rate limiter binding
  - Docs: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
  - **Why**: Current implementation uses instance variables (violates CLAUDE.md guidance), resets on DO eviction, doesn't coordinate across instances
  - **Where to add rate limiting**:
    1. Auth HTTP routes (magic link, refresh) — key by email pre-auth, userId post-auth
    2. WebSocket upgrade in auth middleware — key by userId from JWT
    3. WebSocket messages in LumenizeClientGateway — key by userId (from attachment, no JWT re-verify needed)
    4. `onBeforeConnect`/`onBeforeRequest` middleware hooks — key by userId from callContext
  - **DDoS surface**: Bad actors can create unlimited Gateway instances (`{userId}.anything`) with one valid token, then spam messages across all of them. Rate limiting must be per-userId, not per-connection.
  - **Key selection tradeoff**: JWT verification before rate limiting exposes crypto ops to DDoS; consider two-tier approach (coarse IP-based limit first, then userId-based after JWT verify). Revisit when implementing.
  - **Limitation**: Cloudflare rate limiter only supports 10s or 60s periods (no hourly like current impl)

- [x] Add admin token revocation endpoint to LumenizeAuth (DONE in Phase 3)
  - Implemented via `#revokeAllTokensForSubject` — called when `adminApproved` set to false or subject deleted
  - Admin CRUD endpoints (`PATCH /auth/subject/:id`, `DELETE /auth/subject/:id`) handle the use cases

- [ ] Evolve LumenizeAuth schema for multi-email users (Nebula prep)
  - Current: 1:1 user↔email (`users.email` column)
  - Future: 1:many via separate `user_emails` table
  - Support verified/unverified emails, primary email designation
  - Domain extraction for enterprise domain restrictions (e.g., `@acme.com` only)
  - Discovery flow: existing user adds new email, links to same account

- [x] Create `website/docs/mesh/testing.mdx` — Adapt `@lumenize/testing` Agents patterns for LumenizeClient (DONE 2025-01-23)

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

- [ ] Implement generic pub/sub between mesh nodes. Use `using` keyword on both client instantiation `using client = new ClientExtendingLumenizeClient` and what's returned from the subscription `using sub = client.subscribe(...)` calls

- [ ] Refactor getting-started guide to use native pub/sub once implemented
  - Current implementation manually manages subscribers Set in storage
  - Replace with built-in subscription primitives
  - Will simplify DocumentDO significantly (no more #broadcastContent, subscriber management)

- [ ] Consider adding explicit guidance that while async/await is discouraged, using Promise then/catch is fine. In that case, you are explicitly aknowledging that you know the input gates may open... or do they? We should answer that before deciding what to say.

- [ ] Consider further decoupling LumenizeClient token refresh from `@lumenize/auth`
  - Current design: `refresh: string | () => Promise<string>` (docs updated 2025-01-14)
  - String form: POST to endpoint, expects `{ access_token }` response (default: `/auth/refresh-token`)
  - Function form: Custom refresh logic returning token string directly
  - Consider: Should we support additional response shapes for string form (configurable field name)?

- [ ] Add method annotations to distinguish three types of methods in classes extending LumenizeClient, LumenizeBase, or LumenizeWorker, where appropriate:
  - `@inbound`, `@downstream`, or `@callable` — Methods meant to be called by mesh nodes pushing to the client (server → client)
  - `@result` — Methods that handle responses from calls this client initiated
  - `@local` — Methods used only locally in the browser, never exposed to the mesh
  - **Default behavior**: No annotation = unrestricted (can be used for all three)
  - **When using one**: Disallows all other uses
  - **Combination rules**: Can combine `@inbound` and `@result` (same logic for both). Combining `@local` with others is contradictory → ?lint error.
  - **Implementation**:
    1. Runtime validation in the framework
    2. JSDoc annotations for documentation/intent (maybe?)
    3. Custom lint rules for compile-time checks (maybe?)

- [ ] Consider expanding NADIS to LumenizeClient and/or LumenizeWorker. Right now, I can't think of a compelling reason for it. Alarms, sql, and fetch.proxy are all DO specific. However, debug is not.

- [ ] Consider LumenizeSubClient pattern for multiplexing multiple "resources" over a single LumenizeClient connection
  - **Problem**: Each LumenizeClient has its own WebSocket, Gateway, token refresh — inefficient when editing multiple documents
  - **Current approach**: User code maintains a registry and routes incoming calls by id (see getting-started guide)
  - **Future consideration**: If pattern proves common, consider building routing/registry into LumenizeClient base class

- [ ] Build something that use the npm create functionality or Cloudflare's own deploy button or Cloudflare may have it's own create workers project plugin capability.

## LumenizeDO NADIS modules

- [ ] mcp
- [ ] per-resource pub/sub
- [ ] Fanout broadcast service
      The first "tier" should actually be instantiating the class in the originator of the fan-out. The subsequent tiers would be armies of stand-alone LumenizeWorkers. You'd pass the list of receipients and the message into the local instance, and it would figure out how to tier it. We'd have to do experiments and update the learning periodically as Cloudflare evolved things to determine the optimal number of nodes to fan out to in each tier. 

      Maybe an algorithm like this. If it were between 64 and 4,096 (64^2) nodes, then take the square root, so 8 to 64 fanout in each tier. Any list shorter than 64 gets done in one shot. Between 4,096 and 262,144 (64^3), it would be three tiers of 8 to 64 each taking the cube root of the count. I doubt we want to even allow up to 262,144 so I don't think we'll ever need a fourth tier, but maybe 10,000 is possible?


## Testing & Quality

- [ ] Add consistent debug logging across all Lumenize packages
  - Currently only added debug logging where we actively debugged issues
  - Should have comprehensive logging at key points in all packages
  - Use appropriate levels: debug (everything), info (milestones), warn (expected issues)
  - All Lumenize internal namespaces should use `lmz.*` prefix

- [ ] Add missing alias tests for @lumenize/structured-clone
  - Test multiple paths to same object (true aliases - obj.a and obj.b both point to same object)
  - Test deep cycles (A→B→C→A)
  - Test cycles in Map keys (keys can be objects)
  - Test shared subtree aliases (two different paths leading to same subtree)
  - Performance tests with large cyclic structures

- [ ] Refactor RequestSync/ResponseSync to not use real Request/Response objects internally
  - **Problem**: Currently uses real Request/Response objects under the covers, inheriting platform-specific quirks
  - Workers returns `undefined` for credentials/mode/referrer, browsers return `'about:client'` for referrer
  - Defeats the purpose of having a synchronous, platform-independent serialization API
  - **Solution**: Store all properties as plain data, only create real Request/Response in `toRequest()`/`toResponse()` methods
  - Would provide consistent behavior across all environments (Workers, Node, Browser)
  - Properties would return exactly what you set, no platform surprises


## Documentation

- [ ] Review `@lumenize/auth` API Reference section for what should be public vs internal
  - RPC Methods: `configure()` and `setEmailService()` — only used in tests, not production
  - JWT Utilities: `signJwt`, `verifyJwt`, `verifyJwtWithRotation`, `importPrivateKey`, `importPublicKey`, `parseJwtUnsafe` — which are truly needed by users?
  - WebSocket Utilities: `extractWebSocketToken`, `verifyWebSocketToken`, `getTokenTtl`, `WS_CLOSE_CODES` — internal implementation details?
  - Email Services: `ConsoleEmailService`, `HttpEmailService`, `MockEmailService`, `createDefaultEmailService` — verify all 4 are implemented and tested; likely some are stubs
  - Email service implementation is incomplete — expect this to change before finalizing docs

- [ ] Consider removing "Token Delivery via Subprotocol" implementation detail from security.mdx after LumenizeClient implementation is complete

- [ ] Update all references from `LumenizeBase` to `LumenizeDO` across docs (alarms/index.mdx, etc.)

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

- [ ] Audit all docs and internal identifiers to favor `callContext` over `metadata` or `meta` where referring to the user-facing API
  - `envelope.metadata` is the transport layer field containing `{ callChain, callee, originAuth }`
  - `this.lmz.callContext` exposes this with convenience getters: `origin`, `caller`, `priorCaller`
  - Ensure docs consistently use "callContext" when describing what users access
  - Check `lmz-api.ts`, `CallEnvelope` interface, and any JSDoc comments

- [ ] MUST document headers that routeDORequest adds: https://github.com/lumenize/lumenize/blob/7d56ccf2a9b5128cb39a98610c1acee50ee34540/packages/utils/src/route-do-request.ts#L290-L294

- [ ] Add this to the docs: https://discord.com/channels/595317990191398933/773219443911819284/1439941400778117292

- [ ] Update the vs Cap'n Web docs to talk about RpcTarget

- [ ] Add examples/docs for plucking bindingName and instanceNameOrId from headers into storage

- [ ] Move promise pipelining from quirks to its own doc section and use our new name for it Operation Chaining and Nesting (OCAN)

- [ ] Add comprehensive security documentation (currently just a warning)

- [ ] Migrate older packages from doc-testing/TypeDoc to hand-written docs with check-examples
  - Packages still using doc-testing generated files: rpc (quick-start, capn-web comparisons, operation-chaining), testing (agents, usage), mesh (services)
  - Packages still using TypeDoc: rpc, utils, testing, fetch, structured-clone (configured in `docusaurus.config.ts`)
  - For each: write hand-written `.mdx` with `@check-example` annotations, add API reference page (see `auth/api-reference.mdx` for the pattern), remove TypeDoc config and doc-testing sidebar entries
  - Can be done incrementally, one package at a time

- [ ] Add llms.txt support https://github.com/din0s/docusaurus-plugin-llms-txt

- [ ] Add MCP server for docs
  
- [ ] Consider adding this to BSL and maybe other licenses:
        The Software, or any part of it, including its source code, may not be used
        to create, train, or improve any artificial intelligence or machine learning
        models or systems, or to generate any datasets, without the express written
        permission of the copyright holder(s).

## Future bigger things

- [ ] Lumenize Auth now supports delegation from one human subject to another human subject. Upgrade to support non-human subjects (agents in particular)
- [ ] Consider adding an additional flag to Lumenize Auth for admins to opt out of getting an email when a self-signup occurs. Maybe even have a flag that supresses all admin emails. Assumes the system implements a dashboard or some other mechanism for approving.

- [ ] Debounce admin notification emails on repeated self-signup logins
  - **Problem**: If a user requests a new magic link N times and clicks each, admins get N notification emails with the same approve link
  - **Options**: Track "notification sent" flag per subject (column or KV), or deduplicate by approve URL within a time window
  - **Priority**: Low — admins just get duplicate emails with the same approve link, no security issue

- [ ] Consider adding DPoP (RFC 9449) as opt-in sender-constrained token binding
  - **What**: DPoP binds tokens to a client-generated key pair so stolen tokens are unusable without the private key
  - **Why**: Complements refresh token rotation — rotation detects reuse, DPoP makes exfiltrated tokens inert. Strongest against token leaks from logs, network, or limited XSS
  - **Scope**: Browser generates ECDSA P-256 key pair (non-extractable), sends signed DPoP proof JWT with each request. Server stamps key thumbprint into access token `cnf.jkt` claim, validates proof on each request
  - **Ecosystem**: RFC 9449 finalized, Okta GA, Auth0 Early Access, Keycloak 26.4 GA. `panva/dpop` and `panva/jose` libraries work in both browser and Cloudflare Workers
  - **Limitation**: Does not protect against full XSS (attacker can use the non-extractable key to sign proofs in-page). True hardware-bound keys await Device Bound Session Credentials (DBSC, W3C proposal)
  - **Implementation**: ~100 lines client-side (or use `dpop` package), server-side proof validation + jti replay tracking in DO SQL storage

- [ ] Add configurable redirect behavior for auth error scenarios
  - **Current state**: `LUMENIZE_AUTH_REDIRECT` is the only redirect target, used for both success (post-login) and errors (approve endpoint unauthenticated). The approve endpoint redirects to `{redirect}?error=login_required` but the frontend has no convention for handling this.
  - **Consider**: Separate config options like `LUMENIZE_AUTH_ERROR_REDIRECT` or `LUMENIZE_AUTH_LOGIN_URL`, with a convention for query params (`?error=<code>&return_to=<url>`). Would let the approve endpoint redirect to the login page with a return URL, so after re-auth the admin lands back on the approve link.
  - **Related**: Other browser-facing error scenarios (expired magic link redirects to `{redirect}?error=token_expired`) would also benefit from a dedicated error redirect.

- [ ] Consider switching MCP subscriptions to keying off of the original request id rather than rely upon session id

- [ ] Consider adding same-site origin and path checks to our cookie parameter handling in Browser.

- [ ] Publish our test-endpoints as part of @lumenize/testing. It's particularly useful now that it can be run in-process. Does it still need a token when used that way? Should we rename it httpbin to match? What's different about it compared to httpbin?

- [ ] Investigate refactoring `@lumenize/rpc` to use new `this.lmz.call()` infrastructure
  - Currently uses manual `processIncomingOperations()` function (lines 277-318 in `lumenize-rpc-do.ts`)
  - Originally had `createIncomingOperationsTransform()` for postprocess hooks, but it was never called (dead code)
  - RPC was great learning and we developed OCAN for it, but it's somewhat a dead-end product now
  - Might be worth simplifying to use the standard `this.lmz.call()` pattern
  - Or might be worth keeping as-is since it works and has its own specialized needs

- [ ] Research microtask batching for atomic execution in Lumenize RPC batches
  - Lumenize RPC has batch execution but currently awaits every operation (allows interleaving)
  - Wrapping batch execution with `queueMicrotask` pattern could ensure atomicity (all operations execute without yielding)
  - Pattern: Queue all batch operations, then execute them together in one microtask before yielding to event loop
  - Would guarantee no other requests interleave during batch execution on remote DO
  - Reference implementation: [Discord - microtask transaction pattern](https://discord.com/channels/595317990191398933/773219443911819284/1440314373473046529)
  - Note: This is about remote execution atomicity, not serializable continuations (microtasks can't be stored)

- [ ] Research adding `ctnBatch()` API to `this.lmz.call` for atomic multi-operation execution
  - Syntax: `this.ctnBatch([this.ctn().methodA(), this.ctn().methodB()])`
  - Would execute multiple operations atomically on remote DO without yielding between them
  - Use case: Multiple related operations that should execute together (e.g., transfer funds = debit + credit)
  - Implementation: Use microtask batching pattern to ensure no interleaving
  - Could batch the continuations into single RPC call, then use microtask pattern on receiver side
  - Reference: [Discord - microtask transaction pattern](https://discord.com/channels/595317990191398933/773219443911819284/1440314373473046529)

- [ ] RPC. Maybe we need a way to secure the DO access over RPC so it can't change storage, or maybe we just need examples that show it not being accessible. Maybe you move this.ctx to this.#ctx and this.env to this.#env. Extending from DurableObject makes those public, but it's JavaScript so you can dynamically do whatever you want in the constructor.

- [ ] Authentication patterns
  ```ts
  // Single round trip: authenticate + fetch notifications
  let user = api.authenticate(cookie);
  let notifications = await user.getNotifications();
  ```

- [ ] Consider creating a two hop version of proxy-fetch that moves the timeout functionality served by the Orchestrator to the origin DO. It would create a dependency on alarms though. Right now, we use the single native alarm in the Orchestrator.

- [ ] Add an option to call for including the result handler execution in the same blockConcurrencyWhile on caller side.

- [ ] Add an option to call for blockConcurrencyWhile on callee side... or maybe transaction?

- [ ] Consider whether transaction is better for call than blockConcurrencyWhile?


## MCP

- [ ] Consider switching to A2A or ACP
- [ ] Consider using JS Proxy to for JSON RPC/MCP where JSON Schema is involved. This will allow us to have a simple method call that will still check the input schema. Look at what tRPC does with them.
- [ ] Add TypeBox Value support for RPC runtime checking (both TypeBox and JSON Schema)
  - Don't make TypeBox a dependency
  - Auto-detect TypeBox spec vs JSON Schema spec
- [ ] Implement the latest version of these interfaces:
  - [ ] https://github.com/modelcontextprotocol/python-sdk/blob/7c639ec1a59a0f7b84776b4c1937e7654a3b6960/src/mcp/client/transport_session.py
  - [ ] https://github.com/modelcontextprotocol/python-sdk/blob/7c639ec1a59a0f7b84776b4c1937e7654a3b6960/src/mcp/server/transport_session.py


## Infrastructure

- [ ] Deploy to Cloudflare button
- [ ] Move SonarQube Cloud account over to lumenize repo
- [ ] See `tasks/github-actions-publishing.md` for automation plans

## Website, Blog, etc.

- [ ] Cross post on Medium like this
        > If you are not a premium Medium member, read the full tutorial FREE here and consider joining medium to read more such guides.

## Blocked / Maybe later

- [ ] Implement `createLumenizeRouter` as the primary entry point into the mesh
  - Wraps `routeDORequest` but requires instance **names** only (no ids)
  - `routeDORequest` keeps `doInstanceNameOrId` for low-level flexibility
  - Will likely become the **only** way people connect into the mesh
  - Includes auth middleware + gateway routing
  - Some LumenizeClient/Gateway testing may be deferred until this is working
  - Update getting-started.mdx to use it

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