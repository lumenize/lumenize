# Fix Gateway WebSocket Supersession

## Objective

When a new WebSocket connection arrives at LumenizeClientGateway, the existing connection (if any) must be closed before accepting the new one. Currently, `fetch()` accepts a second WebSocket without closing the first, allowing stale sockets to accumulate. `#getActiveWebSocket()` returns `sockets[0]` which may be stale.

## Background

- Gateway is 1:1 with each client (instance name = `{sub}.{tabId}`)
- Multiple WebSockets in a single Gateway instance is always a bug — it means the client reconnected
- Cloudflare docs confirm: `ws.close()` puts the socket into `CLOSING` readyState and `getWebSockets()` still returns it until the close handshake completes

## Phase 1: Gateway-side — close existing sockets on new connection

**Goal**: Ensure only one active WebSocket per Gateway at all times.

**Changes** (`packages/mesh/src/lumenize-client-gateway.ts`):

1. **Define close code constant**:
   - Add `WS_CLOSE_SUPERSEDED = 4409` alongside existing constants at top of file
   - Parallel to HTTP 409 Conflict — "superseded by new connection"

2. **In `fetch()`, before `ctx.acceptWebSocket(server)`** (~line 319):
   - Get existing sockets via `ctx.getWebSockets()`
   - Close each with code `4409` ("Superseded by new connection")
   - Then proceed to accept the new socket
   - Order: `determineSubscriptionState()` → close existing sockets → `acceptWebSocket(server)`

3. **Harden `#getActiveWebSocket()`** (~line 698):
   - Change from `sockets[0]` to filtering for `readyState === WebSocket.OPEN`
   - Handles the transient window where a closing socket is still in `getWebSockets()`

4. **Skip grace period alarm in `webSocketClose()` when code is 4409**:
   - A 4409 close means a new connection already replaced this one
   - Setting a grace period alarm is unnecessary and wasteful
   - If there was already a pending grace period alarm from a previous disconnection, the new `fetch()` already clears it (lines 326-329)

**Success Criteria**:
- [ ] Existing sockets are closed with 4409 before accepting new connection
- [ ] `#getActiveWebSocket()` only returns sockets with `readyState === WebSocket.OPEN`
- [ ] `webSocketClose()` skips grace period alarm for code 4409
- [ ] Test: second connection supersedes first; first receives close with code 4409
- [ ] Test: mesh calls route to the new socket, not the old one
- [ ] All existing tests still pass

## Phase 2: Client-side — fix stale close race condition

**Goal**: Prevent old socket's `onclose` from clobbering a new connection.

**Analysis**:
- When the server closes the old WebSocket with 4409, the client-side socket fires `onclose`
- The client has already created a new WebSocket and assigned it to `this.#ws`
- `#handleClose` unconditionally sets `this.#ws = null` — this clobbers the new socket
- The `onclose` handler is `(event) => this.#handleClose(...)` which captures `this`, not the socket reference
- So the old socket's close event calls `#handleClose` which nullifies the *new* socket

**Fix** (`packages/mesh/src/lumenize-client.ts`):
- In `#connectInternal`, capture `this.#ws` in the `onclose` closure
- When `onclose` fires, check if `this.#ws` still points to the same socket
- If not, this is a stale close event from a superseded socket — ignore it
- This is minimal and surgical — handles all edge cases without restructuring

**Success Criteria**:
- [x] ~~Client reconnection with 4409 close on old socket does not trigger spurious reconnect~~ → Stale close on old socket is ignored when `this.#ws` has been reassigned
- [x] ~~No race between old socket's `onclose` and new socket assignment~~ → Guard in closure prevents the race
- [ ] Test: old socket's close event doesn't clobber new connection

## Notes

- Close code 4409 chosen as a parallel to HTTP 409 Conflict — "superseded by new connection"
- The readyState filter in `#getActiveWebSocket()` is a belt-and-suspenders safeguard for the transient `CLOSING` state
- This is the only Gateway bug listed as CRITICAL in `tasks/backlog.md`
