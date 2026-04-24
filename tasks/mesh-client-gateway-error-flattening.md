# Mesh: `LumenizeClientGateway` flattens `ClientDisconnectedError` on grace-period path

**Status**: Not started. Small focused fix.

**Depends on**: None.
**Package**: `packages/mesh/`

## The bug

`LumenizeClientGateway.__executeOperation` has two code paths for "client disconnected":

1. **No grace period active**: returns `{ $error: preprocess(new ClientDisconnectedError(...)) }` — clean, error class name preserved through the preprocess/postprocess round-trip.
2. **In grace period**: `await this.#waitForReconnect()` *throws* (unwrapped) when `alarm()` fires `#rejectReconnectWaiters`. Workers RPC flattens the custom class; caller sees `err.name === 'Error'`, class name embedded in `err.message`.

The two paths should be symmetric. A caller relying on `instanceof ClientDisconnectedError` or `err.name === 'ClientDisconnectedError'` after a grace-period timeout gets the wrong answer.

## Fix

Wrap the `#waitForReconnect` call in `try/catch` and route the caught error through `preprocess` like the no-grace-period path:

```typescript
// packages/mesh/src/lumenize-client-gateway.ts (~line 549)
try {
  await this.#waitForReconnect();
} catch (err) {
  return { $error: preprocess(err) };
}
```

## Work items

- [ ] Apply the fix in `packages/mesh/src/lumenize-client-gateway.ts`.
- [ ] Add a regression test: client in grace period, force `alarm()` to fire `#rejectReconnectWaiters`, assert caller receives `err.name === 'ClientDisconnectedError'` (or `instanceof` if the test harness supports it).
- [ ] Check whether any existing tests match against the message-substring workaround (alarm-accuracy's disconnect test did this); update them to use the proper error-class check.

## Discovery

Found 2026-04-22 during Phase 2 of the alarm-accuracy experiment (disconnect spot-check test). Originally captured in [`tasks/archive/nebula-5.2.4.1-validator-engine-upgrade.md`](archive/nebula-5.2.4.1-validator-engine-upgrade.md) Phase -1; promoted to its own task 2026-04-24 when closing that parent task.
