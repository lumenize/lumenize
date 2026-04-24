# Mesh: `LumenizeClientGateway` flattens `ClientDisconnectedError` on grace-period path

**Status**: Complete (2026-04-24). Fix landed in [`packages/mesh/src/lumenize-client-gateway.ts`](../packages/mesh/src/lumenize-client-gateway.ts) at the grace-period branch of `__executeOperation`; two new tests in [`packages/mesh/test/lumenize-client-gateway.test.ts`](../packages/mesh/test/lumenize-client-gateway.test.ts) (`Grace period and alarm` describe block) prove class-name preservation on grace-period expiry and the reconnect happy path. Full mesh suite (361 tests) green.

**Depends on**: None.
**Package**: `packages/mesh/`

## The bug

`LumenizeClientGateway.__executeOperation` has two code paths for "client disconnected":

1. **No grace period active** ([lumenize-client-gateway.ts:424](../packages/mesh/src/lumenize-client-gateway.ts)): returns `{ $error: preprocess(new ClientDisconnectedError(...)) }` — clean, error class name preserved through the preprocess/postprocess round-trip.
2. **In grace period** ([lumenize-client-gateway.ts:413](../packages/mesh/src/lumenize-client-gateway.ts)): `await this.#waitForReconnect()` *throws* (unwrapped). Workers RPC flattens the custom class; caller sees `err.name === 'Error'`, class name embedded in `err.message`.

`#waitForReconnect` can throw three ways, all producing the same flattened-error symptom:
- `alarm()` fires `#rejectReconnectWaiters(new ClientDisconnectedError(...))` ([:381](../packages/mesh/src/lumenize-client-gateway.ts))
- Synchronous throw at [:721](../packages/mesh/src/lumenize-client-gateway.ts) (alarm is null)
- Synchronous throw at [:729](../packages/mesh/src/lumenize-client-gateway.ts) (alarm already elapsed)

The two paths should be symmetric. A caller relying on `instanceof ClientDisconnectedError` or `err.name === 'ClientDisconnectedError'` after a grace-period timeout gets the wrong answer.

## Fix

Wrap the `#waitForReconnect` call in `try/catch` and route the caught error through `preprocess` like the no-grace-period path. Leave the subsequent `ws = this.#getActiveWebSocket()` / null-check in place — they still run when `#waitForReconnect` resolves cleanly:

```typescript
// packages/mesh/src/lumenize-client-gateway.ts (~line 413)
try {
  await this.#waitForReconnect();
} catch (err) {
  return { $error: preprocess(err) };
}
ws = this.#getActiveWebSocket();

if (!ws) {
  return { $error: preprocess(new ClientDisconnectedError(
    'Client did not reconnect in time',
    this.#getInstanceName()
  )) };
}
```

## Why no production code currently depends on this

Grep across `packages/` confirms no production code `instanceof`-checks `ClientDisconnectedError` from a grace-period expiry, and nothing does substring-matching on a flattened error message. The only observed "workaround" was a single test assertion in the alarm-accuracy experiment ([experiments/alarm-accuracy/test/alarm-accuracy.test.ts:281](../experiments/alarm-accuracy/test/alarm-accuracy.test.ts)), which doesn't count as a valid user.

The absence of users is a test-coverage gap, not a signal the grace-period branch is dead code. The 5 s grace period is a real product capability — it lets transient disconnects (WiFi blip, client refresh) recover transparently by holding a mesh-side push until reconnect. Removing the branch would regress that. Keep it; add real tests.

## Work items

- [x] **Write failing tests first** in [packages/mesh/test/lumenize-client-gateway.test.ts](../packages/mesh/test/lumenize-client-gateway.test.ts), `Grace period and alarm` describe block:
  - [x] **Grace-period-expiry test (drives the fix):** connect WS, close it (grace alarm armed), start `__executeOperation` without awaiting, call `runDurableObjectAlarm(gateway)` to fire `#rejectReconnectWaiters`, await the operation → expect `result.$error` defined and `postprocess(result.$error) instanceof ClientDisconnectedError`. Failed pre-fix (`await opPromise` threw a flattened `Error: ClientDisconnectedError: ...`); passes post-fix.
  - [x] **Grace-period-reconnect test (closes the other coverage gap):** connect WS, close it, start `__executeOperation` without awaiting, reconnect a fresh WS before grace expires, respond to the forwarded `INCOMING_CALL`, await → expect `result.$result` defined. Passed pre-fix too (confirming the fix didn't regress the happy path).
- [x] **Confirm `preprocess(err)` preserves the class name.** Confirmed via the new expiry test; the existing round-trip test at [packages/mesh/test/lumenize-client-gateway.test.ts:298–307](../packages/mesh/test/lumenize-client-gateway.test.ts) already guaranteed this for `ClientDisconnectedError`.
- [x] **Apply the fix** in [packages/mesh/src/lumenize-client-gateway.ts](../packages/mesh/src/lumenize-client-gateway.ts) (grace-period branch of `__executeOperation`). The `try/catch` wraps only `#waitForReconnect`; subsequent `ws = this.#getActiveWebSocket()` and null-check remain untouched.
- [x] **Cross-check with [tasks/mesh-resilience-testing.md](mesh-resilience-testing.md) Phase 2.** Phase 2 now points to this task's unit test as prior art; the Phase 2 end-to-end scenario (real DO → client round-trip + resubscription) can build on it rather than duplicate the narrow class-name check.

## Non-goals

- No update to the alarm-accuracy experiment test. Experiments aren't maintained; their results are already captured. The `.toMatch(/ClientDisconnectedError/)` assertion there can rot with the rest.

## Discovery

Found 2026-04-22 during Phase 2 of the alarm-accuracy experiment (disconnect spot-check test). Originally captured in [`tasks/archive/nebula-5.2.4.1-validator-engine-upgrade.md`](archive/nebula-5.2.4.1-validator-engine-upgrade.md) Phase -1; promoted to its own task 2026-04-24 when closing that parent task.
