# Refactor Proxy-Fetch to Use Operation Chain Pattern

**Status**: Phase 1
**Type**: Implementation-First (internal refactoring)

## Objective

Replace proxy-fetch's manual `preprocess`/`__receiveResult` pattern with the proven operation chain + `__executeOperation` pattern from call.ts.

## Current Architecture (Manual Pattern)

```
Origin DO:
1. Store continuation in storage
2. Send message (without continuation) to orchestrator
3. Wait for __receiveResult callback

Orchestrator:
1. Queue message
2. Dispatch to executor via RPC

Executor:
1. Fetch external API
2. Manually preprocess result
3. Call origin.__receiveResult(workType, reqId, preprocessedResult)

Origin DO (__receiveResult):
1. Retrieve stored continuation from storage
2. Postprocess result
3. Execute continuation
```

**Problems:**
- Origin stores state (continuation in storage)
- Manual preprocess creates double-preprocessing footgun
- More complex (storage, idempotency)

## New Architecture (Operation Chain Pattern)

```
Origin DO:
1. Create continuation
2. Send to orchestrator WITH continuation

Orchestrator:
1. Queue message (with continuation)
2. Dispatch to executor via RPC (with continuation)

Executor:
1. Fetch external API
2. Fill continuation with result (raw data)
3. Preprocess chain once
4. Call origin.__executeOperation(preprocessedChain)

Origin DO (__executeOperation):
1. Postprocess chain
2. Execute chain
```

**Benefits:**
- ✅ Simpler (no origin storage)
- ✅ Safer (no double-preprocessing footgun)
- ✅ Fewer states to manage
- ✅ Continuation travels through pipeline

## Implementation Phases

### Phase 1: Update Type Definitions
**Goal**: Add continuation field to message types

**Files**:
- `packages/proxy-fetch/src/types.ts`

**Changes**:
- Add `continuation: any` to `FetchOrchestratorMessage`
- Add `continuation: any` to `WorkerFetchMessage`

**Success**: Types compile, no test changes yet

---

### Phase 2: Update Origin → Orchestrator
**Goal**: Pass continuation instead of storing it

**Files**:
- `packages/proxy-fetch/src/proxyFetch.ts`

**Changes**:
- Remove storage of continuation (lines 130-137)
- Add continuation to message (line 142)
- Keep request preprocessing (still needed)

**Success**: Origin passes continuation in message

---

### Phase 3: Update Orchestrator → Executor
**Goal**: Pass continuation through

**Files**:
- `packages/proxy-fetch/src/FetchOrchestrator.ts`

**Changes**:
- Pass continuation from incoming message to worker message
- No other logic changes

**Success**: Orchestrator forwards continuation

---

### Phase 4: Update Executor → Origin
**Goal**: Use operation chain pattern

**Files**:
- `packages/proxy-fetch/src/workerFetchExecutor.ts`

**Changes**:
- Import `preprocess` from `@lumenize/structured-clone`
- Fill continuation with result: `message.continuation.handleResult(responseSync)`
- Preprocess chain once
- Call `origin.__executeOperation(preprocessedChain)`
- Remove manual `preprocess` of result

**Success**: Executor uses operation chain pattern

---

### Phase 5: Test Incrementally
**Goal**: Verify each change works

**Approach**:
1. Run tests after Phase 2 (should fail - orchestrator not updated)
2. Run tests after Phase 3 (should fail - executor not updated)
3. Run tests after Phase 4 (should pass - complete refactor)

**Success**: All proxy-fetch tests pass

---

### Phase 6: Cleanup
**Goal**: Remove unused code

**Files**:
- `packages/proxy-fetch/src/fetchWorkerResultHandler.ts` (if unused)

**Success**: No dead code, all tests pass

## Notes

- This is internal refactoring - no breaking changes to public API
- Test carefully - changes touch 4+ files
- Pattern proven by call.ts (lines 110-114) and its passing tests

