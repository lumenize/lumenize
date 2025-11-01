# Backlog

Small tasks and ideas for when I have time (evening coding, etc.)

## Testing & Quality

- [ ] Show that private methods are not available over Lumenize RPC
- [ ] Test websocket-shim throws when passed http[s] urls (requires changing matrix tests)
- [ ] Test in production on Cloudflare (not just local with vitest)
- [ ] Revisit Workers RPC type support testing methodology
  - Investigate why Headers appeared to be supported in Workers RPC when Cap'n Web analysis showed it's only a type annotation
  - Review testing approach to ensure we're testing actual serialization, not just TypeScript type compatibility
  - Audit type support table for other potentially incorrect entries (check serialization vs type annotations)
  - Improve testing to distinguish between type system support and runtime serialization support
- [ ] Add missing alias tests for @lumenize/structured-clone
  - Test multiple paths to same object (true aliases - obj.a and obj.b both point to same object)
  - Test deep cycles (A→B→C→A)
  - Test cycles in Map keys (keys can be objects)
  - Test shared subtree aliases (two different paths leading to same subtree)
  - Performance tests with large cyclic structures

## Documentation

- [ ] Update the vs Cap'n Web docs to talk about RpcTarget with a new doc-test
- [ ] Add examples/docs for plucking bindingName and instanceNameOrId from headers into storage
- [ ] Move promise pipelining from quirks to its own doc section and use our new name for it Operation Chaining and Nesting (OCAN)
- [ ] Add comprehensive security documentation (currently just a warning)

## RPC Features to Demo/Test

- [ ] Maybe we need a way to secure the DO access over RPC so it can't change storage, or maybe we just need examples that show it not being accessible. Maybe you move this.ctx to this.#ctx and this.env to this.#env. Extending from DurableObject makes those public, but it's JavaScript so you can dynamically do whatever you want in the constructor.

- [ ] RpcPromise acts as stub for eventual result - can access properties without awaiting
  ```ts
  // Single round trip: authenticate + fetch notifications
  let user = api.authenticate(cookie);
  let notifications = await user.getNotifications();
  ```

- [ ] RpcPromise can be passed as parameter to other RPC calls
  ```ts
  // Single round trip: authenticate + fetch profile by ID
  let user = api.authenticate(cookie);
  let profile = await api.getUserProfile(user.id);
  ```

## Technical Improvements

- [ ] Add TypeBox Value support for RPC runtime checking (both TypeBox and JSON Schema)
  - Don't make TypeBox a dependency
  - Auto-detect TypeBox spec vs JSON Schema spec
  
- [ ] Move debugOff into @lumenize/utils

- [ ] Improve debug message control with global config
  - More granular than current approach
  - Consider scoped "where" clauses
  - Not necessarily env-var based like old debug library

- [x] ~~Consider forking @ungap/structured-clone to claim zero dependencies~~ (DONE - see tasks/structured-clone-fork.md)

- [ ] Investigate server-side transport pluggability for RPC
  - Currently only client-side has pluggable transports (HTTP/WebSocket)
  - Server-side is tightly coupled to Cloudflare's fetch/WebSocket handlers
  - Would allow custom serialization, compression, or alternative protocols
  - Challenge: Cloudflare's WebSocket lifecycle is deeply integrated
  - Likely answer is "no" due to platform constraints, but worth investigating

- [ ] Simplify OCAN proxy-to-marker conversion in client.ts
  - `processOutgoingOperations()` currently does manual serialization walk
  - Can be much simpler: only walk operation chain, stop at parameters
  - No risk of cycles/aliases in operation chains → no WeakMap needed
  - @lumenize/structured-clone handles all parameter serialization
  - Should significantly reduce code complexity

## Infrastructure

- [ ] Deploy to Cloudflare button
- [ ] Move SonarQube Cloud account over to lumenize repo
- [ ] See `decisions/github-actions-publishing.md` for automation plans

