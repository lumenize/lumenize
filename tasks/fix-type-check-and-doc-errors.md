# Fix Pre-existing Type-Check and Doc Validation Errors

## Objective

All vitest tests pass, but `npm run type-check` (4 packages) and `npm run check-examples` (1 doc) have errors that were introduced before the current session. These need to be fixed to restore a green CI baseline.

## Type-Check Errors (4 packages)

### 1. auth — `test/for-docs/endpoints.test.ts` and `test/for-docs/test-helpers.test.ts`

**15 errors total**. Two root causes:

- `Response.json()` returns `Promise<unknown>` — code accesses properties without type assertions (lines 74, 96, 135, 175, 206, 231, 293, 332, 376)
- `parseJwtUnsafe()` returns `{ header, payload } | null` — code accesses `.payload` without null check (lines 380, 382, 420 in endpoints; lines 69, 119 in test-helpers)

**Fix**: Add `as { ... }` type assertions on `await response.json()` calls and add null guards before `parseJwtUnsafe()` results.

### 2. debug — `src/index.ts` line 44

**1 error**: `Cannot find module 'cloudflare:workers'`

This is the cross-platform detection pattern from CLAUDE.md. The `await import('cloudflare:workers')` is inside a try/catch and is correct at runtime. TypeScript can't resolve it because `@cloudflare/workers-types` isn't in scope for this non-Workers package.

**Fix**: Add `// @ts-expect-error` — this is the canonical pattern for cross-platform detection.

### 3. mesh — `test/for-docs/alarms/index.test.ts` line 100

**1 error**: `Property 'delayInSeconds' does not exist on type 'Schedule'`

`Schedule` is a union (`ScheduledAlarm | DelayedAlarm | CronAlarm`). Only `DelayedAlarm` has `delayInSeconds`. Code accesses it without narrowing.

**Fix**: Narrow the type — either `(schedule as any).delayInSeconds` or a proper type guard on `schedule.type === 'delayed'`.

### 4. mesh — `test/for-docs/calls/document-do.ts` lines 138, 282, 289

**3 errors**: Mismatch between `OperationChain` (which is `Operation[]`) and `Continuation<T>` types in call signatures.

**Fix**: Investigate the API type signatures and fix the call sites to pass the correct types. This may involve using `ctn<T>()` instead of raw chains or adjusting function signatures.

### 5. structured-clone — `test/for-docs/maps-and-sets.test.ts` lines 12, 45, 46, 77

**4 errors**: Heterogeneous `Map` constructor (`new Map([["key", ...], [42, ...], [true, ...]])`) — TS can't infer the union of key types. Plus `unknown` type on restored values.

**Fix**: Explicitly type the Map as `Map<string | number | boolean, any>` and add type assertions on deserialized values.

## Check-Examples Error (1 doc)

### 6. `website/docs/mesh/getting-started.mdx` line 47

**Error**: Code block doesn't match `packages/mesh/test/for-docs/getting-started/document-do.ts`.

The test file was refactored to use `callChain[0]?.instanceName` for the guard, but the doc still uses `originAuth!.sub`. The doc also has a different null-check pattern.

**Doc guard** (stale):
```typescript
const sub = instance.lmz.callContext.originAuth!.sub;
if (!subscribers.has(sub)) {
```

**Test guard** (current):
```typescript
const clientId = instance.lmz.callContext.callChain[0]?.instanceName;
if (!clientId || !subscribers.has(clientId)) {
```

**Fix**: Update the `.mdx` code block to match the test file.

## Success Criteria

- [ ] `npm run type-check` — all 8 packages pass (auth, debug, fetch, mesh, rpc, structured-clone, testing, utils)
- [ ] `npm run check-examples` — 0 errors
- [ ] `npm run test:code` — still all passing (no regressions)
