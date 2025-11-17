# callRaw - Metadata Propagation Infrastructure

**Status**: Planning

## Objective

Create a reusable `callRaw` function that standardizes DO-to-DO RPC calls with automatic metadata propagation. This eliminates repetitive boilerplate in `@lumenize/call`, `@lumenize/proxy-fetch`, and future packages that need to call remote DOs.

## Problem

Current pattern requires 5+ lines of boilerplate for every DO-to-DO call:

```typescript
// Read metadata from storage
const originBinding = ctx.storage.kv.get('__lmz_do_binding_name') as string;
const originInstanceId = ctx.id.toString();

// Create envelope with metadata
const envelope = { 
  chain: await preprocess(chain), 
  originBinding, 
  originInstanceId 
};

// Send to remote DO
await remoteDO.__executeOperation(envelope);
```

**Missing piece**: Auto-propagation of caller metadata to remote DO (like HTTP headers do for first hop).

## Design Goals

1. **Single line for callers**: `await callRaw(this, remoteDO, chain)`
2. **Automatic metadata propagation**: Origin's `doBindingName` and `doInstanceNameOrId` travel with the call
3. **Automatic initialization**: Remote DO receives metadata and calls `__lmzInit` before executing
4. **Reusable across packages**: Works for `call`, `proxyFetch`, and any future DO-to-DO communication
5. **Type-safe envelope structure**: Clear contract between caller and receiver

## Architecture

### Caller Side (callRaw)

```typescript
// In @lumenize/core or @lumenize/call
export async function callRaw(
  originDO: DurableObject,
  remoteDO: any, // Target DO stub
  operationChain: OperationChain
): Promise<any> {
  const ctx = originDO.ctx as DurableObjectState;
  
  // 1. Read origin metadata from storage
  const originBinding = ctx.storage.kv.get('__lmz_do_binding_name') as string | undefined;
  const originInstanceId = ctx.id.toString();
  
  // 2. Preprocess operation chain
  const preprocessedChain = await preprocess(operationChain);
  
  // 3. Create envelope with metadata
  const envelope = {
    chain: preprocessedChain,
    metadata: {
      originBinding,
      originInstanceId
    }
  };
  
  // 4. Send to remote DO
  return await remoteDO.__executeOperation(envelope);
}
```

### Receiver Side (__executeOperation)

```typescript
// In @lumenize/call (execute-operation-handler.ts)
async function executeOperation(
  this: any,  // 'this' is the DO instance
  envelopeOrChain: any
): Promise<any> {
  // 1. Check if this is an envelope or raw chain (backward compatibility)
  const isEnvelope = envelopeOrChain && typeof envelopeOrChain === 'object' && 'chain' in envelopeOrChain;
  
  const preprocessedChain = isEnvelope ? envelopeOrChain.chain : envelopeOrChain;
  const metadata = isEnvelope ? envelopeOrChain.metadata : undefined;
  
  // 2. Auto-initialize from metadata if present
  if (metadata) {
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

## Phase 1: callRaw Implementation

**Goal**: Create and test `callRaw` function in `@lumenize/call` package.

**Success Criteria**:
- [ ] `callRaw` function created in `packages/call/src/call-raw.ts`
- [ ] Reads `doBindingName` and `doInstanceNameOrId` from storage
- [ ] Creates envelope with metadata
- [ ] Calls `__executeOperation` with envelope
- [ ] Unit tests verify envelope structure
- [ ] JSDoc with clear examples

**Open Questions**:
- Should `callRaw` be in `@lumenize/call` or `@lumenize/core`?
  - **Lean toward `@lumenize/call`** since it modifies `__executeOperation` behavior
- Should we validate `originBinding` exists (fail fast)?
  - **Yes** - throw clear error if missing, just like current `call()` does

## Phase 2: Update __executeOperation

**Goal**: Modify `__executeOperation` to handle envelope format and auto-initialize.

**Success Criteria**:
- [ ] `__executeOperation` detects envelope vs. raw chain
- [ ] Extracts metadata from envelope
- [ ] Calls `__lmzInit` with metadata before executing
- [ ] Backward compatible with raw chains (no metadata)
- [ ] Tests verify metadata propagation works
- [ ] Tests verify backward compatibility

**Backward Compatibility Strategy**:
```typescript
// Old calls (still work, no metadata propagation)
await remoteDO.__executeOperation(preprocessedChain);

// New calls (metadata propagates)
await remoteDO.__executeOperation({ chain: preprocessedChain, metadata: {...} });
```

## Phase 3: Refactor @lumenize/call

**Goal**: Replace manual envelope creation in `call()` with `callRaw`.

**Success Criteria**:
- [ ] `call.ts` imports and uses `callRaw`
- [ ] Remove manual metadata reading and envelope creation
- [ ] All existing tests pass
- [ ] No behavior changes (just cleaner code)

**Before**:
```typescript
// In call()
const originBinding = ctx.storage.kv.get('__lmz_do_binding_name');
const preprocessed = await preprocess(remoteChain);
const result = await remoteStub.__executeOperation(preprocessed);
```

**After**:
```typescript
// In call()
const result = await callRaw(doInstance, remoteStub, remoteChain);
```

## Phase 4: Refactor @lumenize/proxy-fetch

**Goal**: Use `callRaw` for all DO-to-DO calls in proxy-fetch.

**Success Criteria**:
- [ ] FetchOrchestrator → Origin DO uses `callRaw`
- [ ] FetchExecutor → Origin DO uses `callRaw`
- [ ] Remove manual metadata handling
- [ ] All existing tests pass
- [ ] Verify metadata propagates correctly

**Locations to update**:
1. `workerFetchExecutor.ts` - Executor calling back to Origin DO
2. `FetchOrchestrator.ts` - Orchestrator sending timeout errors to Origin DO

## Phase 5: Documentation

**Goal**: Document `callRaw` as internal infrastructure pattern.

**Success Criteria**:
- [ ] JSDoc on `callRaw` function
- [ ] JSDoc on envelope format
- [ ] Comment in `__executeOperation` explaining auto-init
- [ ] Update `@lumenize/call` README if needed (minimal, it's internal)

**Note**: This is internal infrastructure, not user-facing API. Users continue to use `call()` and `proxyFetch()` - they don't call `callRaw` directly.

## Design Decisions

### 1. Where should callRaw live?

**Options**:
- A. `@lumenize/core` - Most reusable, shared by all packages
- B. `@lumenize/call` - Co-located with `__executeOperation` modification
- C. `@lumenize/lumenize-base` - Available to all DOs automatically

**Decision**: **B - `@lumenize/call`** because:
- Modifies `__executeOperation` behavior (envelope format)
- `@lumenize/call` already required by packages that need this
- Keeps the pattern cohesive (envelope sender + receiver in same package)

### 2. Should callRaw validate originBinding?

**Yes** - Throw clear error if missing, matching current `call()` behavior:
```typescript
if (!originBinding) {
  throw new Error(
    `Cannot use callRaw() from a DO that doesn't know its own binding name. ` +
    `Call __lmzInit({ doBindingName }) in your DO constructor.`
  );
}
```

### 3. Envelope format?

**Proposed**:
```typescript
interface CallEnvelope {
  chain: any;  // Preprocessed operation chain
  metadata?: {
    originBinding?: string;
    originInstanceId?: string;
  };
}
```

**Why optional metadata?**
- Backward compatibility
- Some calls might not need/have metadata (edge cases)

### 4. What about originInstanceName vs originInstanceId?

**Use ID only** for now:
- Always available via `ctx.id.toString()`
- Name is rarely known (only when explicitly set via `__lmzInit`)
- Receiver can call `__lmzInit({ doInstanceNameOrId })` with ID (it validates and skips storage)

## Success Metrics

1. **Lines of code saved**: ~4 lines per DO-to-DO call
2. **Consistency**: All DO-to-DO calls use same pattern
3. **Test coverage**: >90% on `callRaw` and envelope handling
4. **Backward compatibility**: No breaking changes to existing code

## Open Questions

1. Should we support passing custom metadata?
   - **Lean no** - keep it simple, just auto-propagate what we know
2. Should callRaw handle errors/timeouts?
   - **No** - that's caller's responsibility (call, proxyFetch, etc.)
3. Should we validate the envelope format?
   - **Light validation** - check for `chain` property, warn if malformed

## Next Steps

1. Create Phase 1 implementation (callRaw function)
2. Write comprehensive tests for envelope structure
3. Get maintainer approval on API design
4. Proceed with Phase 2 (__executeOperation update)

