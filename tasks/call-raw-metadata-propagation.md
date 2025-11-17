# callRaw - RPC Call Infrastructure with Metadata Propagation

**Status**: Planning

## Objective

Create infrastructure for **consistent, high-quality RPC calls** across all Lumenize packages. `callRaw` standardizes DO-to-DO, Worker-to-DO, DO-to-Worker, and Worker-to-Worker calls with automatic metadata propagation where available.

**Primary Goals** (in priority order):
1. **Consistency**: All RPC calls use the same pattern and envelope format
2. **Quality**: Proper metadata handling, error detection, and evolvability
3. **DRY**: Single source of truth for envelope format and metadata propagation
4. **Evolvability**: Adding new metadata fields happens in one place
5. **Simplicity**: Eliminate boilerplate (5+ lines → 1 line per call)

## Problem

**Current state**:
- Manual envelope creation in multiple packages (`@lumenize/call`, `@lumenize/proxy-fetch`)
- Inconsistent metadata propagation patterns
- Tests manually calling `__lmzInit` 
- No support for Worker ↔ Worker or Worker ↔ DO calls
- Hard to evolve (adding metadata field requires changes in N places)

**Example boilerplate** (repeated everywhere):
```typescript
const originBinding = ctx.storage.kv.get('__lmz_do_binding_name') as string;
const originInstanceId = ctx.id.toString();
const envelope = { 
  chain: await preprocess(chain), 
  originBinding, 
  originInstanceId 
};
await remoteDO.__executeOperation(envelope);
```

## Design Goals

1. **Single line for callers**: `await callRaw(this, remoteDO, chain)`
2. **Works from DOs AND Workers**: Detect caller context, send what we know
3. **Works to DOs AND Workers**: Receivers handle envelope consistently
4. **Automatic metadata propagation**: Origin identity travels with the call (when available)
5. **Automatic initialization**: Remote DO receives metadata and calls `__lmzInit` before executing
6. **Composition-based**: Both senders and receivers use composable helpers
7. **Type-safe envelope structure**: Versioned, evolvable contract
8. **Test simplification**: Tests stop manually calling `__lmzInit`

## Architecture

### Core Concepts

**Envelope Format** (versioned for evolution):
```typescript
interface CallEnvelope {
  version: 1;  // For future evolution
  chain: any;  // Preprocessed operation chain
  metadata?: {
    originType?: 'do' | 'worker';      // Where call originated
    originBinding?: string;             // DO binding name (DO only)
    originInstanceId?: string;          // DO instance ID (DO only)
    // Future: requestId, traceId, etc.
  };
}
```

**Caller Context Detection**:
- **Durable Object**: Has `this.ctx.storage.kv` - read binding from storage, get ID from `ctx.id`
- **Worker**: No `this.ctx.storage` (or exists but no `kv`) - send `originType: 'worker'` only
- **Test (vitest-pool-workers)**: Treated as Worker - no identity needed

### Caller Side (callRaw)

```typescript
// In @lumenize/core (low-level, no dependencies)
export async function callRaw(
  caller: any,  // 'this' from DO or Worker
  remoteTarget: any,  // Target DO/Worker stub
  operationChain: OperationChain
): Promise<any> {
  // 1. Detect caller context and gather metadata
  const metadata: CallEnvelope['metadata'] = {};
  
  // Try to read DO metadata (fails silently for Workers)
  if (caller.ctx?.storage?.kv) {
    // This is a DO - gather identity
    metadata.originType = 'do';
    metadata.originBinding = caller.ctx.storage.kv.get('__lmz_do_binding_name') as string | undefined;
    metadata.originInstanceId = caller.ctx.id?.toString();
  } else {
    // This is a Worker or test - no persistent identity
    metadata.originType = 'worker';
  }
  
  // 2. Preprocess operation chain
  const preprocessedChain = await preprocess(operationChain);
  
  // 3. Create versioned envelope
  const envelope: CallEnvelope = {
    version: 1,
    chain: preprocessedChain,
    metadata
  };
  
  // 4. Send to remote target
  return await remoteTarget.__executeOperation(envelope);
}
```

### Receiver Side (DO)

```typescript
// In @lumenize/call (execute-operation-handler.ts)
// This is installed by installRpcHandlers() on DO classes
async function executeOperation(
  this: any,  // 'this' is the DO instance
  envelopeOrChain: any
): Promise<any> {
  // 1. Detect format (envelope vs raw chain for backward compatibility)
  const isEnvelope = envelopeOrChain?.version === 1;
  
  const preprocessedChain = isEnvelope ? envelopeOrChain.chain : envelopeOrChain;
  const metadata = isEnvelope ? envelopeOrChain.metadata : undefined;
  
  // 2. Auto-initialize from metadata if present
  if (metadata?.originBinding || metadata?.originInstanceId) {
    this.__lmzInit({
      doBindingName: metadata.originBinding,
      doInstanceNameOrId: metadata.originInstanceId
    });
  }
  
  // 3. Postprocess and execute
  const operationChain: OperationChain = await postprocess(preprocessedChain);
  return await this.__executeChain(operationChain);
}
```

### Receiver Side (Worker)

```typescript
// In @lumenize/core or @lumenize/worker-utils
// Pattern for Workers to handle callRaw envelopes
export function handleRpcEnvelope(
  envelopeOrChain: any,
  handler: (chain: OperationChain, metadata?: any) => Promise<any>
): Promise<any> {
  const isEnvelope = envelopeOrChain?.version === 1;
  
  const preprocessedChain = isEnvelope ? envelopeOrChain.chain : envelopeOrChain;
  const metadata = isEnvelope ? envelopeOrChain.metadata : undefined;
  
  // Postprocess and execute via user's handler
  const operationChain = postprocess(preprocessedChain);
  return handler(operationChain, metadata);
}

// Usage in Worker fetch handler:
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const envelope = await request.json();
    const result = await handleRpcEnvelope(envelope, async (chain, metadata) => {
      // User's logic here - metadata available if needed
      return executeChain(chain);
    });
    return Response.json(result);
  }
}
```

## Implementation Phases

### Phase 1: Core Infrastructure (callRaw + Envelope Types)

**Goal**: Create `callRaw` in `@lumenize/core` with DO and Worker context detection.

**Success Criteria**:
- [ ] TypeScript interface for `CallEnvelope` (versioned)
- [ ] `callRaw()` function with context detection logic
- [ ] Handles both DO and Worker callers gracefully
- [ ] Unit tests for envelope structure in both contexts
- [ ] Tests verify metadata populated correctly for DOs
- [ ] Tests verify metadata minimal for Workers
- [ ] JSDoc with examples for both DO and Worker usage

**Package Location**: `@lumenize/core` (low-level, no dependencies on call/proxy-fetch)

**Why `@lumenize/core`**: 
- Both `@lumenize/call` and `@lumenize/proxy-fetch` need it
- Workers need it (won't depend on `@lumenize/call`)
- Future packages will need it
- Keeps envelope format centralized

### Phase 2: Update __executeOperation in DOs

**Goal**: Modify `__executeOperation` to handle versioned envelopes and auto-initialize.

**Success Criteria**:
- [ ] Detects envelope `version: 1` vs. raw chain (backward compat)
- [ ] Extracts metadata from envelope
- [ ] Auto-calls `__lmzInit` with metadata before executing
- [ ] Backward compatible with old raw chain calls
- [ ] Tests verify metadata → `__lmzInit` flow
- [ ] Tests verify old calls still work
- [ ] Tests with Worker→DO calls (no DO identity in metadata)

**Package**: `@lumenize/call` (modify `execute-operation-handler.ts`)

**Backward Compatibility**:
```typescript
// Old (still works)
await remoteDO.__executeOperation(preprocessedChain);

// New (metadata propagates)
await remoteDO.__executeOperation({ version: 1, chain: preprocessedChain, metadata: {...} });
```

### Phase 3: Worker RPC Handler Composition

**Goal**: Create `handleRpcEnvelope` helper for Workers to receive callRaw calls.

**Success Criteria**:
- [ ] `handleRpcEnvelope()` function extracts chain and metadata
- [ ] Works with versioned envelopes
- [ ] Backward compatible with raw chains
- [ ] Example Worker fetch handler using it
- [ ] Tests demonstrating Worker→Worker calls
- [ ] JSDoc with clear usage pattern

**Package**: `@lumenize/core` (same as callRaw)

### Phase 4: Refactor @lumenize/call

**Goal**: Replace manual envelope creation in `call()` with `callRaw`.

**Success Criteria**:
- [ ] `call.ts` imports `callRaw` from `@lumenize/core`
- [ ] Remove manual `storage.kv.get('__lmz_do_binding_name')` code
- [ ] Remove manual envelope construction
- [ ] All existing tests pass unchanged
- [ ] Verify no behavior changes

**Impact**: ~10-15 lines removed from call implementation

### Phase 5: Refactor @lumenize/proxy-fetch

**Goal**: Use `callRaw` for all DO-to-DO communication in proxy-fetch.

**Success Criteria**:
- [ ] `FetchOrchestrator` → Origin DO uses `callRaw`
- [ ] `FetchExecutor` → Origin DO uses `callRaw`
- [ ] Remove manual metadata reading
- [ ] All existing tests pass
- [ ] Verify metadata flows correctly in timeout scenarios

**Locations**:
- `workerFetchExecutor.ts` - Executor → Origin DO
- `FetchOrchestrator.ts` - Timeout errors → Origin DO

### Phase 6: Test Refactoring (Opportunistic)

**Goal**: Refactor tests to use `callRaw` instead of manual `__lmzInit` calls.

**Success Criteria**:
- [ ] Identify tests calling `__lmzInit` manually
- [ ] Replace with `callRaw` where applicable
- [ ] Document pattern for future test writers
- [ ] Tests become simpler and more maintainable

**Scope**: This is **opportunistic** - refactor tests as we touch them, not all at once.

**Locations** (examples):
- `packages/rpc/test/downstream-messaging.test.ts`
- `packages/rpc/test/test-worker-and-dos.ts`
- Any doc-test projects using Workers

**Note**: Not all tests need refactoring. Some unit tests should continue testing `__lmzInit` directly.

## Design Decisions

### 1. Where should callRaw live?

**Decision**: `@lumenize/core`

**Rationale**:
- Both `@lumenize/call` and `@lumenize/proxy-fetch` need it
- Workers need it (won't depend on `@lumenize/call`)
- Centralizes envelope format for entire ecosystem
- Low-level infrastructure with no dependencies
- Future packages (rate-limiting, metrics) will need it

**Rejected alternatives**:
- `@lumenize/call` - Creates circular dependency for Workers
- `@lumenize/lumenize-base` - Too high-level, not all callers are DOs

### 2. Should callRaw validate originBinding for DOs?

**Decision**: **No validation** - fail silently and send undefined

**Rationale**:
- DOs might not have initialized yet (first call)
- Receiver can handle missing metadata gracefully
- Aligns with "fail silently" approach for Workers
- Testing is easier (no need to initialize every test DO)

**Alternative considered**: Throw error if binding missing → Rejected because:
- Too strict for tests and development
- Breaks the "just works" philosophy
- Receiver already handles undefined metadata

### 3. Envelope format and versioning?

**Decision**: Versioned envelope with `version: 1`

```typescript
interface CallEnvelope {
  version: 1;  // REQUIRED - for evolution
  chain: any;  // Preprocessed operation chain
  metadata?: {
    originType?: 'do' | 'worker';   // NEW - caller type
    originBinding?: string;          // DO only
    originInstanceId?: string;       // DO only
  };
}
```

**Rationale**:
- `version` enables safe evolution (add fields, change structure)
- `originType` makes debugging easier (know what called you)
- Optional metadata supports Workers (no identity) and backward compat
- Receiver checks `version: 1` to detect envelope vs. raw chain

**Future evolution examples**:
- Add `requestId` for distributed tracing
- Add `traceId` for observability
- Add `timeout` for deadline propagation
- Add `retryCount` for idempotency

### 4. How to detect DO vs Worker context?

**Decision**: Check for `caller.ctx?.storage?.kv`

```typescript
if (caller.ctx?.storage?.kv) {
  // This is a DO
  metadata.originType = 'do';
  metadata.originBinding = caller.ctx.storage.kv.get('__lmz_do_binding_name');
  metadata.originInstanceId = caller.ctx.id?.toString();
} else {
  // This is a Worker or test
  metadata.originType = 'worker';
}
```

**Rationale**:
- DOs always have `ctx.storage.kv` (synchronous storage)
- Workers never have `ctx.storage.kv`
- Tests (vitest-pool-workers) act like Workers
- Simple, works reliably

**Trade-offs**:
- ⚠️ Fragile if someone adds fake `kv` property
- ✅ But unlikely in practice
- ✅ Well-tested behavior
- ✅ No need for explicit context parameter

### 5. What metadata should Workers send?

**Decision**: Just `originType: 'worker'` - no binding or instance ID

**Rationale**:
- Workers are ephemeral (no persistent identity)
- Can't call back to specific Worker instance
- Receiver doesn't need Worker identity (nothing to do with it)
- Keeps metadata simple and honest

**Why not more**:
- Worker request URL? Receiver can't call it back
- Worker name? Not meaningful (load balanced)
- Worker trace ID? Future addition, not now

### 6. Backward compatibility strategy?

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
// Old code (no changes needed)
await remoteDO.__executeOperation(preprocessedChain);

// New code (with metadata)
await remoteDO.__executeOperation({ 
  version: 1, 
  chain: preprocessedChain, 
  metadata: {...} 
});
```

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

### @lumenize/core

**New files**:
- `src/rpc/call-raw.ts` - Core `callRaw()` implementation
- `src/rpc/types.ts` - `CallEnvelope` interface and related types
- `src/rpc/handle-rpc-envelope.ts` - Worker receiver helper
- `src/rpc/index.ts` - Public exports
- `test/rpc/` - Tests for all RPC infrastructure

**Updated files**:
- `src/index.ts` - Add `export * from './rpc/index.js'`
- `package.json` - Update description to mention Workers support

**Dependencies**: 
- `@lumenize/structured-clone` (for `preprocess()`)
- Already has no other dependencies (good!)

**Note**: Currently described as "for Durable Objects" but will now support Workers too.

### @lumenize/call

**Updated files**:
- `src/execute-operation-handler.ts` - Handle versioned envelopes
- `src/call.ts` - Use `callRaw` from `@lumenize/core`
- `package.json` - Add `@lumenize/core` dependency

**Dependencies added**:
- `@lumenize/core` (for `callRaw`)

### @lumenize/proxy-fetch

**Updated files**:
- `src/workerFetchExecutor.ts` - Use `callRaw` for Origin DO callbacks
- `src/FetchOrchestrator.ts` - Use `callRaw` for timeout errors
- `package.json` - Add `@lumenize/core` dependency

**Dependencies added**:
- `@lumenize/core` (for `callRaw`)

### Tests affected

**Will need updates** (opportunistic, Phase 6):
- `packages/rpc/test/downstream-messaging.test.ts`
- `packages/rpc/test/test-worker-and-dos.ts`
- `packages/call/test/call.test.ts` (verify still works)
- `packages/proxy-fetch/test/` (all tests)
- `doc-test/rpc/*` (various doc tests using Workers)

## Questions for Maintainer

1. **Package location confirmed?** `@lumenize/core` feels right, but want explicit approval.
2. **@lumenize/core description update?** Currently says "for Durable Objects" - should we say "for Workers and Durable Objects"?
3. **Should we create @lumenize/rpc as a separate package?** Instead of `@lumenize/core/rpc`?
   - **Recommendation**: Keep in `@lumenize/core` - it's low-level infrastructure, not a high-level feature.
4. **Validation strictness?** Should we validate envelope structure or just trust callers?
   - **Recommendation**: Light validation (check `version` exists), trust the rest.
5. **Phase 6 scope?** Should test refactoring be part of this task or separate follow-up?
   - **Recommendation**: Opportunistic within this task - refactor as we touch files.

## Next Steps

1. ✅ **Review this document** with maintainer  
2. **Answer maintainer questions** (see above)
3. **Get approval** on architecture and phases
4. **Proceed with Phase 1** (Core Infrastructure)

Ready to proceed?

