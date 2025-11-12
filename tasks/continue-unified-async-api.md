# Unified Async API for Durable Objects with OCAN

**Status**: Planning - Ready for Review
**Created**: 2025-11-11
**Updated**: 2025-11-12

## Objective

Unify async operations in Durable Objects using OCAN (Operation Chaining and Nesting) instead of string-based handlers. Replace string method names with type-safe operation chains across all async packages (alarms, Workers RPC, proxy-fetch), providing consistency, type safety, and powerful chaining/nesting capabilities.

**Core Principle**: All async work returns immediately (synchronous), executes elsewhere, then invokes a synchronous callback handler. Handlers are described via OCAN chains, not strings.

## Background

### The Problem

Current async packages use string-based handlers:
- `alarms.schedule(60, 'handleTask', payload)` - No type safety, no chaining
- Workers RPC requires `await` even for remote synchronous methods
- External API calls are expensive on DO wall-clock billing

### Key Insight from Cloudflare

Per [Cloudflare's DurableObjectState documentation](https://developers.cloudflare.com/durable-objects/api/state/#waituntil), `ctx.waitUntil()` does nothing in DOs. DOs automatically wait for ongoing work.

### Critical Constraint

**@lumenize/testing is already shipped** and being used by many people. It's a thin wrapper on `@lumenize/rpc`. We cannot break it.

## Chosen Approach: OCAN in Core, NADIS Everywhere

**Architecture**:

```
@lumenize/core (ENHANCED)
├── sql: SQL query builder (existing)
├── debug: Debugging utilities (existing)
└── ocan: OCAN infrastructure (NEW)
    ├── OperationProxy: Proxy-based operation builder
    ├── OperationChain: Operation sequence representation
    ├── executeOperationChain(): Server-side execution
    └── createContinuation<T>(): Factory for typed proxies

@lumenize/rpc (UNCHANGED - backward compatible)
├── Uses core's ocan
├── All existing APIs work unchanged
├── Downstream messaging preserved
└── @lumenize/testing continues to work!

@lumenize/alarms (REFACTORED)
├── Uses core's ocan
├── schedule(when, continuation) - NOT schedule(when, handler, payload)
└── NADIS: this.svc.alarms

@lumenize/call (NEW - Workers RPC)
├── Uses core's ocan
├── call(doBinding, instance, remote).onSuccess().onError()
└── NADIS: this.svc.call

@lumenize/proxy-fetch (REFACTORED)
├── Uses core's ocan
├── proxyFetch(request, options).onSuccess().onError()
└── NADIS: this.svc.proxyFetch
```

**Key Benefits**:
- ✅ No breaking changes to RPC or @lumenize/testing
- ✅ Unified OCAN mental model across all async operations
- ✅ Type-safe, refactoring-safe (no string method names)
- ✅ Powerful chaining and nesting (like RPC)
- ✅ NADIS pattern everywhere (consistent DX)
- ✅ OCAN in core (fundamental infrastructure, like sql)

## Example Usage

### @lumenize/alarms - Delayed Execution

```typescript
import '@lumenize/alarms';
import { LumenizeBase } from '@lumenize/lumenize-base';

class TaskSchedulerDO extends LumenizeBase<Env> {
  
  // Schedule a delayed task
  scheduleTask(taskName: string, delaySeconds: number) {
    const schedule = this.svc.alarms.schedule(
      delaySeconds,  // When to run
      this.svc.alarms.c().handleTask({ name: taskName })  // OCAN chain
    );
    return { scheduled: true, id: schedule.id };
  }

  // Schedule at specific time
  scheduleAt(taskName: string, timestamp: number) {
    const schedule = this.svc.alarms.schedule(
      new Date(timestamp),
      this.svc.alarms.c().handleTask({ name: taskName })
    );
    return { scheduled: true, id: schedule.id };
  }

  // Schedule recurring with cron
  scheduleDaily(taskName: string) {
    const schedule = this.svc.alarms.schedule(
      '0 0 * * *',  // Cron expression
      this.svc.alarms.c().handleDaily({ name: taskName })
    );
    return { scheduled: true, recurring: true, id: schedule.id };
  }

  // Advanced: chaining
  scheduleAdvanced(taskName: string) {
    const schedule = this.svc.alarms.schedule(
      60,
      this.svc.alarms.c()
        .processTask({ name: taskName })
        .logSuccess()
        .notifyUser()
    );
    return { scheduled: true, id: schedule.id };
  }

  // Cancel
  cancelTask(scheduleId: string) {
    this.svc.alarms.cancelSchedule(scheduleId);
  }

  // Handlers - synchronous
  handleTask(payload: { name: string }) {
    console.log('Executing task:', payload.name);
  }

  handleDaily(payload: { name: string }) {
    console.log('Daily task:', payload.name);
  }

  processTask(payload: { name: string }): string {
    console.log('Processing:', payload.name);
    return payload.name;
  }

  logSuccess() {
    console.log('Success!');
  }

  notifyUser() {
    console.log('User notified');
  }
}
```

### @lumenize/call - Workers RPC

```typescript
import '@lumenize/call';
import { LumenizeBase } from '@lumenize/lumenize-base';

class MyDO extends LumenizeBase<Env> {
  
  callRemoteDO(userId: string) {
    // Define what to call on remote DO (operation chain)
    const remote = this.svc.call.c<RemoteDO>()
      .getUserData(userId)
      .formatResponse();
    
    // Execute with success/error handlers
    const callId = this.svc.call(
      'REMOTE_DO',           // DO binding
      'user-session-123',    // Instance name/ID
      remote                 // What to execute
    )
    .onSuccess(this.svc.call.c().handleUserData(remote, { userId }))  // remote = result
    .onError(this.svc.call.c().handleError(remote, { userId }));      // remote = error
    
    return { callId };
  }

  // Advanced: nested operations
  callWithNesting(userId: string, orgId: string) {
    const remote = this.svc.call.c<RemoteDO>()
      .combineUserAndOrg(
        this.svc.call.c<RemoteDO>().getUserData(userId),  // Nested!
        this.svc.call.c<RemoteDO>().getOrgData(orgId)     // Nested!
      );
    
    const callId = this.svc.call('REMOTE_DO', 'main', remote)
      .onSuccess(this.svc.call.c().handleCombined(remote))
      .onError(this.svc.call.c().handleError(remote));
    
    return { callId };
  }

  // Cancel
  cancelCall(callId: string) {
    this.svc.call.cancel(callId);
  }

  // Handlers - synchronous
  handleUserData(userData: any, context: { userId: string }) {
    console.log('Got user data:', userData);
    if (!userData.valid) {
      throw new Error('Invalid user data');
    }
  }

  handleError(error: Error, context: { userId: string }) {
    console.error('Call failed for user:', context.userId, error);
  }

  handleCombined(combined: any) {
    console.log('Combined data:', combined);
  }
}
```

### @lumenize/proxy-fetch - External API Calls

```typescript
import '@lumenize/proxy-fetch';
import { LumenizeBase } from '@lumenize/lumenize-base';

class MyDO extends LumenizeBase<Env> {
  
  fetchExternalAPI(requestId: string) {
    // Initiate fetch
    const fetch = this.svc.proxyFetch(
      new Request('https://api.example.com/data', {
        method: 'POST',
        body: JSON.stringify({ query: 'example' })
      }),
      {
        timeout: 30000,
        maxRetries: 3,
        retryDelay: 1000
      }
    );
    
    // Attach handlers
    fetch
      .onSuccess(this.svc.proxyFetch.c().handleFetchSuccess(fetch, { requestId }))  // fetch = Response
      .onError(this.svc.proxyFetch.c().handleFetchError(fetch, { requestId }));     // fetch = Error
    
    return { fetchId: fetch.id };
  }

  // Simpler
  fetchSimple(url: string) {
    const fetch = this.svc.proxyFetch(new Request(url));
    
    fetch
      .onSuccess(this.svc.proxyFetch.c().handleResponse(fetch))
      .onError(this.svc.proxyFetch.c().handleError(fetch));
    
    return { fetchId: fetch.id };
  }

  // Cancel
  cancelFetch(fetchId: string) {
    this.svc.proxyFetch.cancel(fetchId);
  }

  // Handlers - synchronous
  handleFetchSuccess(response: Response, context: { requestId: string }) {
    console.log('Fetch succeeded:', response.status);
    
    // Response is deserialized via structured-clone
    const data = response.json();  // Synchronous!
    console.log('Data:', data, 'for request:', context.requestId);
  }

  handleFetchError(error: Error, context: { requestId: string }) {
    console.error('Fetch failed for request:', context.requestId, error);
  }

  handleResponse(response: Response) {
    console.log('Got response:', response.status);
  }

  handleError(error: Error) {
    console.error('Error:', error);
  }
}
```

## Key Design Patterns

### 1. OCAN Execution Built into LumenizeBase

LumenizeBase provides built-in OCAN execution capability via an internal `__executeChain()` method. This allows any DO extending LumenizeBase to be called via `this.svc.call()` without additional setup.

```typescript
// packages/lumenize-base/src/lumenize-base.ts
import { executeOperationChain, type OperationChain } from '@lumenize/core';

export abstract class LumenizeBase<Env = any> extends DurableObject<Env> {
  // ... NADIS proxy code ...

  /**
   * Internal: Execute an OCAN chain against this DO
   * 
   * Used by @lumenize/call to invoke methods on remote DOs.
   * You should not call this directly - it's invoked automatically
   * via Workers RPC when using this.svc.call().
   * 
   * @internal
   */
  async __executeChain(chain: OperationChain): Promise<any> {
    return executeOperationChain(this, chain);
  }
}
```

**Benefits**:
- ✅ Zero config - Any LumenizeBase DO can be called remotely
- ✅ No forgotten imports - It just works
- ✅ Consistent - All LumenizeBase DOs have same capabilities
- ✅ Clean UX - Extend LumenizeBase, get everything

**Usage**:
```typescript
// Local DO - initiates call
class LocalDO extends LumenizeBase<Env> {
  callRemote() {
    const remote = this.svc.call.c<RemoteDO>().getUserData(userId);
    this.svc.call('REMOTE_DO', 'instance', remote)
      .onSuccess(this.svc.call.c().handleSuccess(remote));
  }
}

// Remote DO - just extends LumenizeBase!
class RemoteDO extends LumenizeBase<Env> {
  getUserData(userId: string) {
    return { name: 'Alice', id: userId };  // Regular method
  }
}

// call() implementation uses Workers RPC:
// const result = await remoteStub.__executeChain(operationChain);
```

### 2. Remote Continuation as Placeholder

The operation chain you want to execute becomes the placeholder for its result:

```typescript
// Define what to call
const remote = this.svc.call.c<RemoteDO>().getUserData(userId);

// Use it as placeholder in handlers
this.svc.call('REMOTE_DO', 'instance', remote)
  .onSuccess(this.svc.call.c().handleSuccess(remote))  // remote = success result
  .onError(this.svc.call.c().handleError(remote));     // remote = error

// Implementation: remote's chainId is used to look up actual result
// when alarm fires and executes the handler
```

### 2. Success/Error Split

Only one handler fires, so we reuse the same placeholder:

```typescript
const remote = this.svc.call.c<RemoteDO>().riskyOperation();

this.svc.call('REMOTE_DO', 'instance', remote)
  .onSuccess(this.svc.call.c().handleSuccess(remote))  // remote populated with result
  .onError(this.svc.call.c().handleError(remote));     // remote populated with error
```

### 3. Consistent NADIS Pattern

All three packages use the same pattern:

```typescript
import '@lumenize/alarms';
import '@lumenize/call';
import '@lumenize/proxy-fetch';
import { LumenizeBase } from '@lumenize/lumenize-base';

class MyDO extends LumenizeBase<Env> {
  
  doAll() {
    // Alarm - delay then callback
    this.svc.alarms.schedule(
      60,
      this.svc.alarms.c().handleTimeout()
    );
    
    // Call - remote operation with success/error
    const remote = this.svc.call.c<RemoteDO>().someMethod();
    this.svc.call('REMOTE_DO', 'instance', remote)
      .onSuccess(this.svc.call.c().handleSuccess(remote))
      .onError(this.svc.call.c().handleError(remote));
    
    // ProxyFetch - HTTP request with success/error
    const fetch = this.svc.proxyFetch(new Request(url));
    fetch
      .onSuccess(this.svc.proxyFetch.c().handleResponse(fetch))
      .onError(this.svc.proxyFetch.c().handleError(fetch));
  }
}
```

## Rejected Alternatives

**String-based handlers**: `schedule('handler', payload)` - Simpler but loses type safety, refactoring safety, and powerful chaining/nesting.

**Separate operation-chain package**: Adds package sprawl. OCAN is fundamental infrastructure like `sql`, belongs in core.

**Generic continue() function**: Each async strategy has different parameters (alarms need `when`, call needs `doBinding`, etc.). Package-specific APIs are cleaner.

## Implementation Phases

### Phase 1: Add OCAN to Core

**Goal**: Extract OCAN from RPC, add to core without breaking anything.

**Steps**:
- [ ] Add OCAN infrastructure to `@lumenize/core`
  - [ ] Create `src/ocan/` directory
  - [ ] Extract OperationProxy from RPC
  - [ ] Extract OperationChain types
  - [ ] Extract executeOperationChain()
  - [ ] Extract operation serialization (uses structured-clone)
  - [ ] Add `createContinuation<T>()` factory
  - [ ] Export from `core/src/index.ts`
  - [ ] Add comprehensive tests

- [ ] Refactor RPC to use core's ocan
  - [ ] Import from `@lumenize/core`
  - [ ] NO API changes - purely internal refactor
  - [ ] Run full RPC test suite
  - [ ] Verify @lumenize/testing still works

**Success Criteria**:
- ✅ RPC API unchanged, all tests pass
- ✅ @lumenize/testing works unchanged
- ✅ Core OCAN has >80% branch coverage

### Phase 2: Refactor Alarms with OCAN

**Goal**: Replace string handlers with OCAN chains.

**Steps**:
- [ ] Update Alarms to use core's ocan
  - [ ] Import `createContinuation` from core
  - [ ] Add `.c()` factory method to Alarms class
  - [ ] Change `schedule()` signature: `schedule(when, continuation)`
  - [ ] Store operation chains in SQL (already handles via structured-clone)
  - [ ] Execute chains when alarm fires
  - [ ] Switch from nanoid to `crypto.randomUUID()`
  - [ ] Keep cron-schedule dependency

- [ ] Update tests
  - [ ] Migrate from string handlers to OCAN
  - [ ] Test chaining and nesting
  - [ ] Verify immediate alarms (delay <= 0)

**Success Criteria**:
- ✅ `this.svc.alarms.schedule(60, this.svc.alarms.c().handle())` works
- ✅ Chaining and nesting work
- ✅ All existing tests pass (with updated OCAN syntax)
- ✅ Test coverage >80% branch

### Phase 3: Create @lumenize/call

**Goal**: Workers RPC with OCAN and synchronous callbacks.

**Steps**:
- [ ] Update LumenizeBase with OCAN execution
  - [ ] Add `__executeChain(chain: OperationChain)` method to LumenizeBase
  - [ ] Import `executeOperationChain` from core
  - [ ] Mark as `@internal` in JSDoc
  - [ ] Test that remote DOs can execute chains

- [ ] Create `@lumenize/call` package
  - [ ] Package structure (src/, test/, etc.)
  - [ ] NADIS registration
  - [ ] Import ocan from core
  
- [ ] Implement call() function
  - [ ] `call(doBinding, instance, remote)` signature
  - [ ] Returns operation handle
  - [ ] `.onSuccess()` and `.onError()` chaining
  - [ ] Remote continuation as placeholder pattern
  
- [ ] Execute remote operations
  - [ ] Use Workers RPC to call `remoteStub.__executeChain(operationChain)`
  - [ ] Serialize operation chain via structured-clone
  - [ ] On success: schedule immediate alarm with result
  - [ ] On error: schedule immediate alarm with error
  - [ ] Placeholder replacement in handler chains
  
- [ ] Cancellation support
  - [ ] `call.cancel(callId)` function
  - [ ] Remove pending operation from storage
  
- [ ] Tests
  - [ ] Basic remote calls
  - [ ] Success/error handling
  - [ ] Nested operations
  - [ ] Timeout handling
  - [ ] Cancellation

**Success Criteria**:
- ✅ Remote DO calls with OCAN chains
- ✅ Synchronous handlers receive results
- ✅ Placeholder pattern works
- ✅ Error handling via `.onError()`
- ✅ Test coverage >80% branch

### Phase 4: Refactor Proxy-Fetch with OCAN

**Goal**: External API calls with OCAN and synchronous callbacks.

**Steps**:
- [ ] Update proxy-fetch to use core's ocan
  - [ ] Import from core
  - [ ] Add `.c()` factory method
  - [ ] Change signature: `proxyFetch(request, options)` returns handle
  - [ ] Add `.onSuccess()` and `.onError()` chaining
  - [ ] Fetch handle as placeholder pattern
  
- [ ] Update execution
  - [ ] On success: schedule immediate alarm with Response
  - [ ] On error: schedule immediate alarm with Error
  - [ ] Placeholder replacement
  
- [ ] Update tests
  - [ ] Migrate to OCAN syntax
  - [ ] Test success/error handlers
  - [ ] Verify retry logic still works

**Success Criteria**:
- ✅ `this.svc.proxyFetch(request).onSuccess().onError()` works
- ✅ Synchronous handlers receive Response/Error
- ✅ All existing functionality preserved
- ✅ Test coverage >80% branch

### Phase 5: Documentation

**Goal**: Comprehensive documentation for all three packages.

**Steps**:
- [ ] Update alarms documentation
  - [ ] Replace string examples with OCAN
  - [ ] Show chaining and nesting
  - [ ] Migration guide from old API
  
- [ ] Create call documentation
  - [ ] Overview and use cases
  - [ ] Basic usage examples
  - [ ] Nested operations
  - [ ] Error handling patterns
  
- [ ] Update proxy-fetch documentation
  - [ ] New OCAN syntax
  - [ ] Success/error handlers
  - [ ] Migration guide
  
- [ ] Core ocan documentation
  - [ ] What is OCAN
  - [ ] How it works
  - [ ] Used by: alarms, call, proxy-fetch, rpc
  
- [ ] Create doc-test examples
- [ ] Add TypeDoc API documentation

**Success Criteria**:
- ✅ Documentation following documentation-workflow.md
- ✅ Examples validated via check-examples
- ✅ TypeDoc API reference generated
- ✅ Migration guides for breaking changes

## Package Dependencies

### @lumenize/core
```json
{
  "dependencies": {
    "@lumenize/structured-clone": "*"  // For OCAN serialization
  }
}
```

### @lumenize/lumenize-base
```json
{
  "dependencies": {
    "@lumenize/core": "*"  // For OCAN execution (__executeChain) and NADIS
  }
}
```

### @lumenize/alarms
```json
{
  "dependencies": {
    "@lumenize/core": "*",           // For sql + ocan
    "cron-schedule": "^5.0.1"        // For cron parsing (keep)
    // Remove nanoid - use crypto.randomUUID()
  }
}
```

### @lumenize/call (NEW)
```json
{
  "dependencies": {
    "@lumenize/core": "*"  // For ocan
  }
}
```

### @lumenize/proxy-fetch
```json
{
  "dependencies": {
    "@lumenize/core": "*"  // For ocan
  }
}
```

## Success Criteria

### Must Have
- [ ] RPC unchanged, @lumenize/testing works
- [ ] OCAN in core, extracted from RPC
- [ ] Alarms refactored with OCAN
- [ ] Call package created with OCAN
- [ ] Proxy-fetch refactored with OCAN
- [ ] All handlers synchronous (no async/await)
- [ ] Type-safe handler names (TypeScript autocomplete)
- [ ] Chaining and nesting work
- [ ] Test coverage >80% branch, >90% statement
- [ ] Documentation following documentation-workflow.md
- [ ] Examples validated via check-examples

### Nice to Have
- [ ] Custom strategy plugin system
- [ ] Observability/debugging hooks
- [ ] Performance benchmarks

### Won't Have (Yet)
- ❌ Batching support (YAGNI for these use cases)
- ❌ Proxy-Fetch V3 architecture (separate task)

## Notes

### Why This Approach

- **OCAN in core**: Fundamental infrastructure like `sql`, used everywhere
- **OCAN in LumenizeBase**: Built-in `__executeChain()` method means any DO extending LumenizeBase can be called remotely via `this.svc.call()` without additional setup
- **NADIS everywhere**: Consistent DX across all packages
- **Package-specific APIs**: Each strategy has parameters that make sense for it
- **No breaking changes to RPC**: Testing package safe

### Separation of Concerns

- **RPC**: Browser ↔ DO communication (method calls + downstream messaging)
- **Alarms**: Delayed/scheduled callbacks
- **Call**: DO ↔ DO communication (Workers RPC)
- **ProxyFetch**: DO ↔ External API (offloaded to Workers for billing)
- **LumenizeClient**: Future bidirectional WebSocket messaging (see lumenize-client.md)

### Future: Proxy-Fetch V3

New proxy-fetch architecture using DO-based queue orchestrating Workers for fetches. Combines DO orchestration (better latency than Cloudflare Queues) with Worker execution (better scalability). Details in future `tasks/proxy-fetch-v3.md`.

## References

### Cloudflare Documentation
- [DurableObjectState - waitUntil()](https://developers.cloudflare.com/durable-objects/api/state/#waituntil)
- [Lifecycle of a Durable Object](https://developers.cloudflare.com/durable-objects/concepts/lifecycle/)

### Related Task Documents
- `tasks/lumenize-client.md` - Bidirectional WebSocket messaging
- Future: `tasks/proxy-fetch-v3.md` - New proxy-fetch architecture

### Existing Code to Reference
- `packages/rpc/` - OCAN implementation to extract
- `packages/alarms/src/alarms.ts` - Current alarms to refactor
- `packages/proxy-fetch/` - Current proxy-fetch to refactor

---

**Status**: Ready for review. Design is solid, ready to implement when approved.
