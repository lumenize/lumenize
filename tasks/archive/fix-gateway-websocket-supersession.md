# Fix Gateway WebSocket Supersession [COMPLETE]

**Status**: Complete — all changes implemented and tested.

## Objective

When a new WebSocket connection arrives at LumenizeClientGateway, the existing connection (if any) must be closed before accepting the new one. Previously, `fetch()` accepted a second WebSocket without closing the first, allowing stale sockets to accumulate. `#getActiveWebSocket()` returned `sockets[0]` which could be stale.

## What was done

### Phase 1: Gateway-side (`packages/mesh/src/lumenize-client-gateway.ts`)

1. **Added `WS_CLOSE_SUPERSEDED = 4409` constant** (exported) — parallel to HTTP 409 Conflict
2. **`fetch()` closes existing sockets before accepting** — iterates `ctx.getWebSockets()` and closes each with 4409 before `ctx.acceptWebSocket(server)`
3. **`#getActiveWebSocket()` hardened** — filters for `readyState === WebSocket.OPEN` instead of blindly returning `sockets[0]`
4. **`webSocketClose()` skips grace period for 4409** — no alarm set when the close was a supersession (new connection already exists)

### Phase 2: Client-side (`packages/mesh/src/lumenize-client.ts`)

5. **Stale close guard in `#connectInternal`** — captures `this.#ws` reference in the `onclose` closure; if `this.#ws` has been reassigned when close fires, the event is ignored (prevents old socket's close from clobbering a new connection)

### Tests

- `packages/mesh/test/lumenize-client-gateway.test.ts` — 3 new tests:
  - Second connection supersedes first; first receives close with code 4409
  - Mesh calls route to the new socket after supersession
  - `subscriptionsLost: false` on supersession (no grace period elapsed)
- `packages/mesh/test/lumenize-client.test.ts` — 2 new tests:
  - Old socket's stale close event doesn't clobber new connection
  - Normal close on current socket still works as expected

### Results

- [x] Existing sockets are closed with 4409 before accepting new connection
- [x] `#getActiveWebSocket()` only returns sockets with `readyState === WebSocket.OPEN`
- [x] `webSocketClose()` skips grace period alarm for code 4409
- [x] Test: second connection supersedes first; first receives close with code 4409
- [x] Test: mesh calls route to the new socket, not the old one
- [x] Test: old socket's close event doesn't clobber new connection
- [x] All existing tests still pass (125 mesh tests total, 5 new)
