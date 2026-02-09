# Mesh Resilience Integration Testing

**Status**: Not started

## Objective

Add integration tests for Gateway↔Client resilience behaviors that are currently only unit-tested. These tests use `createTestingClient` to manipulate Gateway state (force-close WebSockets, inspect alarms, verify storage) and `createTestRefreshFunction` for auth — the same patterns established in `tasks/mesh-testing-auth-strategy.md`.

Unit tests confirmed these behaviors work in isolation. Integration tests will exercise the full Client → Worker → auth hooks → Gateway → DO path and historically find 10x more bugs.

## Background

The `mesh-testing-auth-strategy` task proved that `createTestingClient` can manipulate Gateway WebSocket state via `ctx.getWebSockets()[0].close(code)` — a pattern that replaces `__testForceClose` and similar test helpers. This unlocks integration testing of resilience behaviors that were previously too awkward to test without cluttering the Gateway with test-only methods.

## Phases

### Phase 1: Grace period message queuing

**Goal**: Prove that when a mesh node sends a message to a disconnected client during the 5-second grace period, the Gateway queues the call and delivers it when the client reconnects.

**Success Criteria**:
- [ ] Connect client, subscribe to a DO
- [ ] Force-close via `createTestingClient` + `ctx.getWebSockets()[0].close(1006)` (triggers grace period alarm)
- [ ] Have the DO send a message to the client (hits `#waitForReconnect` in Gateway)
- [ ] Client reconnects within 5 seconds
- [ ] Verify: message is delivered, `subscriptionRequired: false`, no re-subscription needed

**Why it matters**: Core resilience mechanism for brief network drops. Users encounter this on mobile networks, laptop sleep/wake, and ISP blips.

### Phase 2: Grace period expiry with pending messages

**Goal**: Prove that when a client doesn't reconnect within the grace period, the alarm fires, pending waiters are rejected, and the DO receives a `ClientDisconnectedError`.

**Success Criteria**:
- [ ] Connect client, force-close, have DO send message during grace period
- [ ] Wait for alarm to fire (>5 seconds)
- [ ] Verify: DO receives `ClientDisconnectedError`
- [ ] Client eventually reconnects
- [ ] Verify: `subscriptionRequired: true`, `onSubscriptionRequired` fires, client re-subscribes

**Why it matters**: Validates graceful degradation when clients truly disconnect.

### Phase 3: Token expiry during active session

**Goal**: Prove that when a client's JWT expires mid-session, the Gateway detects it on the next message and closes with 4401, triggering the client's refresh→reconnect flow.

**Success Criteria**:
- [ ] Connect with `createTestRefreshFunction({ ttl: 2 })` (2-second token)
- [ ] Wait >2 seconds for token to expire
- [ ] Client makes a call through the mesh
- [ ] Gateway detects expired token, closes with 4401
- [ ] Client refreshes token and reconnects
- [ ] Verify: call eventually succeeds or client is reconnected

**Why it matters**: Validates the production token rotation path end-to-end.

### Phase 4: Supersession (4409)

**Goal**: Prove that when a second connection arrives for the same `instanceName`, the Gateway closes the first with 4409, the client ignores the stale close, and the new connection works.

**Success Criteria**:
- [ ] Connect client A with `instanceName: 'user.tab1'`
- [ ] Connect client B with same `instanceName: 'user.tab1'` (simulates duplicate tab)
- [ ] Verify: A's WebSocket receives 4409, A handles gracefully
- [ ] Verify: B is connected, B gets `subscriptionRequired: false`
- [ ] Verify: subsequent mesh calls route to B, not A

**Why it matters**: Duplicate tabs are a common real-world scenario.

### Phase 5: `onSubscriptionRequired` full lifecycle

**Goal**: Prove the full round-trip: Gateway sets grace period alarm → alarm fires → client reconnects → `subscriptionRequired: true` → client re-subscribes → DO acknowledges → state is restored.

**Success Criteria**:
- [ ] Connect, subscribe to DocumentDO, verify initial content
- [ ] Force-close, wait >5 seconds for alarm to fire
- [ ] Client reconnects
- [ ] Verify: `subscriptionRequired: true`, `onSubscriptionRequired` fires
- [ ] Client re-subscribes, receives current document state
- [ ] Verify: subsequent broadcasts still work

**Why it matters**: Full lifecycle test of the reconnection→re-subscription path.

### Phase 6: Access gate rejection

**Goal**: Prove that `createTestRefreshFunction({ adminApproved: false })` mints a JWT that the auth hooks' access gate rejects.

**Success Criteria**:
- [ ] Connect with `createTestRefreshFunction({ adminApproved: false })`
- [ ] Verify: connection rejected at Worker level (401)
- [ ] Connect with `createTestRefreshFunction({ emailVerified: false })`
- [ ] Verify: connection rejected at Worker level (401)

**Why it matters**: Confirms the access gate works end-to-end with self-minted tokens.

## Documentation

Consider one of:
- **`docs/mesh/resilience.mdx`** — Dedicated page documenting resilience behaviors (grace period, reconnection, token rotation, supersession) with `@check-example` annotations pointing to these tests
- **Blog post** — A narrative piece about how Lumenize Mesh handles real-world connection instability, with the integration tests as proof points. Good candidate for marketing Lumenize Mesh's developer experience and resilience story.

## Test Organization

These tests could live in a new `test/for-docs/resilience/` mini-app or be added as phases to the existing `security/` or `getting-started/` tests. A dedicated mini-app is preferred since the scenarios need their own wrangler.jsonc (the existing mini-apps don't have the right DO mix for all 6 scenarios).

## Related

- `tasks/mesh-testing-auth-strategy.md` — Established the `createTestingClient` + `createTestRefreshFunction` patterns used here
- `packages/mesh/src/lumenize-client-gateway.ts` — Grace period, alarm, supersession, token expiry logic
- `packages/mesh/src/lumenize-client.ts` — Reconnection, `onSubscriptionRequired`, `onLoginRequired`, stale close handling
- `packages/mesh/test/lumenize-client-gateway.test.ts` — Existing Gateway unit tests (these scenarios are unit-tested here)
- `packages/mesh/test/lumenize-client.test.ts` — Existing Client unit tests
