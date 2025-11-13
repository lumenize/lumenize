# DO Binding Storage - Eliminate `originBinding` Parameter

## Goal

Eliminate the need for manually passing `{ originBinding: 'ORIGIN_DO' }` to `call()` by automatically storing and retrieving DO binding information in LumenizeBase.

## Background

Cloudflare has on its roadmap the ability for DOs to know their own binding name (similar to `this.ctx.id`). Until then, we need to store this information ourselves.

**Current problem:**
```typescript
await this.svc.call(
  'REMOTE_DO',
  'remote-1',
  this.ctn<RemoteDO>().getUserData(userId),
  this.ctn().handleResult(this.ctn().$result),
  { originBinding: 'ORIGIN_DO' }  // ❌ Manual, error-prone
);
```

**Desired outcome:**
```typescript
await this.svc.call(
  'REMOTE_DO',
  'remote-1',
  this.ctn<RemoteDO>().getUserData(userId),
  this.ctn().handleResult(this.ctn().$result)
  // ✅ No options needed - binding info stored automatically
);
```

## Design Decisions

### Storage Keys

Singleton metadata (no colons - not collections):
- `__lmz_do_binding_name` - The DO's binding name
- `__lmz_do_instance_name_or_id` - The DO's instance name or ID

### Headers (Already Exist)

Set by `routeDORequest` (in `packages/utils/src/route-do-request.ts` lines 340-342):
- `x-lumenize-do-instance-name-or-id`
- `x-lumenize-do-binding-name`

### Init Method

```typescript
async __lmzInit(options?: {
  doBindingName?: string;
  doInstanceNameOrId?: string;
}): Promise<void>
```

Object parameter allows for future evolution.

### Verification Logic

1. **When storing `doBindingName`**:
   - Read existing value from `__lmz_do_binding_name`
   - If exists and doesn't match: throw with mismatch error
   - If doesn't exist: store the new value

2. **When storing `doInstanceNameOrId`**:
   - Read existing value from `__lmz_do_instance_name_or_id`
   - If it's a 64-byte hex string, also check against `this.ctx.id`
   - If either stored value or `this.ctx.id` exists and doesn't match: throw with mismatch error
   - If doesn't exist: store the new value

### Error Messages

```typescript
// When binding name not initialized
throw new Error(
  `Cannot use call() from a DO that doesn't know its own binding name. ` +
  `Call __lmzInit({ doBindingName }) first.`
);

// When binding name mismatch
throw new Error(
  `DO binding name mismatch: stored '${stored}' but received '${provided}'. ` +
  `A DO instance cannot change its binding name.`
);

// When instance name/id mismatch with stored value
throw new Error(
  `DO instance name/ID mismatch: stored '${stored}' but received '${provided}'. ` +
  `A DO instance cannot change its name or ID.`
);

// When instance name/id mismatch with this.ctx.id
throw new Error(
  `DO instance ID mismatch: this.ctx.id is '${this.ctx.id}' but received '${provided}'. ` +
  `A DO instance cannot change its ID.`
);
```

### Initialization Paths

1. **Via `routeDORequest`**: 
   - Headers are already set: `x-lumenize-do-binding-name`, `x-lumenize-do-instance-name-or-id`
   - LumenizeBase reads from headers in `fetch()` handler
   - Calls `__lmzInit()` automatically

2. **Via `@lumenize/call`**:
   - Call envelope includes binding info
   - Work handler extracts and calls `__lmzInit()`

3. **Manual (tests, direct DO creation)**:
   - User calls `__lmzInit({ doBindingName, doInstanceNameOrId })` explicitly
   - Example: `await originDO.__lmzInit({ doBindingName: 'ORIGIN_DO' });`

## Phases

### Phase 1: LumenizeBase Init Method ✅ COMPLETE

**Files modified:**
- `packages/lumenize-base/src/lumenize-base.ts` - Added `__lmzInit()` method (lines 246-329)
- `packages/lumenize-base/test/test-worker-and-dos.ts` - Added test helper methods
- `packages/lumenize-base/test/lumenize-base.test.ts` - Added comprehensive test suite

**Implementation:**
1. ✅ Added `__lmzInit()` method with verification logic
2. ✅ Uses inline check for 64-char hex ID: `/^[a-f0-9]{64}$/`
3. ✅ Added 15 tests covering all scenarios
4. ✅ Tests all error cases (mismatches, ID verification)

**Acceptance criteria (all met):**
- ✅ `__lmzInit({ doBindingName: 'MY_DO' })` stores `__lmz_do_binding_name`
- ✅ `__lmzInit({ doInstanceNameOrId: 'my-instance' })` stores `__lmz_do_instance_name_or_id`
- ✅ Calling twice with same values: no error
- ✅ Calling twice with different values: throws with clear error
- ✅ Passing 64-byte hex ID checks against `this.ctx.id`

**Test results:** 21 tests passing (18 init tests + 3 existing)

### Phase 2: routeDORequest Auto-Init ✅ COMPLETE

**Files modified:**
- `packages/lumenize-base/src/lumenize-base.ts` - Added `fetch()` handler (lines 50-127)
- `packages/lumenize-base/test/test-worker-and-dos.ts` - Added `testFetch()` helper method
- `packages/lumenize-base/test/lumenize-base.test.ts` - Added 7 fetch tests

**Implementation:**
1. ✅ Added `fetch()` handler that reads headers and calls `__initFromHeaders()`
2. ✅ Added `__initFromHeaders()` helper method for flexible usage
3. ✅ Try/catch block converts initialization errors to HTTP 500
4. ✅ Added comprehensive tests covering all scenarios

**Acceptance criteria (all met):**
- ✅ Requests with headers automatically initialize the DO
- ✅ Mismatches return HTTP 500 with error message in body
- ✅ Multiple requests with same values work correctly
- ✅ Missing headers are handled gracefully (no-op)
- ✅ Default fetch() returns 501 Not Implemented

**Test results:** 28 tests passing (25 lumenize-base tests + 3 for-docs tests)

### Phase 3: Call System Envelope ✅ COMPLETE

**Files modified:**
- `packages/call/src/call.ts` - Removed `getOriginBinding()` fallback, added storage read
- `packages/call/src/work-handler.ts` - Added `__lmzInit()` call for remote DO
- `packages/call/src/types.ts` - Removed `originBinding` from CallOptions, added to CallMessage
- `packages/call/test/test-worker-and-dos.ts` - Removed all `originBinding` options, added `initializeBinding()` helper
- `packages/call/test/for-docs/test-dos.ts` - Removed all `originBinding` options, added `initializeBinding()` helper, added `@ts-expect-error` for `$result`
- `packages/call/test/for-docs/basic-usage.test.ts` - Added `initializeBinding()` calls to all tests
- `packages/call/test/call.test.ts` - Added `initializeBinding()` calls to all tests (18 tests updated)

**Implementation:**
1. ✅ `call()` reads `__lmz_do_binding_name` from storage
2. ✅ Throws clear error if binding name not set
3. ✅ Includes `originBinding` and `originInstanceNameOrId` in envelope
4. ✅ `callWorkHandler` finds remote binding and calls `__lmzInit()`
5. ✅ Init errors are logged but don't fail the operation
6. ✅ Removed `originBinding` from `CallOptions`
7. ✅ All 24 tests updated and passing

**Acceptance criteria (all met):**
- ✅ Call works without `originBinding` parameter
- ✅ Remote DOs automatically initialized with explicit `targetBinding` and `targetInstanceNameOrId` from envelope
- ✅ Clear error when origin DO not initialized: `Cannot use call() from a DO that doesn't know its own binding name`
- ✅ All tests pass without `originBinding`

**Enhancement (post-completion):**
- ✅ Replaced heuristic `findRemoteBinding()` with explicit target info in envelope
- ✅ Added `targetBinding` and `targetInstanceNameOrId` to `CallMessage` interface
- ✅ Origin always sends exact binding/instance it's calling
- ✅ Much more reliable and explicit than name-matching heuristic

**Test results:** 24 tests passing (18 integration tests + 6 for-docs tests)

### Phase 4: Result Delivery Enhancement (Optional)

**Files to modify:**
- `packages/call/src/result-handler.ts`

**Tasks:**
1. When delivering results back to origin DO, include binding info in envelope
2. Call `__lmzInit()` on origin DO with that info
3. This catches cases where origin was initialized via call but not via routeDORequest

**Note:** This might be redundant if origin was already initialized via call in Phase 3.

### Phase 5: Test Refactoring

**Files to modify:**
- `packages/call/test/for-docs/basic-usage.test.ts`
- `packages/call/test/for-docs/test-dos.ts`

**Tasks:**
1. Add `__lmzInit()` calls to test setup where needed
2. Verify tests still pass
3. Consider if we can use `@lumenize/call` directly from tests (stretch goal)

**Acceptance criteria:**
- All for-docs tests pass
- Tests demonstrate proper init patterns

## Notes

- **Totally greenfield**: No backward compatibility needed - these packages were created yesterday
- **No deprecation**: Remove `originBinding` completely, no warnings needed
- **Always store**: Even if it duplicates `this.ctx.id`, store in `__lmz_do_instance_name_or_id` for consistency
- **Future evolution**: Object parameter allows adding new init options later

## Questions

None - design is clear and ready to implement.

## Related Files

- `packages/utils/src/route-do-request.ts` - Sets headers (lines 340-342)
- `packages/utils/src/get-do-stub.ts` - Has 64-byte hex ID check on line 22: `/^[a-f0-9]{64}$/`
- `packages/lumenize-base/src/lumenize-base.ts` - Where init method goes
- `packages/call/src/call.ts` - Where we remove originBinding requirement
- `packages/call/src/work-handler.ts` - Where we extract envelope info

