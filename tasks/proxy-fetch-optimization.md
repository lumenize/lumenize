# Proxy-Fetch Optimization: Simple Version & Performance Comparison

**Status**: Planning
**Type**: Implementation-First (performance optimization, no API changes)

## Objective

Create `proxyFetchSimple()` that eliminates the `FetchOrchestrator` DO, moving all coordination logic to the origin DO. Compare performance and cost across three approaches (direct fetch being the third) to validate cost-saving theories and performance differences (latency and scalability).

## Background

**Current Architecture** (`proxyFetch`):
- Origin DO → `FetchOrchestrator` DO (via `this.lmz.callRaw`)
- `FetchOrchestrator` DO → Worker Executor (via RPC)
- Worker executes fetch (CPU billing)
- Worker → Origin DO (result delivery via `this.lmz.callRaw`)

**Problem**: Extra hop through Orchestrator adds complexity and potential latency

## Research: RpcTarget vs WorkerEntrypoint

**Key Differences** (from Cloudflare docs):

**WorkerEntrypoint:**
- Has special method semantics (`fetch()`, `alarm()`, etc.)
- `fetch()` must accept `Request`, return `Response`
- Backwards compatible with HTTP handling
- More complex lifecycle with execution contexts

**RpcTarget:**
- Pure RPC - no special method names
- Can return any type (not limited to Response)
- Simpler lifecycle
- Better for pure RPC services that don't need HTTP handling

**For FetchExecutor:** `RpcTarget` is cleaner because:
- We don't need HTTP handling (just RPC methods)
- Current `WorkerEntrypoint` is overkill
- Simpler lifecycle = less overhead

**Trade-off:** `RpcTarget` requires `compatibility_date: "2024-04-03"` or higher (we're already on "2025-09-12" ✅)

## Phase -1: Make `postprocess()` and `parse()` Synchronous

**Goal**: Eliminate unnecessary event loop yields in Durable Objects to maintain consistency guarantees without `blockConcurrencyWhile`.

**The Critical Problem**:
```typescript
// postprocess() is async but does ZERO async operations
export async function postprocess(data: LmzIntermediate, options?: PostprocessOptions): Promise<any>

// In DO code, every await YIELDS TO EVENT LOOP:
const operationChain = await postprocess(JSON.parse(row.operationChain));
// ⚠️ During this await, other requests can interleave → RACE CONDITIONS!
```

**Why This Matters for Durable Objects**:
- Every `await` yields control to the event loop
- Cloudflare can then process other incoming requests
- This breaks consistency guarantees (race conditions)
- Forces unnecessary `blockConcurrencyWhile` wrapping for operations that are actually synchronous
- Making them sync = no yield = no race risk = no `blockConcurrencyWhile` needed

**Discovery regarding unnecessary async**:
- Searched entire codebase: 45+ calls to `postprocess()`, **ZERO pass options/transform**
- All reconstruction is sync: `new Request()`, `new Response()`, `new Headers()`, `new Map()`, etc.
- `PostprocessTransform` hooks exist but are **never used**
- `parse()` is just `postprocess(JSON.parse(value))` - also unnecessarily async
- We believe that `postprocess()` was async and this unused hook were added for silly consistency with `preprocess()` which does need both.

**Unrelated discovery**:
- `createIncomingOperationsTransform()` is imported but **never called** (dead code)
- RPC uses manual `processIncomingOperations()` function instead

**Changes**:
1. **Make `postprocess()` and `parse()` synchronous**:
   ```typescript
   export function postprocess(data: LmzIntermediate): any
   export function parse(value: string): any  // Is simply: postprocess(JSON.parse(value))
   ```

2. **Remove unused transform infrastructure**:
   - Delete `PostprocessTransform` type
   - Delete `PostprocessOptions` interface (affects both `postprocess()` and `parse()`)
   - Delete `createIncomingOperationsTransform()` from `rpc-transforms.ts`
   - Remove import from `lumenize-rpc-do.ts`

3. **Update all `postprocess()` call sites** (remove `await`):
   - `packages/alarms/src/alarms.ts` (3 calls)
   - `packages/lumenize-base/src/lumenize-base.ts` (2 calls)
   - `packages/lumenize-base/src/lumenize-worker.ts` (1 call)
   - `packages/proxy-fetch/src/workerFetchExecutor.ts` (2 calls)
   - `packages/proxy-fetch/src/FetchOrchestrator.ts` (1 call)
   - `packages/rpc/src/http-post-transport.ts` (1 call)
   - `packages/rpc/src/websocket-rpc-transport.ts` (1 call)
   - All test files

4. **Update all `parse()` call sites** (remove `await`):
   - `packages/rpc/src/lumenize-rpc-do.ts` (2 calls)
   - `packages/proxy-fetch/test/full-flow.test.ts` (6 calls)
   - `packages/structured-clone/test/` (many test files)
   - Documentation examples

**Why Not Keep Async Version**:
- **Primary**: Prevents race conditions in DOs by not yielding to event loop
- **Secondary**: Eliminates need for `blockConcurrencyWhile` wrapping synchronous operations
- Not backward compatible, but acceptable: Existing code that awaits it will still work, but code expecting a Promise will break. Nothing is released yet, so we accept this breaking change.
- Transform hooks are unused dead code
- Making API honest about what it actually does (synchronous reconstruction)

**Success Criteria**:
- [ ] `postprocess()` and `parse()` are synchronous
- [ ] All transform hook code deleted (`PostprocessTransform`, `PostprocessOptions`, `createIncomingOperationsTransform`)
- [ ] All `postprocess()` call sites updated (no `await`)
- [ ] All `parse()` call sites updated (no `await`)
- [ ] All tests pass
- [ ] **Documentation updated** (`website/docs/structured-clone/index.mdx`):
  - [ ] Remove `await` from `postprocess()` and `parse()` examples
  - [ ] Update API signatures to show sync functions
  - [ ] Note in docs: "These are synchronous - all reconstruction operations are sync"

## Phase 0.5: Refactor Alarms Execution to Use `__executeChain()`

**Goal**: Make alarms execution consistent with new `this.lmz.call()` pattern.

**Current Issue**:
```typescript
// In triggerAlarms(), line 460-461
const operationChain = await postprocess(JSON.parse(row.operationChain));
await executeOperationChain(operationChain, this.#parent);  // Direct call
```

**Improvement** (after Phase -1 makes postprocess() sync):
```typescript
const operationChain = postprocess(JSON.parse(row.operationChain));  // Now sync!
await this.#parent.__executeChain(operationChain);  // Use LumenizeBase abstraction!
```

**Why:**
- Consistent with `this.lmz.call()` architecture
- Uses clean abstraction instead of direct function call
- Future-proof: If we add functionality to `__executeChain()` (metrics, tracing), alarms gets it automatically
- No `blockConcurrencyWhile` needed - handlers should be pure sync (no external fetches/RPC)

**Note on `blockConcurrencyWhile` Usage**:
- ✅ Used in `schedule()` for `preprocess()` (async serialization)
- ❌ NOT needed for storage operations (all sync: `ctx.storage.kv.*`, `ctx.storage.sql.*`)
- ❌ NOT needed for handler execution (handlers should be pure sync)
- ✅ Only needed for external fetches (use `proxy-fetch`) and RPC (use `this.lmz.call()`)

**Success Criteria**:
- [ ] Change `executeOperationChain()` → `__executeChain()` in `triggerAlarms()`
- [ ] Same change in `alarm()` method
- [ ] Verify no `await` on storage operations (all storage is sync)
- [ ] All alarms tests still pass
- [ ] Pattern matches `this.lmz.call()` architecture

## Phase 1: Upgrade `cancelSchedule()` to Return Schedule Data

**Goal**: Make `cancelSchedule()` return the schedule data atomically, enabling idempotency pattern for `proxyFetchSimple`.

**The Atomicity Requirement**:
```typescript
// Race condition we're preventing:
// - Fetch result arrives
// - Timeout alarm fires
// Only ONE should execute the continuation!

// Solution: Whoever successfully cancels the alarm gets the continuation
const scheduleData = cancelSchedule(reqId);  // Atomic: get + delete
if (scheduleData) {
  // I won! Execute continuation with my result
  await this.__executeChain(scheduleData.operationChain, [myResult]);
} else {
  // Other path already won, alarm is gone - noop
}
```

**Current API** (returns boolean):
```typescript
cancelSchedule(id: string): boolean {
  this.#ensureTable();
  this.#ctx.blockConcurrencyWhile(async () => {  // Unnecessary!
    this.#sql`DELETE FROM __lmz_alarms WHERE id = ${id}`;
    this.#scheduleNextAlarm();
  });
  return true;  // Doesn't tell us if alarm existed
}
```

**New API** (returns data, pure sync after Phase -1):
```typescript
cancelSchedule(id: string): Schedule | undefined {
  this.#ensureTable();
  
  // Get the data (includes operationChain/continuation)
  const result = this.#sql`SELECT * FROM __lmz_alarms WHERE id = ${id}`.toArray();
  let scheduleData: Schedule | undefined;
  
  if (result.length > 0) {
    scheduleData = {
      ...result[0],
      operationChain: postprocess(JSON.parse(result[0].operationChain))  // SYNC after Phase -1!
    };
  }
  
  // Delete it
  this.#sql`DELETE FROM __lmz_alarms WHERE id = ${id}`;
  this.#scheduleNextAlarm();
  
  return scheduleData;  // undefined if not found
}
```

**Why No `blockConcurrencyWhile`?**
- All operations are synchronous (SQL + sync `postprocess()`)
- Never yields to event loop = atomicity guaranteed
- This is the entire point of Phase -1!

**Success Criteria**:
- [ ] `cancelSchedule()` returns `Schedule | undefined` instead of `boolean`
- [ ] Remove unnecessary `blockConcurrencyWhile` wrapper
- [ ] Unit tests verify atomic get-and-delete behavior
- [ ] Returns `undefined` if alarm not found (already fired or never existed)
- [ ] Properly reschedules next alarm
- [ ] **Documentation updated** (`website/docs/alarms/index.mdx`):
  - [ ] Remove `await` from `cancelSchedule()` example (will be sync after Phase 1)
  - [ ] Show example using returned `Schedule` data with if/else pattern
  - [ ] Add new section: "Idempotency Pattern" showing race condition handling
  - [ ] **CRITICAL**: Remove `await` from ALL `schedule()` calls (already sync, never needed await!)
  - [ ] Note in docs: `schedule()` and `cancelSchedule()` are synchronous operations
- [ ] Used in Phase 2 for idempotency pattern

## Phase 2: Create `proxyFetchSimple()`

**Goal**: Implement simplified version without `FetchOrchestrator`, all coordination in origin DO.

**Architecture**:
- Origin DO schedules timeout alarm storing continuation IN the alarm data (fires at timeout + grace period)
- Origin DO calls Worker Executor directly via `this.lmz.callRaw()` (no orchestrator hop)
- Worker executes fetch (CPU billing)
- Worker delivers result to origin DO via `this.lmz.callRaw()`
- **Alarm is the ONLY storage** - continuation lives in alarm's operationChain
- Whoever successfully cancels the alarm gets the continuation and wins the race

**Key Insight - Idempotency via Atomic Cancel**:
```typescript
// When result arrives from worker
async handleFetchResult(reqId: string, result: ResponseSync | Error) {
  // Try to cancel alarm - returns data if successful (atomic get+delete)
  const scheduleData = this.svc.alarms.cancelSchedule(`fetch-${reqId}`);
  
  if (!scheduleData) {
    // Alarm already fired (timeout won), continuation already executed
    // This is a noop - just log for debugging
    return;
  }
  
  // We won! Execute continuation from alarm data
  await this.__executeChain(scheduleData.operationChain, [result]);
}

// When timeout alarm fires (via @lumenize/alarms handler)
async handleFetchTimeout(scheduleData: Schedule) {
  // Timeout won! Alarm handler gets the continuation automatically
  const error = new Error(`Fetch timeout after ${scheduleData.metadata.timeout}ms`);
  await this.__executeChain(scheduleData.operationChain, [error]);
  
  // After this returns, @lumenize/alarms auto-deletes the alarm
  // If result arrives now, cancelSchedule() returns undefined → noop
}
```

**Benefits vs Current Version**:
- ✅ No `FetchOrchestrator` DO (simpler architecture)
- ✅ No polling every 5s (alarm fires at exact timeout + grace)
- ✅ No race condition (alarm cancellation is atomic - whoever cancels gets the continuation)
- ✅ Each fetch gets dedicated alarm (multiplexed by @lumenize/alarms)
- ✅ One less RPC hop (DO → Worker, not DO → Orchestrator → Worker)

**Testing Hooks**:
```typescript
interface ProxyFetchSimpleOptions {
  timeout?: number;           // Default: 30000ms
  gracePeriod?: number;       // Default: 5000ms
  executorBinding?: string;   // Default: 'FETCH_EXECUTOR'
  testMode?: {
    // Worker ignores result delivery to test timeout path
    simulateDeliveryFailure?: boolean;
  };
}

// In tests:
const reqId = await originDO.fetchData(url, { 
  timeout: 100,
  testMode: { simulateDeliveryFailure: true }
}, 'test-req-123');

// Trigger alarm immediately (don't wait for timeout)
await originDO.svc.alarms.triggerAlarms();

// Assert: handleFetchResult called with Error (timeout)
// Assert: If worker tries to deliver now, it's a noop
```

**Success Criteria**:
- [ ] `proxyFetchSimple()` function works end-to-end
- [ ] No `FetchOrchestrator` dependency
- [ ] All coordination logic in origin DO
- [ ] Worker executor unchanged
- [ ] Idempotency verified: no double-execution in race condition
- [ ] Tests pass using `triggerAlarms()` hook
- [ ] Tests verify race condition handling

**Storage Pattern**:
- **No separate storage!** Alarm IS the storage
- Alarm: `fetch-${reqId}` with `operationChain` (continuation) and `metadata` (timeout, etc.)
- Alarm fires → `handleFetchTimeout(scheduleData)` receives continuation automatically
- Idempotency: Whoever successfully cancels the alarm gets the continuation (atomic via `cancelSchedule()`)

## Phase 3: Create LumenizeRpcTarget

**Goal**: New base class for `RpcTarget` with same `this.lmz.*` API as `LumenizeWorker`.

**Implementation**:
- Copy-paste from `LumenizeWorker` (simple, no inheritance tricks)
- Extend `RpcTarget` instead of `WorkerEntrypoint`
- Located in `packages/lumenize-base/src/lumenize-rpc-target.ts` alongside `lumenize-base.ts` and `lumenize-worker.ts`
- Same API: `this.lmz.*`, `ctn()`, `__executeOperation()`
- Unit tests (use WorkerEntrypoint testing pattern from Phase 5 of call-raw task)

**Success Criteria**:
- [ ] `LumenizeRpcTarget` class in `@lumenize/lumenize-base`
- [ ] Extends `RpcTarget`
- [ ] Implements same `this.lmz.*` API as `LumenizeWorker`
- [ ] Unit tests pass (19+ tests like `LumenizeWorker`)
- [ ] Exported from `@lumenize/lumenize-base`

**Code Sharing Strategy**:
- Copy-paste from `LumenizeWorker` for now (~50 lines)
- If we keep both long-term, can refactor to shared utility later
- Simplicity > DRY at this stage

## Phase 4: Implement RpcTarget Executor

**Goal**: Create `FetchExecutorRpcTarget` using new `LumenizeRpcTarget` base.

**Success Criteria**:
- [ ] `FetchExecutorRpcTarget` class created
- [ ] Extends `LumenizeRpcTarget` instead of `LumenizeWorker`
- [ ] Same `executeFetch()` method functionality
- [ ] Works with `proxyFetchSimple()`
- [ ] Tests pass

**Notes**:
- Main change is just the base class (one line!)
- May discover lifecycle differences with `RpcTarget`
- Document any differences found

## Next Steps After Phase 4

Once Phase 4 is complete, this task is done! We'll have:
- ✅ Working `proxyFetchSimple()` without Orchestrator
- ✅ `LumenizeRpcTarget` base class
- ✅ RpcTarget-based executor option
- ✅ Alarm-based timeout coordination
- ✅ Atomic idempotency via `cancelSchedule()`

**Then proceed to:** `tasks/proxy-fetch-performance-experiments.md`

## Resolved Design Decisions

1. ✅ **Timeout handling**: Use `@lumenize/alarms` with one alarm per fetch, fires at timeout + grace period
2. ✅ **Idempotency**: Atomic alarm cancellation - whoever cancels gets the continuation (via upgraded `cancelSchedule()`)
3. ✅ **Continuation storage**: In alarm's `operationChain` (no separate storage needed!)
4. ✅ **API surface**: Separate functions (`proxyFetch` vs `proxyFetchSimple`)
5. ✅ **RpcTarget approach**: Yes, implement with `LumenizeRpcTarget` base class
6. ✅ **Code sharing**: Copy-paste from `LumenizeWorker` for simplicity
7. ✅ **Testing**: Keep `simulateDeliveryFailure` + use `triggerAlarms()` for fast tests

## Open Questions

1. **Race condition edge cases**: Any scenarios where alarm + KV could desync?
2. **Retry logic**: Simple version doesn't have retry - is that okay?
3. **Monitoring**: How to observe timeout rates without orchestrator queue stats?

## Notes

**Key Architectural Improvements**:

**Idempotency Pattern**:
- Atomic alarm cancellation: `cancelSchedule()` returns data if present, `undefined` if already fired
- No race condition: Either result or timeout wins, loser becomes noop
- No polling: Alarm fires exactly at timeout + grace period
- Per-fetch alarms: Each fetch gets dedicated alarm (multiplexed by @lumenize/alarms)

**Cost Savings Math** (theoretical):
- Worker CPU time: ~$0.02 per 1M CPU-ms
- DO wall-clock time: ~$12.50 per 1M wall-clock-ms (625x more expensive)
- For 100ms fetch: If Worker adds 10ms round-trip, saves 90ms of DO billing = ~9x savings
- For 1s fetch: If Worker adds 30ms round-trip, saves 970ms of DO billing = ~32x savings

**Alarms Integration Benefits**:
- ✅ No polling every 5s (current orchestrator overhead)
- ✅ No persistent queue (simpler state management)
- ✅ Elegant idempotency via alarm presence
- ✅ Grace period prevents premature DO wakeup
- ✅ Test hook via `triggerAlarms()` is cleaner than `forceAlarmCheck()`

**Trade-offs to Explore**:
- Simple version: Less complexity, no persistent queue, single DO coordination
- Orchestrator version: More complex, persistent queue survives DO eviction, better monitoring
- RpcTarget vs WorkerEntrypoint: Lifecycle overhead differences unknown

## Dependencies

- `@lumenize/lumenize-base` - for `this.lmz.callRaw()`, `LumenizeWorker`, new `LumenizeRpcTarget`
- `@lumenize/alarms` - for timeout coordination, needs upgraded `cancelSchedule()` method
- `@lumenize/proxy-fetch` - current implementation as baseline
- `@lumenize/structured-clone` - for continuation serialization
- Test infrastructure for performance experiments

## Summary

**What we're building in this task:**
- **Phase -1**: Make `postprocess()` and `parse()` synchronous (eliminate unnecessary event loop yields)
- **Phase 0.5**: Refactor alarms to use `__executeChain()` (consistency with `this.lmz.call()`)
- **Phase 1**: Upgrade `cancelSchedule()` to return `Schedule | undefined` (atomic idempotency)
- **Phase 2**: Create `proxyFetchSimple()` - no orchestrator, alarm-based coordination in origin DO
- **Phase 3**: Create `LumenizeRpcTarget` base class (copy-paste from `LumenizeWorker`)
- **Phase 4**: Create `FetchExecutorRpcTarget` using new base class

**Key innovations:**
- Atomic alarm cancellation for idempotency (whoever cancels gets the continuation)
- Per-fetch alarms (no polling)
- One less RPC hop (no orchestrator)
- RpcTarget for potentially lower overhead
- No unnecessary event loop yields (sync `postprocess()`/`parse()`)

**Performance validation:**
See separate task: `tasks/proxy-fetch-performance-experiments.md`
- Covers measurement methodology (Cloudflare observability logs)
- Runs experiments comparing Direct, Current, and Simple approaches
- Makes keep/deprecate decisions based on data

