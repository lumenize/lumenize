# Backlog

Small tasks and ideas for when I have time (evening coding, etc.)

## Immediate work backlog

- [ ] Refactor to use `using` keyword for Workers RPC stubs (Explicit Resource Management)
  - Cloudflare added support in Feb 2025: https://developers.cloudflare.com/changelog/2025-02-28-wrangler-v4-rc/#the-using-keyword-from-explicit-resource-management
  - **Why it matters**: Without `using`, stubs held in wall-clock billing mode
  - **Pattern**: `using` is lexically scoped (NOT reference-counted like WeakMap). Disposal happens when the declaring scope exits, regardless of who holds references. Therefore, `using` must be at the **call site**, not inside helper functions that return stubs.
  - **Changes needed**:
    1. `packages/utils/src/get-do-stub.ts` — Add JSDoc explaining callers SHOULD use `using`:
       ```typescript
       /**
        * Caller SHOULD use `using` for automatic disposal to enable DO hibernation:
        * ```typescript
        * using stub = getDOStub(namespace, id);
        * ```
        */
       ```
    2. `packages/utils/src/route-do-request.ts:320` — Change to `using stub = getDOStub(...)`
    3. `packages/lumenize-base/src/lmz-api.ts:375` and `:578` — Change to `using stub = getDOStub(...)`
- [ ] Do some analysis on this and our current code: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#always-await-rpc-calls
- [ ] Related to above, find and remove all blockConcurrencyWhile. If we want fire and forget, just use a promise with a .then and .catch.
- [ ] Build something that use the npm create functionality or Cloudflare's own deploy button or Cloudflare may have it's own create workers project plugin capability.

## Lumenize Mesh

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

- [ ] In lumenize-auth.ts, The #extractCookie method uses cookie.trim().split('=') and destructures only the first two elements. If a cookie value contains = characters (valid in cookies), only the portion before the first = is returned. For example, a cookie "name=abc=def" would return "abc" instead of "abc=def". While current tokens use base64UrlEncode which strips = padding, this implementation is fragile and could cause authentication failures if the token format changes or if this code is reused elsewhere.

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

- [ ] Add admin token revocation endpoint to LumenizeAuth
  - Endpoint like `DELETE /auth/users/:userId/sessions` to revoke all refresh tokens for a user
  - Requires super-admin concept (not yet implemented)
  - Use case: user device stolen, employee leaves, suspicious activity
  - Implementation: `DELETE FROM refresh_tokens WHERE user_id = ${userId}`

- [ ] Evolve LumenizeAuth schema for multi-email users (Nebula prep)
  - Current: 1:1 user↔email (`users.email` column)
  - Future: 1:many via separate `user_emails` table
  - Support verified/unverified emails, primary email designation
  - Domain extraction for enterprise domain restrictions (e.g., `@acme.com` only)
  - Discovery flow: existing user adds new email, links to same account

- [ ] Create `website/docs/lumenize-mesh/testing.mdx` — Adapt `@lumenize/testing` Agents patterns for LumenizeClient
  - Similar to `/docs/testing/agents.mdx` but for mesh clients
  - Show multi-user scenarios with separate `Browser` instances
  - Token refresh testing with cookie simulation
  - RPC access to DO internals for verification
  - Document `WebSocket` injection pattern (LumenizeClient must support this like AgentClient does)
- [ ] Implement onStart with auto blockConcurrencyWhile
- [ ] Consider always using a transactionSync for every continuation execution. Maybe make it a flag?
- [ ] Document our identity propogation as better than init(). init() breaks the mold of just access don't create DOs.

- [ ] Implement generic pub/sub between mesh nodes. Use `using` keyword on both client instantiation `using client = new ClientExtendingLumenizeClient` and `using sub = client.subscribe(...)` calls

- [ ] Refactor getting-started guide to use native pub/sub once implemented
  - Current implementation manually manages subscribers Set in storage
  - Replace with built-in subscription primitives
  - Will simplify DocumentDO significantly (no more #broadcastContent, subscriber management)

- [ ] Consider adding explicit guidance that while async/await is discouraged, using Promise then/catch is fine. In that case, you are explicitly aknowledging that you know the input gates may open... or do they? We should answer that before deciding what to say.

- [ ] Add `{ twoOneWayCalls: true }` option to `this.lmz.call()` config parameter [LM: This may be outdated. You can just do a fire and forget on the caller side and then call back independently on the callee side.
  - Opt-in two one-way call mode for cost optimization on known slow operations
  - Caller gets immediate ACK, real response comes via callback
  - Useful for external API calls where you don't want DO wall-clock billing while waiting

- [ ] Consider auto-switch to two one-way mode
  - The original use case for this is when a caller is waiting on a Gateway response but the client is in the 5 second grace period, but this could be useful in general. For the Gateway situation, the callee knows it's a long running operation and could immediately respond with "switching to two one-way calls".
  - For other scenarios, the callee would have to notice that the handler was taking a long time to resolve and send the "switching to two one-way calls" message. How long?
  - Caller infrastructure recognizes this and waits for callback instead of blocking
  - Prevents cascading latency when multiple DOs call the same just-disconnected client
  - More complex but elegant — only pays the cost when needed

- [ ] Consider further decoupling LumenizeClient token refresh from `@lumenize/auth`
  - Current design: `refresh: string | () => Promise<string>` (docs updated 2025-01-14)
  - String form: POST to endpoint, expects `{ access_token }` response (default: `/auth/refresh-token`)
  - Function form: Custom refresh logic returning token string directly
  - Consider: Should we support additional response shapes for string form (configurable field name)?

- [ ] Implement `createLumenizeRouter` as the primary entry point into the mesh
  - Wraps `routeDORequest` but requires instance **names** only (no ids)
  - `routeDORequest` keeps `doInstanceNameOrId` for low-level flexibility
  - Will likely become the **only** way people connect into the mesh
  - Includes auth middleware + gateway routing
  - Some LumenizeClient/Gateway testing may be deferred until this is working
  - Update getting-started.mdx to use it

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

## LumenizeBase NADIS modules

- [ ] mcp
- [ ] per-resource sync
- [ ] Fanout broadcase service
      The first "tier" should actually be instantiating the class in the originator of the fan-out. The subsequent tiers would be armies of stand-alone LumenizeWorkers. You'd pass the list of receipients and the message into the local instance, and it would figure out how to tier it. We'd have to do experiments and update the learning periodically as Cloudflare evolved things to determine the optimal number of nodes to fan out to in each tier. 

      Maybe an algorithm like this. If it were between 64 and 4,096 (64^2) nodes, then take the square root, so 8 to 64 fanout in each tier. Any list shorter than 64 gets done in one shot. Between 4,096 and 262,144 (64^3), it would be three tiers of 8 to 64 each taking the cube root of the count. I doubt we want to even allow up to 262,144 but maybe 10,000 is possible?


## Testing & Quality

- [ ] Show that private methods are not available over Lumenize RPC

- [ ] Test websocket-shim throws when passed http[s] urls (requires changing matrix tests)

- [ ] Test in production on Cloudflare (not just local with vitest)

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

- [ ] Update the vs Cap'n Web docs to talk about RpcTarget with a new doc-test

- [ ] Add examples/docs for plucking bindingName and instanceNameOrId from headers into storage

- [ ] Move promise pipelining from quirks to its own doc section and use our new name for it Operation Chaining and Nesting (OCAN)

- [ ] Add comprehensive security documentation (currently just a warning)

- [ ] Add llms.txt support https://github.com/din0s/docusaurus-plugin-llms-txt

- [ ] Add MCP server for docs
  
- [ ] Consider adding this to BSL and maybe other licenses:
        The Software, or any part of it, including its source code, may not be used
        to create, train, or improve any artificial intelligence or machine learning
        models or systems, or to generate any datasets, without the express written
        permission of the copyright holder(s).

## Future bigger things

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