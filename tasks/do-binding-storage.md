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

### Phase 1: LumenizeBase Init Method ✅ Ready to Start

**Files to modify:**
- `packages/lumenize-base/src/lumenize-base.ts`

**Tasks:**
1. Add `__lmzInit()` method with verification logic
2. Use inline check for 64-char hex ID: `/^[a-f0-9]{64}$/` (same as `getDOStub` in utils)
3. Add tests in `packages/lumenize-base/test/`
4. Test all error cases (mismatches, missing init)

**Acceptance criteria:**
- `__lmzInit({ doBindingName: 'MY_DO' })` stores `__lmz_do_binding_name`
- `__lmzInit({ doInstanceNameOrId: 'my-instance' })` stores `__lmz_do_instance_name_or_id`
- Calling twice with same values: no error
- Calling twice with different values: throws with clear error
- Passing 64-byte hex ID checks against `this.ctx.id`

### Phase 2: routeDORequest Auto-Init

**Files to modify:**
- `packages/lumenize-base/src/lumenize-base.ts` (fetch handler)

**Tasks:**
1. In `fetch()` handler, read headers `x-lumenize-do-binding-name` and `x-lumenize-do-instance-name-or-id`
2. If either header exists, call `__lmzInit()` with those values
3. Wrap in try/catch and convert Error to HTTP 500 response
4. Add tests using `routeDORequest` to verify auto-init

**Acceptance criteria:**
- Requests routed via `routeDORequest` automatically initialize the DO
- Mismatches return HTTP 500 with error message
- Multiple requests with same values work correctly

### Phase 3: Call System Envelope

**Files to modify:**
- `packages/call/src/call.ts` (envelope creation)
- `packages/call/src/work-handler.ts` (envelope reading)
- `packages/call/src/types.ts` (remove originBinding from options)

**Tasks:**
1. In `call()`, read `__lmz_do_binding_name` from origin DO storage
2. If not set, throw: `Cannot use call() from a DO that doesn't know its own binding name...`
3. Include in work envelope sent to remote DO
4. In `callWorkHandler`, extract binding info and call `__lmzInit()` on remote DO
5. Catch errors and return as Error objects (not throw)
6. Remove `originBinding` from `CallOptions` interface
7. Update all tests to remove `originBinding` parameter

**Acceptance criteria:**
- Call works without `originBinding` parameter
- Remote DOs are automatically initialized with correct binding info
- Clear error if origin DO not initialized
- Tests pass without `originBinding`

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

