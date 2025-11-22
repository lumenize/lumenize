# Backlog

Small tasks and ideas for when I have time (evening coding, etc.)

## Immediate work backlog

- [ ] Make pattern for registering callback executor the same for call and proxy-fetch
- [ ] Update the alarms JSDoc and user-facing docs to remove standalone usage
- [ ] Try RpcTarget instead of WorkerEntrypoint as base for proxyFetch Executor
- [ ] Make sure that our alarm handler returns immediately and the user's handler is tried after that. I'm afraid that when the user's handler has a bug, and doesn't return successfully, we create a thundering herd.
- [ ] One benefit of proxy-fetch is that it's sync automatically. If you want to fire off several in parallel, that's easy. Show the code difference for parallel when doing direct

## LumenizeBase NADIS modules

- [ ] mcp
- [ ] per-resource sync


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

- [ ] Review/edit the new docs for through Phase 4:
  - [x] structured-clone
  - [x] maps and sets
  - [ ] lumenize-base
    - [ ] Closer to true Actor model with outgoing and incomming queues
    - [ ] How the graph of DO instances is self-organizing. Each instance called gets it's binding and instance name from the caller. Mention the headers here and document them in routeDORequest
    - [ ] this.svc and NADIS (split from lumenize-base)
    - [ ] this.ctn()
  - [WiP: Phase 1] core
    - [ ] Introduction
    - [x] debug
    - [ ] sql
  - [ ] testing alarms (simulation and triggering)
  - [ ] alarms
  - [ ] call
    - [ ] What it does not do that Workers RPC does. No passing functions or stubs because they hold the DO in wall clock billing time as long as they are held by the other end, can break without a clear way to recover from, and leave resources dangling. No awaiting-that also incurs wall clock billing and can't be used from non-async methods. Rather, it's done with two one-way Workers RPC calls. This is how we can efficiently use it for proxy-fetch where the fetch could be seconds of continuous billing.
    - [ ] What it does that Workers RPC does not. Operation chaining and nesting (OCAN). Abitrarily complex operations where the result of one in the input of another... all in a single round trip. Continue to always support cycles and aliases.
  
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
