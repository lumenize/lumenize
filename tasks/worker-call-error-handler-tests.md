# Worker call() Tests

## Objective
Add tests for Worker `call()` with result handlers — both success and error paths. The DO side already has these tests (`lumenize-do.test.ts`); the Worker side has zero `call()` tests.

## Investigation Findings

### Bug: Worker `call()` with result handler is broken
`LumenizeWorker` is missing `__localChainExecutor` (the getter that `LumenizeDO` has at line 380 of `lumenize-do.ts`). Worker `call()` references `workerInstance.__localChainExecutor` at `lmz-api.ts:775`, which resolves to `undefined`. Any `call()` with a result handler will crash when `createHandlerExecutor` tries to invoke `undefined(chain)`. Fire-and-forget (no handler) likely works since `setupFireAndForgetHandler` skips handler execution when `handlerChain` is undefined.

### Bug: Worker `call()` missing bindingName validation
DO `call()` throws if `this.bindingName` isn't set (`lmz-api.ts:614-619`). Worker `call()` (`lmz-api.ts:770-789`) has no such validation. Should be added for consistency.

### Cleanup: Unnecessary @mesh on DO result handlers
`TestDO.handleCallResult()` and `TestDO.handleCallError()` have `@mesh()` decorators, but result handlers don't need them — `createHandlerExecutor` passes `{ requireMeshDecorator: false }` (line 133). These are likely pre-bug-fix remnants. Remove them.

### DO→Worker error path is untested
No test exists where a DO calls a Worker method that throws and the DO's result handler receives the error. `TestWorker` has no `throwError()` remote handler.

### Observability for Worker result handlers
Workers are stateless — can't store results in `ctx.storage.kv` like DOs. Solution: Worker result handlers forward results to a DO via `callRaw()` for persistence. Tests read from the DO. This mirrors the real-world "two one-way calls" pattern already documented in `for-docs/calls/index.test.ts`.

## Implementation Plan

### Step 1: Fix `LumenizeWorker` missing `__localChainExecutor`
**File**: `packages/mesh/src/lumenize-worker.ts`

Add `__localChainExecutor` getter mirroring `LumenizeDO`:
```typescript
get __localChainExecutor(): (chain: OperationChain, options?: { requireMeshDecorator?: boolean }) => Promise<any> {
  return (chain, options) => executeOperationChain(chain, this, options);
}
```

### Step 2: Add bindingName validation to Worker `call()`
**File**: `packages/mesh/src/lmz-api.ts` (inside `createLmzApiForWorker`, the `call()` method)

Add the same guard as DO `call()`:
```typescript
if (!this.bindingName) {
  throw new Error(
    `Cannot use call() from a Worker that doesn't know its own binding name. ` +
    `Ensure incoming calls include metadata or call this.lmz.__init() first.`
  );
}
```

### Step 3: Remove unnecessary @mesh from DO result handlers
**File**: `packages/mesh/test/test-worker-and-dos.ts`

Remove `@mesh()` from:
- `TestDO.handleCallResult()` (line ~214)
- `TestDO.handleCallError()` (line ~220)

### Step 4: Add test helpers to `TestWorker`
**File**: `packages/mesh/test/test-worker-and-dos.ts`

Add to `TestWorker`:
- `@mesh() throwError(): never` — remote handler for DO→Worker error tests
- `testCallToDO(doBindingName, doInstanceName, value, resultStoreDOInstance)` — calls DO `remoteEcho`, result handler forwards result to DO via `callRaw`
- `testCallWithErrorToDO(doBindingName, doInstanceName, resultStoreDOInstance)` — calls DO `throwError`, result handler forwards error to DO via `callRaw`
- `testCallFireAndForget(doBindingName, doInstanceName, value)` — calls DO `remoteEcho` without handler
- `forwardResultToDO(resultStoreDOInstance, result)` — result handler that forwards to DO (no `@mesh` needed)
- `forwardErrorToDO(resultStoreDOInstance, error)` — result handler that forwards error to DO (no `@mesh` needed)
- `testCallWithoutBindingName(...)` — calls `call()` without setting bindingName

### Step 5: Add test helper to `TestDO`
**File**: `packages/mesh/test/test-worker-and-dos.ts`

Add to `TestDO`:
- `testCallWithErrorToWorker(workerBindingName)` — DO calls Worker `throwError`, result handler `handleCallError` stores error
- `storeForwardedResult(result)` — stores a forwarded result from a Worker (for Worker→DO→store pattern)
- `storeForwardedError(error)` — stores a forwarded error from a Worker
- `getForwardedResult()` / `getForwardedError()` — getters for the above

### Step 6: Add Worker `call()` tests
**File**: `packages/mesh/test/lumenize-worker.test.ts`

New describe block: `'LumenizeWorker - call() Fire-and-Forget with Result Handlers'`

Tests:
1. **Worker `call()` happy path** — Worker calls DO `remoteEcho`, result handler forwards result to a storage DO, test reads from DO
2. **Worker `call()` error path** — Worker calls DO `throwError`, result handler forwards error to storage DO
3. **Worker `call()` fire-and-forget** — Worker calls DO without handler, no crash
4. **Worker `call()` validation: no bindingName** — throws appropriate error
5. **DO→Worker error via `call()`** — DO calls Worker `throwError`, DO result handler stores error, test reads from DO

All async tests use `vi.waitFor` to poll for results (not `setTimeout`).

## Success Criteria
- All new tests pass
- All existing tests still pass
- Worker `call()` with result handlers works end-to-end
- DO→Worker error path is covered
- No unnecessary `@mesh` decorators on result handlers
