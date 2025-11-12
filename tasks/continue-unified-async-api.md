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
      this.svc.c().handleTask({ name: taskName })  // OCAN chain
    );
    return { scheduled: true, id: schedule.id };
  }

  // Schedule at specific time
  scheduleAt(taskName: string, timestamp: number) {
    const schedule = this.svc.alarms.schedule(
      new Date(timestamp),
      this.svc.c().handleTask({ name: taskName })
    );
    return { scheduled: true, id: schedule.id };
  }

  // Schedule recurring with cron
  scheduleDaily(taskName: string) {
    const schedule = this.svc.alarms.schedule(
      '0 0 * * *',  // Cron expression
      this.svc.c().handleDaily({ name: taskName })
    );
    return { scheduled: true, recurring: true, id: schedule.id };
  }

  // Advanced: chaining
  scheduleAdvanced(taskName: string) {
    const schedule = this.svc.alarms.schedule(
      60,
      this.svc.c()
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
    const remote = this.svc.c<RemoteDO>()
      .getUserData(userId)
      .formatResponse();
    
    // Execute with single handler (receives result OR error)
    const callId = this.svc.call(
      'REMOTE_DO',           // DO binding
      'user-session-123',    // Instance name/ID
      remote,                // What to execute
      this.svc.c().handleResult(remote, { userId })  // remote: UserData | Error
    );
    
    return { callId };
  }

  // Advanced: nested operations
  callWithNesting(userId: string, orgId: string) {
    const remote = this.svc.c<RemoteDO>()
      .combineUserAndOrg(
        this.svc.c<RemoteDO>().getUserData(userId),  // Nested!
        this.svc.c<RemoteDO>().getOrgData(orgId)     // Nested!
      );
    
    const callId = this.svc.call(
      'REMOTE_DO',
      'main',
      remote,
      this.svc.c().handleCombined(remote)
    );
    
    return { callId };
  }

  // Custom timeout
  callWithTimeout(userId: string) {
    const remote = this.svc.c<RemoteDO>().slowOperation(userId);
    
    const callId = this.svc.call(
      'REMOTE_DO',
      'instance',
      remote,
      this.svc.c().handleResult(remote, { userId }),
      { timeout: 60 }  // 60 seconds (default is 30)
    );
    
    return { callId };
  }

  // Cancel
  cancelCall(callId: string) {
    this.svc.call.cancel(callId);
  }

  // Handler - receives result OR error
  handleResult(result: UserData | Error, context: { userId: string }) {
    if (result instanceof Error) {
      console.error('Call failed for user:', context.userId, result);
      return;
    }
    
    // Success - TypeScript knows result is UserData here
    console.log('Got user data:', result);
    if (!result.valid) {
      throw new Error('Invalid user data');
    }
  }

  handleCombined(result: CombinedData | Error) {
    if (result instanceof Error) {
      console.error('Combined call failed:', result);
      return;
    }
    
    console.log('Combined data:', result);
  }
}
```

### @lumenize/proxy-fetch - External API Calls

```typescript
import '@lumenize/proxy-fetch';
import { LumenizeBase } from '@lumenize/lumenize-base';

class MyDO extends LumenizeBase<Env> {
  
  fetchExternalAPI(requestId: string) {
    // Single handler receives Response OR Error
    this.svc.proxyFetch(
      new Request('https://api.example.com/data', {
        method: 'POST',
        body: JSON.stringify({ query: 'example' })
      }),
      {
        timeout: 30000,
        maxRetries: 3,
        retryDelay: 1000
      },
      this.svc.c().handleResult(result, { requestId })  // result: Response | Error
    );
  }

  // Simpler
  fetchSimple(url: string) {
    this.svc.proxyFetch(
      new Request(url),
      {},  // Default options
      this.svc.c().handleResponse(result)  // result: Response | Error
    );
  }

  // Handler - receives Response OR Error
  handleResult(result: Response | Error, context: { requestId: string }) {
    if (result instanceof Error) {
      // Network/timeout error
      console.error('Fetch failed for request:', context.requestId, result);
      return;
    }
    
    // It's a Response - check HTTP status
    if (!result.ok) {
      console.error('HTTP error:', result.status, 'for request:', context.requestId);
      return;
    }
    
    // Success - Response is deserialized via structured-clone
    const data = result.json();  // Synchronous!
    console.log('Data:', data, 'for request:', context.requestId);
  }

  handleResponse(result: Response | Error) {
    if (result instanceof Error) {
      console.error('Network error:', result);
      return;
    }
    
    if (!result.ok) {
      console.error('HTTP error:', result.status);
      return;
    }
    
    console.log('Got response:', result.status);
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
    const remote = this.svc.c<RemoteDO>().getUserData(userId);
    this.svc.call('REMOTE_DO', 'instance', remote)
      .onSuccess(this.svc.c().handleSuccess(remote));
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

### 2. Generic Continuation Factory

The continuation factory `this.svc.c()` is a general NADIS service, not tied to any specific async strategy:

```typescript
class MyDO extends LumenizeBase<Env> {
  example() {
    // For operations on this DO (inferred type)
    this.svc.alarms.schedule(60, this.svc.c().handleTask());
    
    // For operations on remote DO (explicit type)
    const remote = this.svc.c<RemoteDO>().getUserData(userId);
    this.svc.call('REMOTE_DO', 'instance', remote)
      .onSuccess(this.svc.c().handleSuccess(remote));  // Back to this DO
  }
}
```

**Pattern**: Use `this.svc.c()` everywhere, with optional generic type when targeting remote DOs.

### 3. Single Handler with Result | Error Union

All async strategies use a single continuation parameter. Handlers receive the result OR error and check which:

```typescript
// Call - handler receives inferred type OR Error
const remote = this.svc.c<RemoteDO>().getUserData(userId);
this.svc.call('REMOTE_DO', 'instance', remote, 
  this.svc.c().handleResult(remote, context)  // remote: UserData | Error
);

handleResult(result: UserData | Error, context: any) {
  if (result instanceof Error) {
    console.error('Call failed:', result);
    return;
  }
  // TypeScript knows result is UserData here
  console.log('Got data:', result);
}

// ProxyFetch - handler receives Response OR Error
this.svc.proxyFetch(request, options,
  this.svc.c().handleResult(result)  // result: Response | Error
);

handleResult(result: Response | Error) {
  if (result instanceof Error) {
    console.error('Network error:', result);
    return;
  }
  if (!result.ok) {
    console.error('HTTP error:', result.status);
    return;
  }
  // Success
  const data = result.json();
}

// Alarms - no result, just executes
this.svc.alarms.schedule(60,
  this.svc.c().handleTask(payload)  // Just executes
);
```

**Benefits**:
- ✅ Consistent API across all three packages
- ✅ Type-safe: TypeScript infers the union type
- ✅ Flexible: Handler decides what's an error
- ✅ Clear pattern: Check `instanceof Error` first

### 4. Consistent NADIS Pattern

All three packages use the same pattern:

```typescript
import '@lumenize/alarms';
import '@lumenize/call';
import '@lumenize/proxy-fetch';
import { LumenizeBase } from '@lumenize/lumenize-base';

class MyDO extends LumenizeBase<Env> {
  
  doAll() {
    // Alarm - delay then callback (no result)
    this.svc.alarms.schedule(
      60,
      this.svc.c().handleTimeout()
    );
    
    // Call - remote operation (result | Error)
    const remote = this.svc.c<RemoteDO>().someMethod();
    this.svc.call('REMOTE_DO', 'instance', remote,
      this.svc.c().handleResult(remote)  // remote: any | Error
    );
    
    // ProxyFetch - HTTP request (Response | Error)
    this.svc.proxyFetch(new Request(url), {},
      this.svc.c().handleResponse(result)  // result: Response | Error
    );
  }
  
  // Handlers check instanceof Error
  handleResult(result: any | Error) {
    if (result instanceof Error) {
      console.error('Failed:', result);
      return;
    }
    console.log('Success:', result);
  }
  
  handleResponse(result: Response | Error) {
    if (result instanceof Error) {
      console.error('Network error:', result);
      return;
    }
    if (!result.ok) {
      console.error('HTTP error:', result.status);
      return;
    }
    console.log('Success');
  }
}
```

### 5. Actor Model Pattern for Call

The `call` strategy uses an **actor model** approach with two one-way calls rather than traditional request/response:

```
Origin DO                    Remote DO                     Origin DO (callback)
    │                            │                              │
    │ 1. Send message            │                              │
    ├──────────────────────────> │                              │
    │    { originId,             │ 2. Store in queue           │
    │      operationId,          │    Return immediately        │
    │      operationChain }      │                              │
    │                            │                              │
    │ 3. Await receipt only      │                              │
    │    (not execution)         │                              │
    │<───────────────────────────┤                              │
    │                            │                              │
    │ 4. Origin returns          │ 5. Process queue             │
    │    (wall-clock time        │    Execute OCAN chain        │
    │     minimized)             │    (async, in own time)      │
    │                            │                              │
    │                            │ 6. Send result back          │
    │                            ├──────────────────────────────>
    │                            │    { operationId, result }    │
    │                            │                               │
    │                            │                 7. Store result│
    │                            │                    Schedule    │
    │                            │                    immediate   │
    │                            │                    alarm       │
    │                            │                               │
    │ 8. Alarm fires             │                               │
    │    Handler executes        │                               │
```

**Benefits**:
- ✅ **Minimal wall-clock time** on origin DO (only await message delivery)
- ✅ **Fault tolerance** via persistent queue in storage
- ✅ **Decoupled execution** - remote DO processes in its own time
- ✅ **Consistent pattern** - just like WebSocket request/response with IDs
- ✅ **Actor model principles** - true asynchronous message passing

**Key Implementation Details**:
- Origin DO sends `this.ctx.id` so remote knows who to call back
- Remote DO stores message in `__call_queue:${operationId}` before confirming
- Remote DO processes queue asynchronously after confirmation
- Remote DO calls back to origin DO with result or error
- Origin DO receives callback, schedules immediate alarm with continuation

## Rejected Alternatives

**String-based handlers**: `schedule('handler', payload)` - Simpler but loses type safety, refactoring safety, and powerful chaining/nesting.

**Separate operation-chain package**: Adds package sprawl. OCAN is fundamental infrastructure like `sql`, belongs in core.

**Generic continue() function**: Each async strategy has different parameters (alarms need `when`, call needs `doBinding`, etc.). Package-specific APIs are cleaner.

**`.onSuccess()` / `.onError()` chaining**: Simplified to single continuation parameter with `Result | Error` union. Handlers check `instanceof Error` to distinguish.

## Implementation Phases

### Phase 1: Add OCAN to Core

**Goal**: Extract OCAN from RPC, add to core without breaking anything.

**Steps**:
- [ ] Add OCAN infrastructure to `@lumenize/core`
  - [ ] Create `src/ocan/` directory
  - [ ] Extract OperationProxy from RPC
  - [ ] Extract OperationChain types
  - [ ] Extract executeOperationChain()
  - [ ] Extract operation preprocessing/postprocessing (uses structured-clone for special types)
  - [ ] Note: Workers RPC and Queues handle actual serialization natively
  - [ ] Add `createContinuation<T>()` factory
  - [ ] Register `c` as NADIS service (via declaration merging)
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
- ✅ `this.svc.alarms.schedule(60, this.svc.c().handle())` works
- ✅ Chaining and nesting work
- ✅ All existing tests pass (with updated OCAN syntax)
- ✅ Test coverage >80% branch

### Phase 3: Create @lumenize/call

**Goal**: Workers RPC with OCAN and synchronous callbacks.

**Steps**:
- [ ] Update LumenizeBase with OCAN execution and call handling
  - [ ] Add `__executeChain(chain: OperationChain)` method
    - [ ] Import `executeOperationChain` from core
    - [ ] Execute operations in sequence, handle nesting
    - [ ] Return result (any type), throw on error
    - [ ] Mark as `@internal` in JSDoc
  - [ ] Add `__enqueueOperation(message: CallMessage)` method
    - [ ] Message contains: `{ originId, originBinding, operationId, operationChain }`
    - [ ] Store in storage: `__call_queue:${operationId}`
    - [ ] Confirm receipt immediately (return void)
    - [ ] Trigger `__processCallQueue()` asynchronously
  - [ ] Add `__processCallQueue()` internal method
    - [ ] Read all queued operations from storage (simple storage-based queue, NOT Cloudflare Queues)
    - [ ] For each: execute via `__executeChain()` (try/catch)
    - [ ] Call back to origin: `originStub.__receiveOperationResult()`
    - [ ] Remove from queue on success
    - [ ] Note: Storage-based queue avoids Cloudflare Queue latency and extra Worker hops
  - [ ] Add `__receiveOperationResult(message: ResultMessage)` method
    - [ ] Message contains: `{ operationId, result }` or `{ operationId, error }`
    - [ ] Cancel timeout alarm (retrieve and cancel from `__call_timeout:${operationId}`)
    - [ ] Store in storage: `__call_result:${operationId}`
    - [ ] Retrieve continuation from storage: `__call_continuation:${operationId}`
    - [ ] Schedule immediate alarm with continuation
  - [ ] Test that remote DOs can execute chains and call back

- [ ] Create `@lumenize/call` package
  - [ ] Package structure (src/, test/, etc.)
  - [ ] NADIS registration
  - [ ] Import ocan from core
  
- [ ] Implement call() function
  - [ ] `call(doBinding, instance, remote, continuation, options?)` signature
  - [ ] Options: `{ timeout?: number }` (default 30 seconds)
  - [ ] Generate operation ID: `crypto.randomUUID()`
  - [ ] Store continuation in storage: `__call_continuation:${operationId}`
  - [ ] Schedule timeout alarm, store alarm ID: `__call_timeout:${operationId}`
  - [ ] Send message to remote DO (await receipt only)
  - [ ] Returns operation ID for cancellation
  - [ ] Single continuation parameter (no chaining)
  - [ ] Remote continuation as placeholder pattern
  - [ ] Handler receives `InferredType | Error` union
  
- [ ] Execute remote operations (Actor Model - Two One-Way Calls)
  - [ ] Call 1: Origin → Remote (request)
    - [ ] Send message via Workers RPC to `remoteStub.__enqueueOperation()`
    - [ ] Message contains: `{ originId: this.ctx.id, originBinding: doBindingName, operationId, operationChain }`
    - [ ] Preprocess operation chain via structured-clone (Workers RPC handles serialization)
    - [ ] Only await confirmation that message was received (not execution)
  - [ ] Remote DO receives message
    - [ ] Store message in queue in storage (e.g., `__call_queue:${operationId}`)
    - [ ] Confirm receipt immediately (minimize caller wall-clock time)
    - [ ] Process queue asynchronously
    - [ ] Execute OCAN chain via `__executeChain(operationChain)`
    - [ ] Wrap execution in try/catch
  - [ ] Call 2: Remote → Origin (response)
    - [ ] Remote DO calls back to origin: `originStub.__receiveOperationResult()`
    - [ ] Message contains: `{ operationId, result }` or `{ operationId, error: Error }`
    - [ ] Postprocess result/error via structured-clone
  - [ ] Origin DO receives callback
    - [ ] Store result/error in storage
    - [ ] Schedule immediate alarm with continuation
    - [ ] Placeholder replacement: inject result or Error into continuation
    - [ ] Handler receives `InferredType | Error` and checks `instanceof Error`
  
- [ ] Timeout and cancellation support
  - [ ] Schedule timeout alarm when sending request (e.g., 30 seconds default)
  - [ ] If timeout fires before result received: call continuation with timeout Error
  - [ ] If result received before timeout: cancel timeout alarm
  - [ ] `call.cancel(callId)` function
    - [ ] Remove pending operation from storage
    - [ ] Cancel timeout alarm
    - [ ] Note: Can't cancel remote execution (already queued/running)
  
- [ ] Tests
  - [ ] Basic remote calls
  - [ ] Success/error handling
  - [ ] Nested operations
  - [ ] Timeout handling
  - [ ] Cancellation

**Success Criteria**:
- ✅ Remote DO calls with OCAN chains
- ✅ Single continuation handler receives `Result | Error`
- ✅ Placeholder pattern works (inferred type)
- ✅ Handlers check `instanceof Error` to distinguish
- ✅ TypeScript infers correct return type from operation chain
- ✅ Test coverage >80% branch

### Phase 4: Refactor Proxy-Fetch with OCAN

**Goal**: External API calls with OCAN and synchronous callbacks.

**Steps**:
- [ ] Update proxy-fetch to use core's ocan
  - [ ] Import from core
  - [ ] Change signature: `proxyFetch(request, options, continuation)`
  - [ ] Single continuation parameter (no chaining)
  - [ ] Handler receives `Response | Error` union
  
- [ ] Update execution
  - [ ] Note: Current implementation uses Cloudflare Queues or dedicated DO
  - [ ] Keep existing implementation for Phase 4 (just add OCAN support)
  - [ ] V3 architecture (DO-based queue + Workers) will be separate task
  - [ ] Preprocess Request via structured-clone
  - [ ] Wrap fetch in try/catch
  - [ ] On success (HTTP response received): postprocess Response, schedule immediate alarm
  - [ ] On error (network/timeout): schedule immediate alarm with Error
  - [ ] Handler checks `instanceof Error` first, then `response.ok`
  
- [ ] Update tests
  - [ ] Migrate to OCAN syntax
  - [ ] Test Response | Error handling
  - [ ] Verify retry logic still works
  - [ ] Test HTTP error responses (4xx, 5xx) arrive as Response

**Success Criteria**:
- ✅ `this.svc.proxyFetch(request, options, this.svc.c().handle(result))` works
- ✅ Handlers receive `Response | Error`
- ✅ Network errors become Error objects
- ✅ HTTP errors (4xx, 5xx) arrive as Response objects
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
  - [ ] Result | Error pattern explanation
  - [ ] Nested operations
  - [ ] TypeScript type inference examples
  
- [ ] Update proxy-fetch documentation
  - [ ] New OCAN syntax
  - [ ] Response | Error pattern (network vs HTTP errors)
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
    "@lumenize/structured-clone": "*"  // For preprocessing/postprocessing special types (Request, Response, etc.)
    // Note: Workers RPC and Queues handle actual serialization natively
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
- [ ] Generic continuation factory `this.svc.c()` registered by core
- [ ] LumenizeBase has `__executeChain()` built-in
- [ ] Alarms refactored with OCAN (single continuation, no result)
- [ ] Call package created (single continuation, `InferredType | Error`)
- [ ] Proxy-fetch refactored (single continuation, `Response | Error`)
- [ ] All handlers synchronous (no async/await)
- [ ] Handlers check `instanceof Error` to distinguish success/failure
- [ ] Type-safe: TypeScript autocompletes handler names and infers result types
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
- **Generic continuation factory**: `this.svc.c()` is a general NADIS service registered by core, not tied to any specific async strategy
- **NADIS everywhere**: Consistent DX across all packages
- **Package-specific APIs**: Each strategy has parameters that make sense for it
- **No breaking changes to RPC**: Testing package safe

### Continuation Factory Registration

The continuation factory is registered as a NADIS service by `@lumenize/core`:

```typescript
// packages/core/src/index.ts
import { createContinuation } from './ocan';

declare module '@lumenize/lumenize-base' {
  interface LumenizeServices {
    c: typeof createContinuation;  // Generic continuation factory
  }
}
```

This makes `this.svc.c()` available on any LumenizeBase DO without additional imports. The factory is generic and works with any DO type:

```typescript
// For operations on this DO (type inferred)
this.svc.c().myMethod()

// For operations on remote DO (type explicit)
this.svc.c<RemoteDO>().remoteMethod()
```

### Structured-Clone Usage

The `@lumenize/structured-clone` package is used for **preprocessing and postprocessing** complex objects, not for actual serialization:

- **Workers RPC**: Supports structured clone natively - pass objects directly
- **Storage-based queues**: We use storage (kv/sql) for queuing, not Cloudflare Queues
- **Structured-clone**: Preprocesses special types (Request, Response, Map, Set, circular refs) before sending, postprocesses after receiving
- **Why**: Platform handles serialization, structured-clone handles edge cases the platform doesn't support out of the box

Example flow:
1. Call: `preprocess(operationChain)` → Workers RPC + storage-based queue → `postprocess(operationChain)`
2. ProxyFetch: `preprocess(Request)` → Current implementation (Cloudflare Queue or DO) → Worker → `postprocess(Response)`

**Note**: We avoid Cloudflare Queues for call operations due to unpredictable latency and extra Worker hops. Instead, we use simple storage-based queues within DOs.

### Separation of Concerns

- **RPC**: Browser ↔ DO communication (method calls + downstream messaging)
- **Alarms**: Delayed/scheduled callbacks
- **Call**: DO ↔ DO communication (Workers RPC)
- **ProxyFetch**: DO ↔ External API (offloaded to Workers for billing)
- **LumenizeClient**: Future bidirectional WebSocket messaging (see lumenize-client.md)

### Future: Proxy-Fetch V3 (proxyFetchDOWorker)

**Current Implementations**:
- **proxyFetchDO**: DO → FetchDO → Original DO (two one-way calls, pure DO-to-DO)
- **proxyFetchQueue**: DO → Cloudflare Queue → Worker → Original DO (queue + worker, unpredictable latency)

**New V3 Architecture (proxyFetchDOWorker)**:
```
Original DO          FetchOrchestrator DO          Worker           Original DO (result)
    │                        │                        │                    │
    │ 1. Enqueue fetch       │                        │                    │
    ├───────────────────────>│                        │                    │
    │    (confirm receipt)   │ 2. Store in queue      │                    │
    │<───────────────────────┤    Return immediately  │                    │
    │                        │                        │                    │
    │                        │ 3. Assign to Worker    │                    │
    │                        ├───────────────────────>│                    │
    │                        │                        │                    │
    │                        │                        │ 4. Execute fetch   │
    │                        │                        │    (HTTP request)  │
    │                        │                        │                    │
    │                        │                        │ 5. Send result     │
    │                        │                        ├────────────────────>
    │                        │                        │   (direct to caller)│
    │                        │                        │                    │
    │                        │ 6. Report completion   │                    │
    │                        │<───────────────────────┤                    │
    │                        │    (update queue)      │                    │
```

**Benefits**:
- ✅ **Low latency**: FetchOrchestrator DO faster than Cloudflare Queue
- ✅ **Direct result delivery**: Worker → Original DO (no extra hops)
- ✅ **Scalability**: Workers handle actual fetches (billed on CPU time)
- ✅ **Work tracking**: Orchestrator maintains queue state
- ✅ **Two one-way call pattern**: Consistent with call architecture

**Key difference from call**: Workers do the actual work, orchestrator just manages the queue.

Details in future `tasks/proxy-fetch-v3.md`.

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
