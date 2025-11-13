# Proxy-Fetch Unification - Use svc.call() Architecture

## Goal

Unify `@lumenize/proxy-fetch` with the `@lumenize/call` architecture, making FetchOrchestrator "just another actor" that uses `svc.call()` under the hood. Maintain a thin wrapper with domain-specific defaults for developer experience.

## Background

**Current State (Built Yesterday):**
- Proxy-fetch uses custom messaging to FetchOrchestrator
- Special-case API: `proxyFetchWorker(this, url, continuation, options)`
- Hardcoded instance: `'singleton'`
- Manual `originBinding` parameter (like call had before today)
- First-argument continuation convention (no nested markers)

**Desired State:**
- FetchOrchestrator is a normal actor accessed via `svc.call()`
- Thin wrapper provides fetch-specific defaults
- Users can create multiple named orchestrator instances
- Supports OCAN nested markers and property chains
- No `originBinding` parameter (auto-stored like we just did for call)

**Key Insight:**
Proxy-fetch isn't a "special fetch system" - it's a **remote actor that happens to do fetches**. Using `svc.call()` makes this explicit and unlocks all OCAN patterns.

## Design Decisions

### Architecture: Thin Wrapper Over svc.call()

```typescript
// User-facing API (thin wrapper)
await proxyFetchWorker(this, url, handler, {
  orchestratorInstance: 'us-west',  // Optional, defaults to 'default'
  maxRetries: 5,
  timeout: 45000,
  workerUrl: 'https://...'
});

// Under the hood - translates to svc.call()
const fetchOp = this.ctn<FetchOrchestrator>().executeFetch(url);
await this.svc.call('FETCH_ORCHESTRATOR', instanceName, fetchOp, handler, { timeout });
```

**Why thin wrapper:**
1. ✅ Domain-specific defaults (longer timeout, retries, etc.)
2. ✅ Instance management complexity hidden
3. ✅ Fetch-specific options (maxRetries, retryOn5xx, workerUrl, etc.)
4. ✅ Marketing/DX: "fetch from your DO" is distinct use case
5. ✅ Still uses svc.call() under the hood (architectural purity)

### Configuration Management

**Problem:** FetchOrchestrator needs per-request config (maxRetries, workerUrl, etc.) but we want to reuse instances.

**Solution:** Instance-level configuration with lazy setup:

```typescript
// First call to instance sets config
await proxyFetchWorker(this, url, handler, {
  orchestratorInstance: 'rate-limited',
  maxRetries: 1,
  timeout: 10000
});

// Subsequent calls to same instance reuse config
await proxyFetchWorker(this, url2, handler2, {
  orchestratorInstance: 'rate-limited'  // Uses existing config
});

// Different instance = different config
await proxyFetchWorker(this, url3, handler3, {
  orchestratorInstance: 'resilient',
  maxRetries: 5,
  timeout: 60000
});
```

**Implementation:**
- Store config in FetchOrchestrator instance's KV storage
- Key: `__lmz_fetch_config`
- First call sets config, subsequent calls validate or merge

### API Changes

**Remove:**
- ❌ `originBinding` parameter (auto-stored now!)
- ❌ Hardcoded `'singleton'` instance
- ❌ Custom envelope/messaging to FetchOrchestrator

**Add:**
- ✅ `executeFetch()` method on FetchOrchestrator (returns Promise<Response>)
- ✅ `orchestratorInstance` option (defaults to 'default')
- ✅ Config storage in FetchOrchestrator instances
- ✅ Uses `svc.call()` for all communication

### Continuation Patterns

**Both patterns now work:**

```typescript
// Pattern 1: First-argument (backward compatible)
await proxyFetchWorker(this, url, this.ctn().handleResponse());

// Pattern 2: Nested marker (new, enabled by svc.call)
const fetchOp = this.ctn<FetchOrchestrator>().executeFetch(url);
const handler = this.ctn().ctx.storage.kv.put('cache', fetchOp);
await proxyFetchWorker(this, url, handler);
```

### Timeout Semantics

**Different defaults:**
- **call timeout:** 30s (DO-to-DO communication)
- **fetch timeout:** 45s (external API calls slower)

**User can override:**
```typescript
await proxyFetchWorker(this, url, handler, {
  timeout: 60000  // 60s for slow external API
});
```

### Instance Strategy

**Use cases for multiple instances:**
- Regional: `'us-west'`, `'eu-central'` with region-specific workerUrls
- Rate-limited: `'rate-limited'` with maxRetries=1, timeout=10s
- Resilient: `'resilient'` with maxRetries=5, retryOn5xx=true
- Per-tenant: `'tenant-123'` with tenant-specific auth/config

**No registry needed** - just use named instances directly!

## Phases

### Phase 1: Add executeFetch() to FetchOrchestrator

**Files to modify:**
- `packages/proxy-fetch/src/FetchOrchestrator.ts`
- `packages/proxy-fetch/src/types.ts`

**Tasks:**
1. Add `executeFetch(request: string | Request, options?: FetchExecuteOptions): Promise<Response>`
2. Store config in `__lmz_fetch_config` on first call
3. Extract existing enqueueFetch logic into shared helper
4. Generate reqId, enqueue to Worker, return reqId (non-blocking)
5. Add config type: `FetchExecuteOptions` (maxRetries, retryDelay, retryOn5xx, workerUrl, workerPath)

**Acceptance criteria:**
- `executeFetch()` callable via Workers RPC
- Config stored and reused per instance
- Returns Promise<Response> (matches Worker result handler)

### Phase 2: Eliminate originBinding from Proxy-Fetch

**Files to modify:**
- `packages/proxy-fetch/src/proxyFetchWorker.ts`
- `packages/proxy-fetch/src/types.ts`
- `packages/proxy-fetch/test/integration/test-worker-and-dos.ts`
- `packages/proxy-fetch/test/integration/proxy-fetch-integration.test.ts`

**Tasks:**
1. Remove `originBinding` from `ProxyFetchWorkerOptions`
2. Remove `getOriginBinding()` heuristic
3. Read `__lmz_do_binding_name` from storage (like call does)
4. Add `initializeBinding()` helper to test DOs
5. Update all tests to call `initializeBinding()` before using proxy-fetch

**Acceptance criteria:**
- No `originBinding` parameter needed
- Tests pass with binding auto-stored
- Clear error if binding not initialized

### Phase 3: Refactor proxyFetchWorker to Use svc.call()

**Files to modify:**
- `packages/proxy-fetch/src/proxyFetchWorker.ts`

**Tasks:**
1. Replace direct FetchOrchestrator stub creation with `this.ctn()` proxy
2. Create `executeFetch()` operation via `this.ctn<FetchOrchestrator>()`
3. Call `this.svc.call('FETCH_ORCHESTRATOR', instance, fetchOp, handler, options)`
4. Default `orchestratorInstance` to `'default'` (not `'singleton'`)
5. Map options to call timeout and fetch config
6. Remove direct message envelope creation
7. Remove direct storage of pending continuations (call system handles this)

**Acceptance criteria:**
- proxyFetchWorker() internally uses svc.call()
- orchestratorInstance defaults to 'default'
- Backward compatible: existing tests pass with minimal changes
- Supports nested markers in continuations

### Phase 4: Update FetchOrchestrator Result Handling

**Files to modify:**
- `packages/proxy-fetch/src/FetchOrchestrator.ts`
- `packages/proxy-fetch/src/fetchWorkerResultHandler.ts`

**Tasks:**
1. Results now flow through call system (CallResult messages)
2. Worker still sends results to origin DO directly (optimization)
3. FetchOrchestrator marks completion in its tracking
4. Verify timeout handling works via call system
5. Test result handler integration with new flow

**Acceptance criteria:**
- Results delivered correctly via call system
- Timeouts handled by call system
- Worker optimization (direct origin callback) still works
- All 20 integration tests pass

### Phase 5: Enhanced Continuation Support

**Files to modify:**
- `packages/proxy-fetch/test/integration/test-worker-and-dos.ts`
- `packages/proxy-fetch/test/integration/proxy-fetch-integration.test.ts`

**Tasks:**
1. Add test for nested marker pattern: `this.ctn().ctx.storage.kv.put('cache', fetchOp)`
2. Add test for property chain access: `this.ctn().someProperty.someMethod()`
3. Verify both patterns work (first-argument and nested marker)
4. Add examples to for-docs tests

**Acceptance criteria:**
- Nested markers work in proxy-fetch continuations
- Property chains work (ctx.storage.kv.put, etc.)
- Tests demonstrate both patterns
- Documentation shows best practices

### Phase 6: Documentation and Examples

**Files to modify:**
- `packages/proxy-fetch/README.md`
- `website/docs/proxy-fetch/index.mdx`
- `packages/proxy-fetch/test/for-docs/` (create if needed)

**Tasks:**
1. Update README to show svc.call() architecture
2. Document thin wrapper benefits
3. Show multiple instance patterns (regional, rate-limited, etc.)
4. Show both continuation patterns
5. Document config persistence per instance
6. Create for-docs tests for @check-example validation

**Acceptance criteria:**
- Clear documentation of architecture
- Multiple use cases shown
- Examples validated via tests
- Migration guide (none needed - built yesterday!)

## Options Mapping

**ProxyFetchWorkerOptions (user-facing):**
```typescript
interface ProxyFetchWorkerOptions {
  orchestratorInstance?: string;   // NEW: Which FetchOrchestrator to use (default: 'default')
  timeout?: number;                 // → CallOptions.timeout (default: 45000)
  maxRetries?: number;              // → FetchExecuteOptions
  retryDelay?: number;              // → FetchExecuteOptions
  maxRetryDelay?: number;           // → FetchExecuteOptions
  retryOn5xx?: boolean;             // → FetchExecuteOptions
  workerUrl?: string;               // → FetchExecuteOptions
  workerPath?: string;              // → FetchExecuteOptions
}
```

**Call System Timeout:**
- `CallOptions.timeout` - DO-to-DO communication timeout (default: 45s for fetches vs 30s for calls)

**FetchOrchestrator Config:**
- `FetchExecuteOptions` - Stored per instance, controls retry behavior and worker routing

## Dependencies

**Completed work (today):**
- ✅ `@lumenize/call` - Mature, tested, eliminates originBinding
- ✅ `__lmzInit()` - Binding storage in LumenizeBase
- ✅ `replaceNestedOperationMarkers()` - Shared utility in @lumenize/core
- ✅ OCAN property chains - Fully supported in call system

**No blockers** - all foundation work is complete!

## Testing Strategy

**Integration tests (existing):**
- Update to use `initializeBinding()`
- Remove `originBinding` from all calls
- Verify all 20 tests still pass

**New tests:**
- Multiple instance usage (default, custom names)
- Config persistence per instance
- Nested marker patterns
- Property chain access in continuations
- Timeout handling via call system

**For-docs tests:**
- Basic usage with thin wrapper
- Multiple instances pattern
- Nested markers example
- Property chain example

## Success Criteria

1. ✅ No `originBinding` parameter needed
2. ✅ Uses `svc.call()` internally (architectural purity)
3. ✅ Thin wrapper provides fetch-specific defaults
4. ✅ Multiple named instances supported
5. ✅ Both continuation patterns work (first-argument and nested markers)
6. ✅ All existing tests pass
7. ✅ New tests cover enhanced patterns
8. ✅ Documentation shows best practices

## Notes

- **No backward compatibility needed** - built yesterday, no existing usage
- **Marketing value** - thin wrapper makes "fetch from DO" a clear use case
- **Architectural consistency** - everything uses svc.call() for actor communication
- **Future-proof** - foundation supports any actor-model communication pattern

## Questions

1. Should we support config override per call, or only per instance?
   - **Decision:** Per instance with initial config, subsequent calls validate/merge
   
2. Do we need a registry or just use named instances directly?
   - **Decision:** Named instances directly - simpler, no registry needed
   
3. Keep Worker direct callback optimization?
   - **Decision:** Yes - significant latency win, doesn't break call system

## Related Files

- `packages/proxy-fetch/src/proxyFetchWorker.ts` - Main refactoring target
- `packages/proxy-fetch/src/FetchOrchestrator.ts` - Add executeFetch()
- `packages/proxy-fetch/src/types.ts` - Update types
- `packages/call/src/call.ts` - Reference for svc.call() pattern
- `packages/lumenize-base/src/lumenize-base.ts` - __lmzInit() pattern
- `packages/core/ocan/execute.ts` - replaceNestedOperationMarkers()

