# callRaw - RPC Call Infrastructure with Metadata Propagation

**Status**: Planning

## Objective

Create **two-layer RPC architecture** for consistent, high-quality calls across all Lumenize code.

### Layer 1: callRaw() - Infrastructure (Public in both classes)
- **Async**: Returns `Promise<any>` with fully postprocessed result
- **Pure RPC**: Build envelope, get stub, send, return result
- **Metadata propagation**: Automatic caller + callee identity in envelope
- **Universal**: Works in LumenizeBase (DOs) and LumenizeWorker (Workers)

### Layer 2: call() - Application Pattern (LumenizeBase only)
- **Synchronous**: Returns void, uses `blockConcurrencyWhile`
- **Continuation pattern**: Handler receives result or Error
- **Error handling**: Catches errors, injects into handler continuation
- **Marker substitution**: Replaces nested operation placeholders
- **DO-optimized**: Leverages blockConcurrencyWhile for non-blocking execution

**Primary Goals** (in priority order):
1. **Consistency**: All RPC calls use the same envelope format
2. **Quality**: Proper metadata handling, error detection, and evolvability
3. **Clear separation**: Infrastructure (callRaw) vs Application (call)
4. **DRY**: Single source of truth for envelope format and metadata propagation
5. **Evolvability**: Adding new metadata fields happens in one place

## Problem

**Current state**:
- Manual envelope creation in `@lumenize/call`
- `@lumenize/proxy-fetch` duplicates metadata handling code
- Tests manually call `__lmzInit`
- No Worker support (Workers can't use current `call()`)
- Hard to evolve (adding metadata field requires changes in multiple places)

**Example boilerplate** (in packages/call/src/call.ts):
```typescript
// Manual validation
const originBinding = ctx.storage.kv.get('__lmz_do_binding_name');
if (!originBinding) throw new Error('...');

// Manual stub acquisition  
const remoteStub = getDOStub(env[doBinding], doInstanceNameOrId);

// Manual preprocessing
const preprocessed = await preprocess(remoteChain);

// Send (no callee metadata!)
const result = await remoteStub.__executeOperation(preprocessed);
```

## Why Two Layers?

### Layer 1: callRaw() - Infrastructure
**Purpose**: Raw RPC transport with metadata propagation

**Used by**:
- Application code that wants simple async calls
- `call()` implementation internally
- Infrastructure code (`@lumenize/proxy-fetch`, `@lumenize/alarms`)
- Workers (no blockConcurrencyWhile available)
- Tests (simpler than continuation pattern)

**Example**:
```typescript
// In LumenizeBase or LumenizeWorker
const result = await this.callRaw(chain, 'REMOTE_DO', 'instance-123');
// result is fully postprocessed and ready to use
```

### Layer 2: call() - Application Pattern
**Purpose**: Non-blocking DO-to-DO calls with continuation pattern

**Used by**:
- Application DOs that want fire-and-forget pattern
- DOs that need non-blocking execution
- Code following the "synchronous by default" DO pattern

**Example**:
```typescript
// In LumenizeBase only
this.call(
  'REMOTE_DO',
  'instance-123',
  this.ctn<RemoteDO>().getUserData(userId),
  this.ctn().handleResult(this.ctn<RemoteDO>().getUserData(userId))
);
// Returns immediately! Handler called when result arrives
```

## Architecture

### Core Concepts

**Envelope Format** (versioned for evolution):
```typescript
interface CallEnvelope {
  version: 1;  // For future evolution
  chain: any;  // Preprocessed operation chain
  metadata?: {
    caller: {
      type: 'LumenizeBase' | 'LumenizeWorker';
      bindingName?: string;            // From storage (__lmz_do_binding_name)
      instanceNameOrId?: string;       // From ctx.id (LumenizeBase only)
    };
    callee: {
      type: 'LumenizeBase' | 'LumenizeWorker';
      bindingName: string;             // Parameter to callRaw()
      instanceNameOrId?: string;       // Parameter to callRaw() (LumenizeBase only)
    };
  };
}
```

**Why both caller AND callee metadata?**
- **Caller metadata**: Tells callee "who called me" (for logging, callbacks)
- **Callee metadata**: Tells callee "my own identity" (auto-initialize if first call)
- **Key insight**: Caller always knows callee's full identity, but callee might not know its own!

**Type Detection**:
- Set `this.#lmzBaseType` in constructor
- `LumenizeBase` sets `'LumenizeBase'`
- `LumenizeWorker` sets `'LumenizeWorker'`

### callRaw() Implementation (Both Classes)

```typescript
// In LumenizeBase and LumenizeWorker
async callRaw(
  chain: OperationChain,
  calleeBindingName: string,
  calleeInstanceNameOrId?: string,
  options?: CallOptions
): Promise<any> {
  // 1. Gather caller metadata
  const callerBindingName = this.ctx.storage?.kv?.get('__lmz_do_binding_name') as string | undefined;
  const callerInstanceId = (this as any).ctx.id?.toString();
  
  // 2. Determine types based on context
  const calleeType = calleeInstanceNameOrId ? 'LumenizeBase' : 'LumenizeWorker';
  
  // 3. Build metadata
  const metadata = {
    caller: {
      type: this.#lmzBaseType,
      bindingName: callerBindingName,
      instanceNameOrId: callerInstanceId
    },
    callee: {
      type: calleeType,
      bindingName: calleeBindingName,
      instanceNameOrId: calleeInstanceNameOrId
    }
  };
  
  // 4. Preprocess operation chain
  const preprocessedChain = await preprocess(chain);
  
  // 5. Create versioned envelope
  const envelope = {
    version: 1,
    chain: preprocessedChain,
    metadata
  };
  
  // 6. Get stub based on callee type
  let stub: any;
  if (calleeType === 'LumenizeBase') {
    // DO: Use getDOStub from @lumenize/utils
    stub = getDOStub(this.env[calleeBindingName], calleeInstanceNameOrId!);
  } else {
    // Worker: Direct access to entrypoint
    stub = this.env[calleeBindingName];
  }
  
  // 7. Send to remote and return postprocessed result
  return await stub.__executeOperation(envelope);
}
```

**Key implementation details**:
- Parameter count determines callee type (2 params = Worker, 3 params = DO)
- Caller binding may be undefined (not an error - silently omit)
- Stub acquisition uses `getDOStub()` for DOs, direct env access for Workers
- Result is already postprocessed by receiver's `__executeOperation`

### __executeOperation() Receiver (Both Classes)

```typescript
// In LumenizeBase and LumenizeWorker
// Installed by installRpcHandlers() or similar
async __executeOperation(envelopeOrChain: any): Promise<any> {
  // 1. Detect format (envelope vs raw chain for backward compatibility)
  const isEnvelope = envelopeOrChain?.version === 1;
  
  const preprocessedChain = isEnvelope ? envelopeOrChain.chain : envelopeOrChain;
  const metadata = isEnvelope ? envelopeOrChain.metadata : undefined;
  
  // 2. Auto-initialize from callee metadata if present
  if (metadata?.callee) {
    this.__lmzInit({
      doBindingName: metadata.callee.bindingName,
      doInstanceNameOrId: metadata.callee.instanceNameOrId
    });
  }
  
  // 3. Postprocess and execute
  const operationChain = await postprocess(preprocessedChain);
  return await this.__executeChain(operationChain);
}
```

**Why callee metadata, not caller?**
- Callee metadata tells receiver "this is YOUR identity"
- Enables auto-initialization on first call
- Caller metadata available for logging/debugging but not used for initialization

### call() Implementation (LumenizeBase Only)

```typescript
// In LumenizeBase - synchronous wrapper around callRaw
call(
  calleeBindingName: string,
  calleeInstanceNameOrId: string,
  remoteOperation: Continuation<T>,
  handlerContinuation: Continuation<this>,
  options?: CallOptions
): void {
  // 1. Extract operation chains from continuations
  const remoteChain = getOperationChain(remoteOperation);
  const handlerChain = getOperationChain(handlerContinuation);
  
  if (!remoteChain) {
    throw new Error('Invalid remoteOperation: must be created with this.ctn()');
  }
  if (!handlerChain) {
    throw new Error('Invalid continuation: must be created with this.ctn()');
  }
  
  // 2. Validate caller knows its own binding (fail fast!)
  const callerBinding = this.ctx.storage.kv.get('__lmz_do_binding_name') as string | undefined;
  if (!callerBinding) {
    throw new Error(
      `Cannot use call() from a DO that doesn't know its own binding name. ` +
      `Call __lmzInit({ doBindingName }) in your constructor.`
    );
  }
  
  // 3. Use blockConcurrencyWhile for non-blocking async work
  this.ctx.blockConcurrencyWhile(async () => {
    try {
      // Call infrastructure layer
      const result = await this.callRaw(remoteChain, calleeBindingName, calleeInstanceNameOrId, options);
      
      // Substitute result into handler continuation
      const finalChain = replaceNestedOperationMarkers(handlerChain, result);
      
      // Execute handler locally
      await executeOperationChain(finalChain, this);
      
    } catch (error) {
      // Inject Error into handler continuation
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const finalChain = replaceNestedOperationMarkers(handlerChain, errorObj);
      
      // Execute handler with error
      await executeOperationChain(finalChain, this);
    }
  });
  
  // Returns immediately! Handler executes when result arrives
}
```

**Why not in LumenizeWorker?**
- Workers don't have `blockConcurrencyWhile`
- Workers use async/await naturally (just use `callRaw()` directly)

## Implementation Phases

### Phase 1: Add callRaw() to LumenizeBase

**Goal**: Implement `callRaw()` method in LumenizeBase with caller+callee metadata propagation.

**Success Criteria**:
- [ ] TypeScript interface for `CallEnvelope` (versioned, caller+callee metadata)
- [ ] `this.#lmzBaseType = 'LumenizeBase'` set in constructor
- [ ] `callRaw()` method implemented (async, public)
- [ ] Gathers caller metadata from storage
- [ ] Accepts callee metadata as parameters
- [ ] Determines callee type from parameter count
- [ ] Uses `getDOStub()` from @lumenize/utils
- [ ] Preprocesses chain, builds envelope, sends to remote
- [ ] Returns postprocessed result
- [ ] Unit tests for envelope structure
- [ ] Tests verify caller+callee metadata correct
- [ ] JSDoc with clear examples

**Package Location**: `@lumenize/lumenize-base/src/lumenize-base.ts`

**Why lumenize-base**: 
- Already has LumenizeBase class
- Will also add LumenizeWorker here (shared infrastructure)
- OCAN already lives here
- Natural home for RPC infrastructure

### Phase 2: Update __executeOperation Receiver

**Goal**: Modify `__executeOperation` in LumenizeBase to handle versioned envelopes and auto-initialize.

**Success Criteria**:
- [ ] Detects envelope `version: 1` vs. raw chain (backward compat)
- [ ] Extracts callee metadata from envelope
- [ ] Auto-calls `__lmzInit` with callee metadata before executing
- [ ] Backward compatible with old raw chain calls
- [ ] Tests verify callee metadata → `__lmzInit` flow
- [ ] Tests verify old calls still work
- [ ] Tests verify caller metadata available but not used for init

**Package**: `@lumenize/lumenize-base/src/lumenize-base.ts`

**Backward Compatibility**:
```typescript
// Old (still works - from packages/call)
await remoteDO.__executeOperation(preprocessedChain);

// New (metadata propagates - from callRaw)
await remoteDO.__executeOperation({ 
  version: 1, 
  chain: preprocessedChain, 
  metadata: { caller: {...}, callee: {...} }
});
```

### Phase 3: Refactor call() to use callRaw()

**Goal**: Simplify `call()` implementation to use `callRaw()` internally.

**Success Criteria**:
- [ ] Move `call()` from @lumenize/call to LumenizeBase
- [ ] Refactor to use `this.callRaw()` internally
- [ ] Keep same public API (continuations, no breaking changes)
- [ ] Remove manual stub acquisition
- [ ] Remove manual preprocessing
- [ ] Remove manual metadata handling
- [ ] All existing call tests pass unchanged
- [ ] Verify error handling still works

**Package**: `@lumenize/lumenize-base/src/lumenize-base.ts`

**Impact**: call() implementation shrinks from ~80 lines to ~40 lines

### Phase 4: Create LumenizeWorker Class

**Goal**: Create Worker Entrypoint base class with `callRaw()` but not `call()`.

**Success Criteria**:
- [ ] `LumenizeWorker` class created
- [ ] Extends `WorkerEntrypoint` from Cloudflare
- [ ] `this.#lmzBaseType = 'LumenizeWorker'` set in constructor
- [ ] `callRaw()` method (same signature as LumenizeBase)
- [ ] `__executeOperation()` receiver implemented
- [ ] `__lmzInit()` for storing binding name
- [ ] NADIS `svc` proxy (same as LumenizeBase)
- [ ] Tests for Worker→DO and Worker→Worker calls
- [ ] JSDoc with clear examples

**Package**: `@lumenize/lumenize-base/src/lumenize-worker.ts`

**Export**: Update `@lumenize/lumenize-base/src/index.ts` to export LumenizeWorker

### Phase 5: Delete @lumenize/call Package

**Goal**: Remove obsolete @lumenize/call package and migrate all code.

**Success Criteria**:
- [ ] Move remaining utilities (if any) to lumenize-base
- [ ] Delete `packages/call/` directory
- [ ] Update all imports across codebase
- [ ] Move tests to `packages/lumenize-base/test/call.test.ts`
- [ ] Move doc-tests to appropriate location
- [ ] All tests still pass
- [ ] No references to @lumenize/call remain

**Impact**: One less package to maintain, simpler architecture

### Phase 6: Refactor @lumenize/proxy-fetch

**Goal**: Use `callRaw` for all DO-to-DO communication in proxy-fetch.

**Success Criteria**:
- [ ] Update to use LumenizeBase (extends it or imports callRaw)
- [ ] `FetchOrchestrator` → Origin DO uses `callRaw`
- [ ] `FetchExecutor` → Origin DO uses `callRaw`
- [ ] Remove manual metadata handling
- [ ] All existing tests pass
- [ ] Verify metadata flows correctly in timeout scenarios

**Locations**:
- `workerFetchExecutor.ts` - Executor → Origin DO
- `FetchOrchestrator.ts` - Timeout errors → Origin DO

### Phase 7: Test Refactoring (Opportunistic)

**Goal**: Simplify tests by using `callRaw` instead of manual `__lmzInit` calls.

**Success Criteria**:
- [ ] Identify tests calling `__lmzInit` manually
- [ ] Replace with `callRaw` where it makes tests cleaner
- [ ] Document pattern for future test writers
- [ ] Tests become simpler and more maintainable

**Scope**: This is **opportunistic** - refactor tests as we touch them, not all at once.

**Locations** (examples):
- `packages/rpc/test/downstream-messaging.test.ts`
- `packages/rpc/test/test-worker-and-dos.ts`
- `doc-test/rpc/*` (various doc tests)

**Note**: Not all tests need refactoring. Some unit tests should continue testing `__lmzInit` directly.

## Design Decisions

### 1. Where should callRaw and call live?

**Decision**: `@lumenize/lumenize-base` as methods on LumenizeBase and LumenizeWorker classes

**Rationale**:
- Inheritance over composition (simpler, no foot-guns)
- OCAN already lives there
- Natural place for RPC infrastructure
- Both base classes can share code
- Users just extend one class and get everything

**Rejected alternatives**:
- Composition (separate utilities) - More complex, easier to misuse
- `@lumenize/core` - Needs access to base class internals
- `@lumenize/call` - Delete this package entirely

### 2. Should callRaw validate caller binding for DOs?

**Decision**: **No validation in callRaw, YES validation in call()**

**Rationale**:
- `callRaw()` is infrastructure - fail gracefully, send undefined if missing
- `call()` is application - fail fast with clear error message
- Tests can use `callRaw()` without initialization
- Application code using `call()` gets helpful error messages

**call() validation**:
```typescript
const callerBinding = this.ctx.storage.kv.get('__lmz_do_binding_name');
if (!callerBinding) {
  throw new Error('Call __lmzInit({ doBindingName }) in your constructor.');
}
```

### 3. Envelope format and metadata structure?

**Decision**: Versioned envelope with caller + callee metadata

```typescript
interface CallEnvelope {
  version: 1;  // REQUIRED - for evolution
  chain: any;  // Preprocessed operation chain
  metadata?: {
    caller: {
      type: 'LumenizeBase' | 'LumenizeWorker';
      bindingName?: string;            // From storage
      instanceNameOrId?: string;       // From ctx.id
    };
    callee: {
      type: 'LumenizeBase' | 'LumenizeWorker';
      bindingName: string;             // Always known by caller
      instanceNameOrId?: string;       // Known for DOs
    };
  };
}
```

**Rationale**:
- **Caller metadata**: For logging, debugging, future callbacks
- **Callee metadata**: For auto-initialization (receiver learns its own identity!)
- `version: 1` enables safe evolution
- Receiver checks `version: 1` to detect envelope vs. raw chain

**Key insight**: Caller always knows callee's full identity, but callee might not know its own!

**Future evolution examples**:
- Add `requestId` for distributed tracing
- Add `traceId` for observability
- Add `timeout` for deadline propagation
- Add `retryCount` for idempotency

### 4. How to detect caller and callee types?

**Decision**: 
- Caller type: Set `this.#lmzBaseType` in constructor
- Callee type: Infer from parameter count (3 params = DO, 2 params = Worker)

```typescript
// In constructor
this.#lmzBaseType = 'LumenizeBase' | 'LumenizeWorker';

// In callRaw()
const calleeType = calleeInstanceNameOrId ? 'LumenizeBase' : 'LumenizeWorker';
```

**Rationale**:
- Reliable, set once at construction
- Parameter count naturally indicates DO (has instance) vs Worker (no instance)
- Simple, no runtime type checks needed

### 5. Backward compatibility strategy?

**Decision**: Check for `version: 1` field

```typescript
const isEnvelope = envelopeOrChain?.version === 1;
```

**Rationale**:
- Explicit version check (not just "does it have chain?")
- Easy to support future versions (v2, v3, etc.)
- Old code sends raw chains (no version field)
- Clear, unambiguous detection

**Example**:
```typescript
// Old code (no changes needed - from packages/call)
await remoteDO.__executeOperation(preprocessedChain);

// New code (with metadata - from callRaw)
await remoteDO.__executeOperation({ 
  version: 1, 
  chain: preprocessedChain, 
  metadata: { caller: {...}, callee: {...} }
});
```

### 6. Should call() and callRaw() be in same class?

**Decision**: YES - both methods on base classes

**Rationale**:
- `call()` is sugar over `callRaw()` (just adds continuation pattern + blockConcurrencyWhile)
- Simpler for users (one class, two methods for different use cases)
- Clear layering: call() internally uses callRaw()
- LumenizeBase: both methods
- LumenizeWorker: only callRaw() (no blockConcurrencyWhile)

## Success Metrics

### Code Quality Improvements
1. **Consistency**: Single envelope format used by all RPC calls
2. **DRY**: Metadata logic in one place (`@lumenize/core`)
3. **Test coverage**: >90% branch coverage on `callRaw` and envelope handling
4. **Backward compatibility**: Zero breaking changes to existing code

### Developer Experience
1. **Boilerplate reduction**: ~5 lines → 1 line per RPC call
2. **Test simplification**: Tests stop manually calling `__lmzInit`
3. **Error messages**: Clear errors when envelope malformed
4. **Documentation**: JSDoc with examples for DO and Worker usage

### Evolvability
1. **Versioned envelope**: Can add fields without breaking existing code
2. **Type-safe**: TypeScript interfaces prevent mistakes
3. **Extensible metadata**: Easy to add `requestId`, `traceId`, etc. later
4. **Future-proof**: Supports Worker↔Worker, Worker↔DO, DO↔DO, DO↔Worker

### Observable Results
- [ ] All packages using RPC calls use `callRaw`
- [ ] Tests no longer manually call `__lmzInit` (except when testing `__lmzInit` itself)
- [ ] No manual envelope construction outside `@lumenize/core`
- [ ] Zero regressions in existing tests

## Design Constraints and Trade-offs

### What This Does NOT Do
1. **Error handling**: `callRaw` passes errors through, doesn't handle them
2. **Timeouts**: Caller's responsibility (e.g., `proxyFetch`)
3. **Retries**: Not in scope for this infrastructure
4. **Custom metadata**: Only auto-propagates standard fields
5. **Validation**: Light validation only (check `version`, don't validate chain)

### Accepted Trade-offs
1. **Detection fragility**: `caller.ctx?.storage?.kv` check is fragile but tested
2. **Worker limitations**: Workers can't be called back (by design)
3. **Missing DO binding**: Silently sends undefined (fail gracefully)
4. **No encryption**: Metadata sent in clear (trust internal RPC)

## Open Questions and Answers

### Q: Should we support custom metadata fields?
**A: No** - Keep it simple. Standard fields only for now. Future versions can add if needed.

### Q: Should callRaw handle timeouts?
**A: No** - That's the caller's responsibility. `proxyFetch` handles timeouts, `call` doesn't.

### Q: Should we validate the operation chain?
**A: No** - Trust the caller. Receiver validates during execution.

### Q: What if a DO hasn't called __lmzInit yet?
**A: Fine** - `callRaw` sends undefined binding, receiver handles gracefully.

### Q: Can Workers call Workers using callRaw?
**A: Yes** - Both send `originType: 'worker'`, neither has identity. Works fine.

### Q: Should we add requestId / traceId now?
**A: No** - Version 1 is minimal. Add in future version when we need distributed tracing.

## Risks and Mitigations

### Risk: Breaking existing code
**Mitigation**: Backward compatibility via version detection. Old calls work unchanged.

### Risk: Detection fails (fake ctx.storage.kv)
**Mitigation**: Comprehensive tests. Document expected structure.

### Risk: Circular dependencies (@lumenize/core importing from elsewhere)
**Mitigation**: `@lumenize/core` has NO dependencies. Pure infrastructure.

### Risk: Workers sending wrong metadata
**Mitigation**: Tests for all caller contexts. Clear JSDoc.

### Risk: Envelope format needs breaking changes
**Mitigation**: Versioning. Receiver checks `version` field.

## Package Changes Required

### @lumenize/lumenize-base (Major Updates)

**New files**:
- `src/lumenize-worker.ts` - LumenizeWorker class for Worker Entrypoints
- `src/types.ts` - `CallEnvelope` interface and RPC types
- `test/call.test.ts` - Tests migrated from @lumenize/call
- `test/call-raw.test.ts` - Tests for callRaw infrastructure
- `test/lumenize-worker.test.ts` - Tests for Worker class

**Updated files**:
- `src/lumenize-base.ts` - Add `callRaw()`, `call()`, `__executeOperation()` with envelope handling
- `src/index.ts` - Export LumenizeWorker and RPC types
- `package.json` - Dependencies already include @lumenize/structured-clone and @lumenize/utils

**Existing dependencies (already present)**:
- `@lumenize/structured-clone` (for preprocess/postprocess)
- `@lumenize/utils` (for getDOStub)

### @lumenize/call (Delete Entire Package)

**Actions**:
- Delete entire `packages/call/` directory
- Migrate tests to `packages/lumenize-base/test/`
- Migrate doc-tests to appropriate location
- Update all imports across codebase

**Files to migrate**:
- `test/call.test.ts` → `packages/lumenize-base/test/call.test.ts`
- `test/for-docs/` → TBD based on structure
- Delete: `src/call.ts`, `src/execute-operation-handler.ts`, `src/types.ts`, `src/index.ts`

### @lumenize/proxy-fetch

**Updated files**:
- `src/workerFetchExecutor.ts` - Use `this.callRaw()` (extend LumenizeBase)
- `src/FetchOrchestrator.ts` - Use `this.callRaw()` (extend LumenizeBase)
- Remove manual metadata handling code
- `package.json` - Remove `@lumenize/call` dependency (now use @lumenize/lumenize-base which is already a dep)

**No new dependencies needed** - Already depends on @lumenize/lumenize-base

### Tests affected (Phase 7 - Opportunistic)

**Will need updates**:
- `packages/rpc/test/downstream-messaging.test.ts` - Use callRaw instead of manual __lmzInit
- `packages/rpc/test/test-worker-and-dos.ts` - Use callRaw where appropriate
- `packages/proxy-fetch/test/` - Verify still works after refactor
- `doc-test/rpc/*` - Update any that used @lumenize/call

**Import changes**:
```typescript
// Old
import { call } from '@lumenize/call';

// New
import { LumenizeBase } from '@lumenize/lumenize-base';
// Use: this.call() or this.callRaw()
```

## Summary: What We're Building

### Two-Layer RPC System

**Layer 1: callRaw() - Infrastructure**
- Public async method on both LumenizeBase and LumenizeWorker
- Parameters: `(chain, calleeBindingName, calleeInstanceNameOrId?, options?)`
- Returns fully postprocessed result
- Builds envelope with caller + callee metadata
- Works for all combinations: DO↔DO, DO↔Worker, Worker↔DO, Worker↔Worker

**Layer 2: call() - Application Pattern**  
- Public synchronous method on LumenizeBase only
- Parameters: `(calleeBindingName, calleeInstanceNameOrId, remoteOperation, handlerContinuation, options?)`
- Uses blockConcurrencyWhile for non-blocking execution
- Continuation pattern: handler receives result or Error
- Internally uses callRaw()

### Key Benefits

1. **Consistency**: Single envelope format everywhere
2. **Auto-initialization**: Callees learn their identity automatically
3. **Simpler tests**: Use callRaw() without manual __lmzInit
4. **Worker support**: LumenizeWorker class with full RPC capabilities
5. **Clear layers**: Infrastructure (callRaw) vs Application (call)
6. **Evolvable**: Versioned envelope, easy to add fields
7. **Less boilerplate**: ~80 lines of call() shrinks to ~40

### Architecture Wins

- **Inheritance over composition**: Just extend LumenizeBase or LumenizeWorker
- **Delete @lumenize/call**: Consolidate into lumenize-base
- **Shared code**: Both classes use same envelope infrastructure
- **Type safety**: TypeScript interfaces prevent mistakes

## Next Steps

1. ✅ **Document reviewed and updated** with final architecture
2. **Get maintainer approval** on:
   - Two-layer system (call vs callRaw)
   - Inheritance approach (methods on base classes)
   - Deleting @lumenize/call package
   - Caller + callee metadata structure
3. **Proceed with Phase 1** (Add callRaw to LumenizeBase)

Ready to start implementation!

