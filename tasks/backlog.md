# Backlog

Small tasks and ideas for when I have time (evening coding, etc.)

## Testing & Quality

- [ ] Show that private methods are not available over Lumenize RPC
- [ ] Test websocket-shim throws when passed http[s] urls (requires changing matrix tests)
- [ ] Test in production on Cloudflare (not just local with vitest)

## Documentation

- [ ] Update the vs Cap'n Web docs to talk about RpcTarget with a new doc-test
- [ ] Add examples/docs for plucking bindingName and instanceNameOrId from headers into storage
- [ ] Move promise pipelining from quirks to its own doc section and use our new name for it Operation Chaining and Nesting (OCAN)
- [ ] Add comprehensive security documentation (currently just a warning)

## RPC Features to Demo/Test

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

- [ ] Consider forking @ungap/structured-clone to claim zero dependencies

## Infrastructure

- [ ] Deploy to Cloudflare button
- [ ] Move SonarQube Cloud account over to lumenize repo
- [ ] See `decisions/github-actions-publishing.md` for automation plans

