# Use Existing Infrastructure Pattern Consistently

**Status**: ARCHIVED - Pattern documented in call.ts JSDoc
**Type**: Implementation-First (internal refactoring)
**Archived**: 2025-11-16 - No separate callRaw utility needed; infrastructure pattern is operation chain + __executeOperation

## Objective

The infrastructure layer already exists! Stop manually managing preprocess/postprocess in proxy-fetch and other packages. Use the existing pattern: operation chains + `__executeOperation`.

## Resolution

No separate `callRaw` utility needed. The pattern is documented in `packages/call/src/call.ts` JSDoc:
1. Build operation chain with RAW data
2. Preprocess the chain once
3. Call `__executeOperation(preprocessedChain)`

Implementation continues in proxy-fetch refactoring.

## Problem Statement

**The Double-Preprocessing Bug (21+occurrences)**:
Infrastructure code (proxy-fetch, alarms, etc.) needs to make RPC calls with automatic serialization but keeps accidentally preprocessing data twice:

```typescript
// ❌ Mistake #21 - double preprocessing
const data = { response: await preprocess(responseSync) };
const preprocessed = await preprocess(data);  // Oops!
await stub.method(preprocessed);
```

**Current State**:
- `@lumenize/call` combines infrastructure RPC + NADIS/OCAN features in one layer
- Infrastructure code either:
  1. Manually uses `preprocess/postprocess` → error-prone
  2. Uses full `@lumenize/call` → overkill, requires NADIS/OCAN machinery

## The Existing Pattern

**Infrastructure code should use:**
```typescript
// Build operation chain with actual data
const chain = newContinuation<TargetDO>().handleResult(result);

// Send to remote DO
await targetDO.__executeOperation(await preprocess(chain));
```

That's it! No `callRaw` wrapper needed. The pattern itself prevents double-preprocessing.

## Why `__receiveResult` Existed

It was optimizing for "less data over wire" by storing continuation at origin. But this:
- Added complexity (storage, idempotency)  
- Made origin DO do more work
- Created foot-gun (manual preprocess)

The new pattern:
- ✅ Simpler (no origin storage)
- ✅ Better performance (less work in origin DO)
- ✅ Better reliability (fewer states to manage)
- ✅ Unified (everything uses `__executeOperation`)

## When to Use Each Layer

**Layer 1: Operation Chain + `__executeOperation`** (infrastructure)
```typescript
const chain = newContinuation<RemoteDO>().method(data);
await remoteDO.__executeOperation(await preprocess(chain));
```
Use for: proxy-fetch, alarms, queues, any infrastructure RPC

**Layer 2: `this.svc.call()`** (application)
```typescript
this.svc.call('REMOTE_DO', 'id', 
  this.ctn<RemoteDO>().method(),
  this.ctn().handleResult(this.ctn().$result)
);
```
Use for: Application-level DO↔DO calls with blockConcurrencyWhile

## Implementation Plan

### Phase 1: Refactor Proxy-Fetch
**Goal**: Use operation chain + `__executeOperation` pattern

**Changes**:
1. Remove origin DO storage of continuation
2. Pass continuation through orchestrator/executor
3. Executor fills continuation and calls `__executeOperation`
4. Remove idempotency checks from origin (not needed)
5. Orchestrator still stores for timeout handling

**Success**: All proxy-fetch tests pass, simpler origin DO

### Phase 2: Find Other Manual Preprocess Usage
**Goal**: Replace manual patterns with operation chain pattern

**Search for**:
```typescript
// Anti-pattern - manual preprocess
const preprocessed = await preprocess(data);
await stub.someMethod(preprocessed);
```

**Replace with**:
```typescript
// Correct pattern - operation chain
const chain = newContinuation<TargetDO>().someMethod(data);
await stub.__executeOperation(await preprocess(chain));
```

**Success**: No manual preprocess/postprocess in infrastructure code

### Phase 3: Evaluate `__receiveResult`
**Goal**: Determine if still needed

**Check**: Does alarms need it, or can alarms also use operation chain pattern?

**Success**: Either deprecate `__receiveResult` or document why it's still needed

### Phase 4: Documentation
**Goal**: Document the two-layer pattern

**Add to docs**:
- When to use operation chain + `__executeOperation` (infrastructure)
- When to use `this.svc.call()` (application)
- Examples of each

## Notes

- This is internal refactoring - no breaking changes to `@lumenize/call` public API
- Benefits realization: Use `callRaw` in proxy-fetch to fix the double-preprocessing bug
- Future packages can use `callRaw` for infrastructure needs

