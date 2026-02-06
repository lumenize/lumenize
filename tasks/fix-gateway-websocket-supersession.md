# Fix Gateway WebSocket Supersession

## Objective

When a new WebSocket connection arrives at LumenizeClientGateway, the existing connection (if any) must be closed before accepting the new one. Currently, `fetch()` accepts a second WebSocket without closing the first, allowing stale sockets to accumulate. `#getActiveWebSocket()` returns `sockets[0]` which may be stale.

## Background

- Gateway is 1:1 with each client (instance name = `{sub}.{tabId}`)
- Multiple WebSockets in a single Gateway instance is always a bug — it means the client reconnected
- Cloudflare docs confirm: `ws.close()` puts the socket into `CLOSING` readyState and `getWebSockets()` still returns it until the close handshake completes

## Phase 1: Close existing sockets on new connection

**Goal**: Ensure only one active WebSocket per Gateway at all times.

**Changes** (`packages/mesh/src/lumenize-client-gateway.ts`):

1. **In `fetch()`, before `ctx.acceptWebSocket(server)`** (~line 319):
   - Get existing sockets via `ctx.getWebSockets()`
   - Close each with code `4409` ("Superseded by new connection")
   - Then proceed to accept the new socket

2. **Harden `#getActiveWebSocket()`** (~line 698):
   - Change from `sockets[0]` to filtering for `readyState === WebSocket.OPEN`
   - Handles the transient window where a closing socket is still in `getWebSockets()`

3. **Define close code constant**:
   - Add `WS_CLOSE_SUPERSEDED = 4409` alongside existing close code constants

**Success Criteria**:
- [ ] Existing sockets are closed with 4409 before accepting new connection
- [ ] `#getActiveWebSocket()` only returns sockets with `readyState === WebSocket.OPEN`
- [ ] Test: second connection supersedes first; first receives close with code 4409
- [ ] Test: mesh calls route to the new socket, not the old one
- [ ] All existing tests still pass

## Phase 2: Verify client-side handling

**Goal**: Confirm LumenizeClient handles the 4409 close correctly.

**Analysis needed**:
- When the server closes the old WebSocket with 4409, the client-side socket sees a close event
- Since the client already initiated a *new* connection (that's what caused the 4409), the close event on the old socket should be a no-op
- Verify that `#handleClose` in `lumenize-client.ts` doesn't interfere with the new connection
- If the close arrives after `#ws` has been reassigned, `#handleClose` sets `this.#ws = null` which would clobber the new socket — investigate if this is possible

**Success Criteria**:
- [ ] Client reconnection with 4409 close on old socket does not trigger spurious reconnect
- [ ] No race between old socket's `onclose` and new socket assignment

## Notes

- Close code 4409 chosen as a parallel to HTTP 409 Conflict — "superseded by new connection"
- The readyState filter is a belt-and-suspenders safeguard for the transient `CLOSING` state
- This is the only Gateway bug listed as CRITICAL in `tasks/backlog.md`
