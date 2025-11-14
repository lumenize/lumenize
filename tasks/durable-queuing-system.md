# Durable Queuing System for LumenizeBase

**Status**: ✅ COMPLETED (Alternative Implementation)
**Started**: 2025-11-13
**Completed**: 2025-11-14
**Resolution**: Implemented via synchronous svc.call() with 0-second alarms instead of generic queue system

## Completion Summary (Nov 14, 2025)

**What We Built Instead:**

Rather than a generic queue system in LumenizeBase, we achieved all goals via:

1. **✅ Synchronous svc.call()** - Returns `void`, callable from non-async methods
   - Stores call data in `__lmz_call_data:{callId}` (durable)
   - Schedules 0-second alarm for async work
   - `__processCallQueue` handler retrieves data and performs RPC

2. **✅ FIFO Ordering** - ULID-based alarm IDs
   - `ulid-workers` provides monotonic IDs even with frozen Cloudflare clock
   - SQL queries: `ORDER BY time ASC, id ASC`

3. **✅ Crash Recovery** - Persistent storage survives DO evictions
   - Call data stored in KV before alarm scheduled
   - Alarms package uses SQL for alarm persistence
   - Constructor recovery via alarms.triggerAlarms()

4. **✅ Synchronous schedule()** - Made `alarms.schedule()` synchronous
   - Uses `ctx.blockConcurrencyWhile` for short async operations
   - Preprocesses operation chains within block
   - Schedules native alarm within block for consistency

5. **✅ Eliminated originBinding** - Added `__lmzInit()` to LumenizeBase
   - Stores `__lmz_do_binding_name` in KV (auto-init from headers or explicit)
   - Call system reads binding from storage (fail-fast if missing)
   - Target binding/instance passed in call envelope

6. **✅ Centralized OCAN result injection** - `replaceNestedOperationMarkers()`
   - Shared utility in `@lumenize/core/ocan`
   - Handles both explicit markers (`$result`) and first-argument convention
   - Supports property chain access in continuations

**Why This Approach:**
- Avoids generic abstraction that might not fit all use cases
- Leverages existing alarms package (proven, tested)
- Natural API: `this.svc.call(...)` - no await needed
- Pattern is reusable: any NADIS service can follow same model
- Test Results: call (26/28 ✅), alarms (62/62 ✅), proxy-fetch (20/20 ✅)

**Next:** Apply same pattern to proxy-fetch (see `tasks/proxy-fetch-unification.md`)

## Original Goal (For Reference)

Extract crash-safe queuing patterns from old proxy-fetch into a reusable system in LumenizeBase/core that provides:
- **FIFO ordering guarantees** (ULID-based for both inbound and outbound queues)
- **Constructor-based recovery** (doesn't depend on alarms)
- **Optional alarm-based processing** (if alarms package available)
- **Consistent naming** (`__enqueueInbound`/`__enqueueOutbound`)
- Used by proxy-fetch, call system, and potentially other packages

## Background

**Current State:**
- New `proxyFetchWorker` stores requests but has no recovery mechanism
- FetchOrchestrator has fire-and-forget dispatch (TODO on line 133-134)
- **Input queue (`__enqueueWork`) lacks FIFO ordering** ⚠️
- Inconsistent naming (work vs. inbound/outbound)
- No crash recovery after DO eviction/restart

**Existing Input Queue in LumenizeBase:**
- `__enqueueWork(workType, workId, workData)` - Receive work from remote callers
- Storage: `__lmz_queue:{workType}:{workId}`
- Process immediately as batch, delete on success
- Uses global registry `__lumenizeWorkHandlers`
- **Missing**: FIFO guarantee, recovery mechanism

**What We Need - Output Queue:**
- For OUTGOING work (when this DO sends calls/fetches)
- Must survive crashes and recover in constructor
- Must maintain FIFO order (ULID-based)
- Must handle dispatch failures
- Never await remote work completion (actor model - only await receipt confirmation)

**Old System Strengths (to restore):**
- ULID-based FIFO queue in storage
- Constructor recovery for orphaned requests
- Alarm-based processing loop
- Automatic retry on transient failures

**Design Constraints:**
- Can't use native DO alarm (alarms package monopolizes it)
- Must use constructor recovery as primary mechanism (we control it via LumenizeBase)
- Alarms package optional for non-crash retry (if available)
- Must be generic enough for proxy-fetch AND call system
- Should live in LumenizeBase for access to `ctx.storage` and lifecycle
- **Never await remote work** - only await receipt confirmation (actor model)

## Phase 0: Understand Call System API (PREREQUISITE) ✅ COMPLETED

**Goal:** Clarify how `$result` markers work and continuation signatures before hardening

**Status:** ✅ COMPLETED - Full understanding achieved

### Questions Resolved

- [x] **0.1**: How do `$result` markers work?
  - **Answer:** Each call stores its own continuation with operationId
  - Multiple calls tracked separately in `__lmz_call_pending:{operationId}`
  - Result matched by operationId, not by marker itself
  - Three valid syntaxes: extracted vars (recommended), inline `$result`, inline variable ref

- [x] **0.2**: What is the signature of `executeOperationChain`?
  - **Answer:** `executeOperationChain(chain, doInstance)` - errors handled within chain
  - `replaceNestedOperationMarkers(chain, resultOrError)` injects result/error
  - Handler receives error OR result (not both parameters)
  - Works for both proxy-fetch and call system

- [x] **0.3**: Review call system implementation
  - **Answer:** Full flow documented in `packages/call/test/for-docs/test-dos.ts`
  - Results routed via `__enqueueWork('call', operationId, callResult)`
  - Continuations stored in `__lmz_call_pending:{operationId}`
  - Now uses 0-second alarms for async boundary

- [x] **0.4**: Test current call system
  - **Answer:** Yes! 26/28 tests passing (2 skipped for cancellation)
  - Errors handled correctly via continuation
  - Timeouts work via call system timeout mechanism
  - Property chains work: `this.ctn().ctx.storage.kv.get(...)`

### Success Criteria ✅
- ✅ Complete understanding of continuation/marker API
- ✅ Implementation verified and improved (made synchronous!)
- ✅ Clear pattern for error handling in continuations
- ✅ Confidence achieved - proceeded with implementation

### Notes
- **User feedback**: "I think we should put this work aside and focus on the API first"
- **Decision**: Pivoted to API understanding - led to complete rewrite as synchronous system
- **Outcome**: Better than originally planned - synchronous, durable, FIFO-ordered

---

## Phase 1: Analysis & Design

**Goal:** Understand what we need and design the generic system

**Dependencies:** Phase 0 must be complete

### Steps

- [ ] **1.1**: Analyze current proxy-fetch gaps
  - Document what's missing in FetchOrchestrator recovery
  - Document what's missing in origin DO continuation handling
  - Identify failure scenarios (dispatch failure, crash mid-processing, eviction)

- [ ] **1.2**: Analyze input queue gaps
  - Input queue lacks FIFO ordering (uses `{workType}:{workId}` - no ordering)
  - Should add ULID-based ordering like output queue
  - Consistent with actor model (process in order received)

- [ ] **1.3**: Analyze alarms package hardening
  - Does alarms properly handle crash recovery?
  - Does it use constructor recovery?
  - Can we learn patterns from it?

- [ ] **1.4**: Design generic queue interface
  - What operations: enqueue, dequeue, peek, markComplete, getOrphaned?
  - How to ensure FIFO: ULID-based keys for both inbound and outbound
  - Storage schema: What KV keys/prefixes?
  - How to make it generic for both proxy-fetch and call system?

- [ ] **1.5**: Design recovery patterns
  - Constructor recovery: When/how to scan storage?
  - How to detect orphaned requests vs. in-flight?
  - Timeout for "stuck" requests?
  - Optional alarm integration: How to detect if alarms available?

- [ ] **1.6**: Design configuration system
  - Create `LMZ_CONFIG` constant with typed defaults
  - Create `LMZ_CONFIG_OVERRIDES` for user customization
  - Document override pattern for subclasses

### Success Criteria
- Clear understanding of gaps
- Documented generic queue interface design
- Recovery pattern design that works without alarms
- Configuration pattern defined
- User approval to proceed with implementation

### Notes
- **Key insight**: Since LumenizeBase controls constructor, we can reliably do constructor recovery
- **Trade-off**: Constructor recovery only happens on first request after eviction (not proactive)
- **Alarm option**: If alarms installed, can do proactive sweeps every 5 seconds
- **Alarm sweep**: Use single 5-second alarms (not cron), reschedule if queue non-empty
- **Constructor**: Wrap all async work in `blockConcurrencyWhile` to prevent state races

---

## Phase 2: Implementation - Core Queue System

**Goal:** Build the generic durable queue in LumenizeBase or core

### Steps

- [ ] **2.1**: Create `DurableQueue` class in appropriate package
  - Decide: LumenizeBase or core?
  - Basic enqueue/dequeue/peek operations
  - Timestamp-based FIFO ordering
  - Mark complete/delete operations

- [ ] **2.2**: Implement constructor recovery
  - Scan for orphaned requests on construction
  - Configurable timeout for "stuck" detection
  - Return list of items to process

- [ ] **2.3**: Add optional alarm integration
  - Detect if `this.svc.alarms` exists
  - If available, schedule periodic recovery sweeps
  - Make it non-invasive (doesn't break if alarms not installed)

- [ ] **2.4**: Add tests
  - Unit tests for queue operations
  - Integration tests for recovery scenarios
  - Test with and without alarms installed

### Success Criteria
- Generic queue works independently
- Constructor recovery demonstrated in tests
- Works with and without alarms package
- Documented API

### Notes
- **Storage schema**: 
  - Inbound: `__lmz_inbound:{workType}:{ulid}:{workId}` (FIFO ordered)
  - Outbound: `__lmz_outbound:{workType}:{ulid}:{workId}` (FIFO ordered)
  - In-flight: `__lmz_outbound_inflight:{workType}:{workId}` (timeout tracking)
- **ULID instead of ISO 8601**: Cloudflare stops clock during processing, ULIDs provide monotonic ordering
- **Batch size**: Up to 100 items in constructor recovery (configurable via LMZ_CONFIG)
- **Alarm pattern**: Single 5-second alarms (not cron), naturally delete, reschedule if queue non-empty

---

## Phase 3: Update Proxy-Fetch

**Goal:** Integrate DurableQueue into FetchOrchestrator and restore guarantees

### Steps

- [ ] **3.1**: Update FetchOrchestrator to use DurableQueue
  - Replace manual `kv.put()` with queue.enqueue()
  - Add constructor recovery logic
  - Implement retry on dispatch failure

- [ ] **3.2**: Add FIFO ordering tests
  - Verify order preserved under load
  - Test recovery maintains order

- [ ] **3.3**: Add crash recovery tests
  - Simulate orchestrator crash
  - Verify requests recovered on restart
  - Test with and without alarms

- [ ] **3.4**: Update documentation
  - Document new crash-safe guarantees
  - Explain constructor vs. alarm recovery
  - Migration guide from old system

### Success Criteria
- All proxy-fetch tests pass
- FIFO ordering verified
- Crash recovery demonstrated
- No alarms dependency (optional only)

### Notes
- **Breaking change?**: Probably not if we keep the same external API
- **Migration**: Users upgrade, existing queued items recovered automatically

---

## Phase 4: Verify Alarms Hardening

**Goal:** Confirm alarms package already has proper crash recovery

### Steps

- [ ] **4.1**: Analyze alarms.ts storage patterns
  - How are scheduled alarms stored?
  - Constructor recovery present?
  - FIFO ordering for multiple alarms at same time?

- [ ] **4.2**: Review alarms tests
  - Do they test crash recovery?
  - Do they test alarm execution order?
  - Any gaps to address?

- [ ] **4.3**: Document findings
  - If hardened: Document patterns used
  - If gaps found: Create follow-up task to harden

### Success Criteria
- Clear understanding of alarms durability
- Documentation of any gaps
- Recommendation: OK as-is or needs hardening

---

## Phase 5: Prepare for Call System

**Goal:** Ensure DurableQueue ready for upcoming call system integration

### Steps

- [ ] **5.1**: Document call system queue requirements
  - How does call system differ from proxy-fetch?
  - Any additional queue operations needed?
  - Ordering guarantees: FIFO or other?

- [ ] **5.2**: Extend DurableQueue if needed
  - Add any missing operations
  - Ensure API flexible enough

- [ ] **5.3**: Create example integration
  - Minimal example showing call system queue usage
  - Document patterns for maintainers

### Success Criteria
- DurableQueue API confirmed sufficient for call system
- Example integration documented
- Ready for call system implementation

---

## Design Decisions

1. **Package location**: `@lumenize/lumenize-base` ✅
   - Needs access to `DurableObjectState` for storage
   - Can leverage LumenizeBase lifecycle hooks
   - Extract to core later if needed elsewhere

2. **Naming consistency**: ✅
   - Input queue: `__enqueueInbound` (was `__enqueueWork`)
   - Output queue: `__enqueueOutbound` (new)
   - Result handler: `__receiveInboundResult` (was `__receiveResult`)
   - Storage prefixes: `__lmz_inbound:`, `__lmz_outbound:`

3. **Timeout values**: Configurable via `LMZ_CONFIG`
   - Default: 5 seconds for proxy-fetch (fetches become stale fast)
   - Default: TBD for call system (depends on RPC patterns)

4. **Storage cleanup**: Immediately on `markComplete()` to avoid bloat ✅

5. **FIFO ordering**: ULID-based for both inbound and outbound ✅
   - Cloudflare clock behavior requires monotonic ULID
   - Already using `ulid-workers` in old system
   - Consistent ordering across evictions/crashes

6. **Alarm pattern**: Single 5-second alarms (not cron) ✅
   - Schedule next sweep only if queue non-empty
   - Naturally deletes when queue empty (no cleanup needed)
   - Constructor recovery handles missed sweeps

7. **Actor model**: Never await remote work completion ✅
   - Only await receipt confirmation (~5ms)
   - Remote callee calls back when work done
   - Avoids wall-clock billing trap (1000ms wait = 200x cost)

8. **Configuration pattern**:
   ```typescript
   // In LumenizeBase
   protected static LMZ_CONFIG = {
     outboundBatchSize: 100,
     outboundTimeout: 5000,  // 5 seconds
     inboundBatchSize: 100,
     // ...
   } as const;
   
   // Users override in subclass
   class MyDO extends LumenizeBase {
     protected static LMZ_CONFIG_OVERRIDES = {
       outboundTimeout: 10000,  // 10 seconds for my use case
     };
   }
   ```

## Related Files

- Current implementation: `/packages/proxy-fetch/src/FetchOrchestrator.ts` (line 133-134 TODO)
- Input queue: `/packages/lumenize-base/src/lumenize-base.ts` (line 128-192)
- Old system (deleted): `ProxyFetchDurableObject.ts` (in git history)
- Alarms source: `/packages/alarms/src/alarms.ts`
- Call system docs: `/website/docs/call/index.mdx` (needs API verification)
- Task command: `/task-management.md`

## Next Steps

**RECOMMENDATION: Pivot to API Work**

Before proceeding with hardening, we need to:
1. Understand how `$result` markers work in call system
2. Verify `executeOperationChain` signature and error handling
3. Test current call implementation end-to-end
4. Correct documentation if needed

**Suggested new task**: `call-system-api-verification.md`

Once API is clear, return to this task and complete Phase 1-5.

## Success Metrics

- [ ] Zero lost requests on DO crash/eviction
- [ ] FIFO ordering maintained under all conditions
- [ ] Works without alarms dependency
- [ ] Alarms integration provides proactive recovery (optional)
- [ ] Reusable by call system
- [ ] Test coverage >90% for recovery paths

