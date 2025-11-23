# Sync Structured Clone

**Status**: Not Started
**Type**: Implementation-First (Internal Refactoring)

## Objective

Make `preprocess()` and `stringify()` synchronous by requiring `RequestSync`/`ResponseSync` instead of native `Request`/`Response` objects. This eliminates async/await from the core serialization path, enabling pure synchronous APIs throughout Lumenize.

## Goal

Enable pure synchronous user-facing APIs across all Lumenize packages by removing the last async dependency in the serialization layer.

## Architectural Rationale

**Current Problem**:
- `preprocess/stringify` are async because they must `await request.arrayBuffer()` to read Request/Response bodies
- This forces **everything** that uses structured-clone to be async
- Violates Lumenize design principle: "users work in pure sync, never deal with Promises/awaits"

**Solution**:
- Require `RequestSync`/`ResponseSync` (which already have bodies deserialized)
- `preprocess/stringify` become synchronous (no await needed)
- Async only at system boundaries (Worker fetch handler, external API responses)

**Pattern**:
```typescript
// At system boundary (async)
async fetch(request: Request) {
  const requestSync = await RequestSync.fromRequest(request);
  // All internal code is now sync
  this.handleRequest(requestSync);
}

// Internal code (sync)
handleRequest(request: RequestSync) {
  // No awaits needed!
  const serialized = stringify({ request, data: {...} });
}
```

## Design Decision: Throw vs. Silent

**Decision**: **THROW** when encountering native `Request`/`Response`

**Rationale**:
- ✅ Fail fast - catches issues immediately
- ✅ Clear error message guides developer to fix
- ✅ No silent performance degradation
- ✅ Enforces architectural discipline

**Error Message**:
```
Error: Cannot serialize native Request object. Use RequestSync instead.
  const requestSync = await RequestSync.fromRequest(request);
```

## Affected Packages

All packages that import from `@lumenize/structured-clone`:
- `@lumenize/rpc` - Uses Request/Response in RPC layer
- `@lumenize/proxy-fetch` - Uses ResponseSync already
- `@lumenize/lumenize-base` - OCAN serialization
- `@lumenize/alarms` - Continuation serialization
- `@lumenize/actors` - (if it uses structured-clone)
- `@lumenize/utils` - (if it uses structured-clone)
- Any other packages using `stringify/preprocess`

## Breaking Changes

1. **RPC Layer**: Remove support for sending native Request/Response objects
   - Update tests that use Request/Response
   - Update docs showing Request/Response examples
   - Document migration: use RequestSync/ResponseSync

2. **All Packages**: Remove `await` from `stringify/preprocess` calls
   - Remove `async` from functions that only needed it for serialization
   - Update tests to remove unnecessary awaits

## Phase 1: Make preprocess/stringify Synchronous ✅ COMPLETE

**Goal**: Change function signatures and throw on Request/Response

**Changes**:
1. Change `preprocess()`: `async function` → `function` (remove async)
2. Change `stringify()`: `async function` → `function` (remove async)
3. Add runtime checks:
   ```typescript
   if (value instanceof Request) {
     throw new Error(
       'Cannot serialize native Request object. Use RequestSync instead:\n' +
       '  const requestSync = await RequestSync.fromRequest(request);'
     );
   }
   if (value instanceof Response) {
     throw new Error(
       'Cannot serialize native Response object. Use ResponseSync instead:\n' +
       '  const responseSync = await ResponseSync.fromResponse(response);'
     );
   }
   ```
4. Keep `RequestSync`/`ResponseSync` handling (already synchronous)
5. Update type signatures to remove `Promise<>`

**Success Criteria**:
- ✅ `preprocess()` signature: `function preprocess(data: any): LmzIntermediate`
- ✅ `stringify()` signature: `function stringify(value: any): string`
- ✅ Throws helpful error on native Request/Response
- ✅ All structured-clone tests pass (after removing awaits from tests)
- ✅ Document how many other test suites break (for planning Phase 2)

**Expected Impact**: ~50% of test suites will break initially

**Actual Impact** (Phase 1 Complete):
- ✅ **@lumenize/structured-clone**: All 728 tests pass (removed Request/Response tests)
- ✅ **@lumenize/testing**: All 18 tests pass (no changes needed)
- ✅ **@lumenize/utils**: All 250 tests pass (no changes needed)
- ❌ **@lumenize/rpc**: 24 tests failed (all Request/Response in test/matrix.test.ts)
- ❌ **@lumenize/proxy-fetch**: 1 test failed (Request object test)

**Summary**: Only 2 packages affected (rpc, proxy-fetch) with 25 total failing tests

## Phase 2: Fix @lumenize/rpc ✅ COMPLETE

**Goal**: Remove Request/Response support, update to sync API

**Changes**:
1. Remove `await` from all `stringify/preprocess` calls
2. Remove `async` from functions that only needed it for serialization
3. Remove test cases using native Request/Response
4. Update docs: remove Request/Response examples
5. Document migration pattern for users

**Success Criteria**:
- ✅ All RPC tests pass
- ✅ No Request/Response in test fixtures
- ✅ Docs updated with RequestSync/ResponseSync patterns
- ✅ Package is fully synchronous where possible

**Why This First**: RPC is relatively independent - doesn't depend on call/callRaw from lumenize-base

## Phase 3: Fix @lumenize/lumenize-base (call/callRaw) ✅ COMPLETE

**Goal**: Make call/callRaw synchronous - this is the foundation for other packages

**Changes**:
1. Remove `await` from `stringify/preprocess` in OCAN code
2. Update continuation serialization to be sync
3. Make `call()` fully synchronous (no blockConcurrencyWhile wrapper needed)
4. Keep `callRaw()` async (goes over the wire)
5. Remove `async` from functions that only needed it for serialization

**Success Criteria**:
- ✅ All lumenize-base tests pass
- ✅ OCAN serialization is synchronous
- ✅ `call()` is synchronous
- ✅ Continuation creation/execution is synchronous

**Why This Before proxy-fetch**: proxy-fetch uses `call/callRaw` from lumenize-base

## Phase 4: Fix @lumenize/alarms ✅ COMPLETE

**Goal**: Remove unnecessary awaits from continuation serialization

**Changes**:
1. Remove `await` from `stringify/preprocess` calls
2. Remove `async` from alarm scheduling if only needed for serialization

**Success Criteria**:
- ✅ All alarms tests pass
- ✅ Alarm scheduling remains synchronous (already is, just verify)

**Why This Before proxy-fetch**: proxy-fetch uses alarms for timeout handling

## Phase 5: Fix @lumenize/proxy-fetch ✅ COMPLETE

**Goal**: Remove unnecessary awaits, make fully synchronous

**Changes**:
1. Remove `await` from `stringify(continuationChain)` 
2. Make `proxyFetch()` synchronous (returns `string` not `Promise<string>`)
3. Update tests to remove awaits
4. Update NADIS registration to return sync function

**Success Criteria**:
- ✅ `proxyFetch()` is synchronous
- ✅ All tests pass
- ✅ Can be called from non-async contexts

**Dependencies**: Requires Phase 3 (lumenize-base) AND Phase 4 (alarms) to be complete

## Phase 6+: Fix Remaining Packages

**Goal**: Fix any other packages using structured-clone

**Process**: Same pattern as above
1. Identify package
2. Remove awaits
3. Update tests
4. Verify

## Testing Strategy

**For Each Phase**:
1. Make changes
2. Run package tests
3. If tests pass → move to next package
4. If tests fail → fix issues, verify test coverage caught the problem

**Confidence**: 90% test coverage throughout means we can trust the tests to catch issues

## Success Metrics

**When Complete**:
- ✅ `preprocess/stringify` are synchronous functions
- ✅ All package tests pass
- ✅ RPC docs updated (no Request/Response examples)
- ✅ proxyFetch is synchronous
- ✅ Pure sync APIs throughout Lumenize
- ✅ No more "doom loop refactorings" trying to make things sync

## Phase 6+: Additional packages ✅ COMPLETE

**What we checked:**
- ✅ `@lumenize/utils` - No changes needed (no stringify/preprocess usage)
- ✅ `@lumenize/testing` - No changes needed (inherits from RPC)
- ✅ Doc-tests - Removed Request/Response test from capn-web-comparison

---

# 🎉 ALL PHASES COMPLETE!

**Final Test Results:**
- ✅ All test files passing across all packages
- ✅ 40+ test files total, hundreds of tests

**Summary of Changes:**
1. **structured-clone** - Made `stringify/preprocess` synchronous, removed native Request/Response support
2. **rpc** - Removed await from serialization calls, removed Request/Response tests
3. **lumenize-base** - Removed await from continuation serialization  
4. **alarms** - Removed await from operation chain serialization
5. **proxy-fetch** - Removed await, deleted Request object test
6. **testing** - No changes needed (inherits from RPC)
7. **doc-tests** - Removed outdated Request/Response examples

**Design Decision Fulfilled:**
Native Request/Response objects now throw clear errors directing users to RequestSync/ResponseSync.

## Notes

- ✅ Started Phase 1 Saturday (not Monday!)
- ✅ Ran all tests after each phase
- ✅ Fixed packages in correct dependency order
- ✅ Test coverage was our safety net and it worked perfectly

## References

- Current sync implementations: `RequestSync`, `ResponseSync`
- Web API encoding: `/packages/structured-clone/src/web-api-encoding.ts`
- Preprocess logic: `/packages/structured-clone/src/preprocess.ts`

