# callRaw - RPC Call Infrastructure with Metadata Propagation

**Status**: Planning

## Objective

Create three-layer RPC architecture: identity abstraction (`this.lmz.*`), infrastructure (`callRaw`), and application pattern (`call`). Consolidate all RPC functionality into `@lumenize/lumenize-base`, supporting both DurableObjects and WorkerEntrypoints with consistent metadata propagation.

**Goals**:
1. **Identity abstraction** - Clean API hiding storage details
2. **Consistency** - Single envelope format, single implementation
3. **Worker support** - Full RPC capabilities for Worker Entrypoints
4. **Simplicity** - Delete `@lumenize/call`, reduce boilerplate
5. **Evolvability** - Versioned envelope for future enhancements

## Problem

- Manual envelope creation duplicated in `@lumenize/call` and `@lumenize/proxy-fetch`
- Direct storage access scattered throughout code (`ctx.storage.kv.get('__lmz_do_binding_name')`)
- No Worker support (only DOs can use current `call()`)
- Tests manually manipulate storage for initialization
- Adding metadata fields requires changes in multiple packages
- Problem repeats as we add more things like call and proxy-fetch

## Why Three Layers?

### Layer 0: this.lmz.* - Identity Abstraction
**Purpose**: Clean API for identity management. Consistent across Worker and DO implementations even though Workers don't have storage

**Used by**:
- Lumenize code (callRaw, call, __executeOperation, tests)
- Read by user code (logging, debugging, conditional logic)
- (less likely) written by user code except maybe bindingName in constructor

**Example**:
```typescript
// In constructor
constructor(ctx, env) {
  super(ctx, env);
  this.lmz.init({ bindingName: 'MY_DO' });  // Or wait for incoming call to set it
}

// Reading identity
console.log(`Called from ${this.lmz.bindingName} instance ${this.lmz.instanceNameOrId}`);

// Setting individual properties
this.lmz.bindingName = 'MY_DO';
this.lmz.instanceNameOrId = 'user-123';  // Smart: sets instanceName or id
```

### Layer 1: async this.lmz.callRaw() - Infrastructure
**Purpose**: Raw async RPC calls with metadata propagation

**Used by**:
- `this.lmz.call()` implementation internally
- NADIS plugins (`@lumenize/proxy-fetch`, `@lumenize/alarms`)
- Lumenize's own tests (simpler than continuation pattern)
- User code where you just want back the result and can use await

**Example**:
```typescript
// In LumenizeBase or LumenizeWorker
// Direct continuation (user-friendly)
const result = await this.lmz.callRaw(
  'REMOTE_DO', 
  'instance-123',
  this.ctn<RemoteDO>().getUserData(userId)
);
// result is fully postprocessed and ready to use
```

### Layer 2: this.lmz.call() - Application Pattern
**Purpose**: Non-blocking calls with continuation pattern

**Used by**:
- Application DOs/Workers that want fire-and-forget pattern
- Code that needs non-blocking execution
- Code following continuation-based async patterns

**Example (LumenizeBase - synchronous)**:
```typescript
this.lmz.call(
  'REMOTE_DO',
  'instance-123',
  this.ctn<RemoteDO>().getUserData(userId),
  this.ctn().handleResult(this.ctn<RemoteDO>().getUserData(userId))
);
// Returns immediately! Handler called when result arrives
```

**Example (LumenizeWorker - async)**:
```typescript
await this.lmz.call(
  'REMOTE_DO',
  'instance-123',
  this.ctn<RemoteDO>().getUserData(userId),
  this.ctn().handleResult(this.ctn<RemoteDO>().getUserData(userId))
);
// Awaits completion, then handler called with result/error
```

## Architecture

### Core Concepts

**Identity Abstraction (this.lmz.*)**:

Simple object with getters/setters (not a JS Proxy - properties are known and fixed):

```typescript
interface LmzApi {
  // Properties (getters/setters)
  bindingName?: string;         // DO: from storage, Worker: from private field
  instanceName?: string;        // DO: from storage, Worker: undefined
  id?: string;                  // DO: from ctx.id (read-only), Worker: undefined
  instanceNameOrId?: string;    // Smart getter/setter (uses isDurableObjectId)
  type: 'LumenizeBase' | 'LumenizeWorker';  // getter-only, returns class type
  
  // Methods
  init(options: { bindingName?: string, instanceNameOrId?: string }): void;
  call(...): void | Promise<void>;  // Async in LumenizeWorker
  callRaw(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    chainOrContinuation: OperationChain | Continuation<any>,
    options?: CallOptions
  ): Promise<any>;
}
```

**Implementation note**: `this.lmz` returns a simple object with getters/setters, not a JS Proxy. Proxy is unnecessary since the properties are fixed and known at design time. This keeps the implementation simple, debuggable, and performant. (Compare with `this.svc` which _is_ a Proxy because NADIS services are registered dynamically.)

**Envelope Format** (versioned for evolution):
```typescript
interface CallEnvelope {
  version: 1;  // For future evolution
  chain: any;  // Preprocessed operation chain
  metadata?: {
    caller: {
      type: 'LumenizeBase' | 'LumenizeWorker';
      bindingName?: string;            // From this.lmz.bindingName
      instanceNameOrId?: string;       // From this.lmz.instanceNameOrId
    };
    callee: {
      type: 'LumenizeBase' | 'LumenizeWorker';
      bindingName: string;             // Parameter to callRaw()
      instanceNameOrId?: string;       // Parameter to callRaw() (optional)
    };
  };
}
```

**Why both caller AND callee metadata?**
- **Caller metadata**: Tells callee who called it (for logging, callbacks)
- **Callee metadata**: Tells callee its own identity (auto-initialize if first call)
- **Key insight**: Caller always knows callee's full identity, but this makes sure callee will know its own going forward!

### this.lmz.callRaw() Implementation (Both Classes)

```typescript
// In LumenizeBase and LumenizeWorker
async callRaw(
  calleeBindingName: string,
  calleeInstanceNameOrId: string | undefined,
  chainOrContinuation: OperationChain | Continuation<any>,
  options?: CallOptions
): Promise<any> {
  // 1. Extract chain from Continuation if needed
  const chain = getOperationChain(chainOrContinuation) ?? chainOrContinuation;
  
  // 2. Gather caller metadata using this.lmz abstraction
  const callerMetadata = {
    type: this.lmz.type,
    bindingName: this.lmz.bindingName,
    instanceNameOrId: this.lmz.instanceNameOrId
  };
  
  // 3. Determine callee type
  const calleeType = calleeInstanceNameOrId ? 'LumenizeBase' : 'LumenizeWorker';
  
  // 4. Build metadata
  const metadata = {
    caller: callerMetadata,
    callee: {
      type: calleeType,
      bindingName: calleeBindingName,
      instanceNameOrId: calleeInstanceNameOrId
    }
  };
  
  // 5. Preprocess operation chain
  const preprocessedChain = await preprocess(chain);
  
  // 6. Create versioned envelope
  const envelope = {
    version: 1,
    chain: preprocessedChain,
    metadata
  };
  
  // 7. Get stub based on callee type
  let stub: any;
  if (calleeType === 'LumenizeBase') {
    // DO: Use getDOStub from @lumenize/utils
    stub = getDOStub(this.env[calleeBindingName], calleeInstanceNameOrId!);
  } else {
    // Worker: Direct access to entrypoint
    stub = this.env[calleeBindingName];
  }
  
  // 8. Send to remote and return postprocessed result
  return await stub.__executeOperation(envelope);
}
```

**Key implementation details**:
- **Accepts both**: Continuation (from `this.ctn()`) or OperationChain (for infrastructure code)
- **Parameter order**: Callee info first (who), then chain/continuation (what), then options (how)
- **Caller metadata**: Uses `this.lmz.*` abstraction (no direct storage access!)
- **Callee type**: Determined by presence of `calleeInstanceNameOrId`
- **Stub acquisition**: `getDOStub()` from @lumenize/utils for DOs, direct env access for Workers
- **Result**: Already postprocessed by receiver's `__executeOperation`

### __executeOperation() Receiver (Both Classes)

```typescript
// In LumenizeBase and LumenizeWorker
async __executeOperation(envelope: CallEnvelope): Promise<any> {
  // 1. Extract chain and metadata from envelope
  const preprocessedChain = envelope.chain;
  const metadata = envelope.metadata;
  
  // 2. Auto-initialize from callee metadata if present
  if (metadata?.callee) {
    this.lmz.init({
      bindingName: metadata.callee.bindingName,
      instanceNameOrId: metadata.callee.instanceNameOrId
    });
  }
  
  // 3. Postprocess and execute
  const operationChain = await postprocess(preprocessedChain);
  return await this.__executeChain(operationChain);
}
```

**Why callee metadata?**
- Callee metadata tells receiver "this is YOUR identity"
- Enables auto-propagation of identity across distributed graph of DOs and Workers
- Available for logging/debugging
- Available for callback when initiating its own future calls
- Uses `this.lmz.init()` convenience method (could also use individual setters)

### this.lmz.call() Implementation (LumenizeBase)

```typescript
// In LumenizeBase - synchronous wrapper around callRaw
call(
  calleeBindingName: string,
  calleeInstanceNameOrId: string | undefined,
  remoteContinuation: Continuation<T>,
  handlerContinuation: Continuation<this>,
  options?: CallOptions
): void {
  // 1. Extract operation chains from continuations
  const remoteChain = getOperationChain(remoteContinuation);
  const handlerChain = getOperationChain(handlerContinuation);
  
  if (!remoteChain) {
    throw new Error('Invalid remoteContinuation: must be created with this.ctn()');
  }
  if (!handlerChain) {
    throw new Error('Invalid handlerContinuation: must be created with this.ctn()');
  }
  
  // 2. Validate caller knows its own binding (fail fast!)
  if (!this.lmz.bindingName) {
    throw new Error(
      `Cannot use call() from a DO that doesn't know its own binding name. ` +
      `Call this.lmz.init({ bindingName }) in your constructor.`
    );
  }
  
  // 3. Use blockConcurrencyWhile for non-blocking async work
  this.ctx.blockConcurrencyWhile(async () => {
    try {
      // Call infrastructure layer
      const result = await this.lmz.callRaw(calleeBindingName, calleeInstanceNameOrId, remoteChain, options);
      
      // Substitute result into handler continuation
      const finalChain = replaceNestedOperationMarkers(handlerChain, result);
      
      // Execute handler locally
      await executeOperationChain(finalChain, this);
      
    } catch (error) {
      // Inject Error into handler continuation
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const finalChain = replaceNestedOperationMarkers(handlerChain, errorObj);
      
      // Execute handler with error
      await executeOperationChain(finalChain, this);
    }
  });
  
  // Returns immediately! Handler executes when result arrives
}
```

### this.lmz.call() Implementation (LumenizeWorker)

```typescript
// In LumenizeWorker - async version without blockConcurrencyWhile
async call(
  calleeBindingName: string,
  calleeInstanceNameOrId: string | undefined,
  remoteContinuation: Continuation<T>,
  handlerContinuation: Continuation<this>,
  options?: CallOptions
): Promise<void> {
  // 1. Extract operation chains from continuations
  const remoteChain = getOperationChain(remoteContinuation);
  const handlerChain = getOperationChain(handlerContinuation);
  
  if (!remoteChain) {
    throw new Error('Invalid remoteContinuation: must be created with this.ctn()');
  }
  if (!handlerChain) {
    throw new Error('Invalid handlerContinuation: must be created with this.ctn()');
  }
  
  // 2. No binding validation for Workers (optional for them)
  
  try {
    // Call infrastructure layer
    const result = await this.lmz.callRaw(calleeBindingName, calleeInstanceNameOrId, remoteChain, options);
    
    // Substitute result into handler continuation
    const finalChain = replaceNestedOperationMarkers(handlerChain, result);
    
    // Execute handler locally
    await executeOperationChain(finalChain, this);
    
  } catch (error) {
    // Inject Error into handler continuation
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const finalChain = replaceNestedOperationMarkers(handlerChain, errorObj);
    
    // Execute handler with error
    await executeOperationChain(finalChain, this);
  }
  
  // Awaits completion before returning
}
```

**Key differences**:
- **LumenizeBase**: Synchronous (void return), uses `blockConcurrencyWhile`
- **LumenizeWorker**: Async (Promise<void> return), natural async/await
- **Both**: Same continuation pattern, same error handling

## Implementation Phases

### Phase 1: Add this.lmz.* Infrastructure ✅

**Goal**: Create identity abstraction layer (this.lmz.*) with getters/setters and convenience methods.

**Success Criteria**:
- [x] Create `src/lmz-api.ts` with `LmzApi` interface
- [x] Implement `this.lmz` getter in LumenizeBase returning object with getters/setters
- [x] Not a JS Proxy - simple object since properties are known and fixed
- [x] Getters/setters for: `bindingName`, `instanceName`, `id`, `instanceNameOrId`, `type`
- [x] `bindingName` getter reads from storage, setter writes to storage with validation
- [x] `instanceName` getter reads from storage, setter writes to storage with validation
- [x] `id` getter returns `this.ctx.id?.toString()`, setter throws error
- [x] `instanceNameOrId` smart getter/setter using `isDurableObjectId()`
- [x] `type` getter returns `'LumenizeBase'`, no setter
- [x] `init({ bindingName?, instanceNameOrId? })` convenience method
- [x] Validation: setting bindingName twice with different values throws
- [x] Unit tests for all getters/setters
- [x] Tests for init() convenience method
- [x] JSDocs with links to website/docs/lumenize-base/call.mdx (no inline examples)

**Location**: `@lumenize/lumenize-base/src/lumenize-base.ts` and `src/lmz-api.ts`

**Why first**: Foundation for callRaw and call - they use this.lmz.* internally

**Status**: ✅ Complete - 76 tests passing, all validation working correctly

### Phase 2: Add this.lmz.callRaw() to LumenizeBase ✅

**Goal**: Implement `this.lmz.callRaw()` method using the identity abstraction.

**Success Criteria**:
- [x] TypeScript interface for `CallEnvelope` (versioned, caller+callee metadata)
- [x] `this.lmz.callRaw()` method on the LmzApi object
- [x] Signature: `(calleeBindingName, calleeInstanceNameOrId?, chainOrContinuation, options?)`
- [x] Accepts both Continuation (from `this.ctn()`) and OperationChain
- [x] Extracts chain using `getOperationChain()` if needed
- [x] Gathers caller metadata using `this.lmz.*` properties
- [x] Determines callee type from presence of `calleeInstanceNameOrId`
- [x] Uses `getDOStub()` from @lumenize/utils
- [x] Preprocesses chain, builds envelope, sends to remote
- [x] Returns postprocessed result (via basic __executeOperation receiver)
- [x] Unit tests for envelope structure
- [x] Tests verify caller+callee metadata correct
- [x] Tests for DO→DO calls
- [x] Tests with Continuation inputs
- [x] JSDocs with link to website/docs/lumenize-base/call.mdx

**Location**: `@lumenize/lumenize-base/src/lmz-api.ts`

**Status**: ✅ Complete - 87 tests passing, full metadata propagation working

**Note**: Added basic `__executeOperation()` receiver for Phase 2 testing. Phase 3 will enhance it with auto-initialization.

### Phase 3: Update __executeOperation Receiver ✅

**Goal**: Modify `__executeOperation` in LumenizeBase to handle versioned envelopes and auto-initialize using `this.lmz.init()`.

**Success Criteria**:
- [x] Accepts `CallEnvelope` (versioned envelope with metadata)
- [x] Extracts callee metadata from envelope
- [x] Calls `this.lmz.init()` with callee metadata before executing
- [x] Tests verify callee metadata → `this.lmz.init()` flow
- [x] Tests verify caller metadata available but not used for init
- [x] Old code calling with raw chains will fail (intentional - helps find what needs updating)
- [x] Envelope version validation (rejects non-v1 envelopes)
- [x] Clear error messages for unsupported versions

**Location**: `@lumenize/lumenize-base/src/lumenize-base.ts`

**Status**: ✅ Complete - 91 tests passing, auto-initialization and validation working

**Implementation**:
- Enhanced `__executeOperation()` to validate envelope version (must be v1)
- Extracts callee metadata and calls `this.lmz.init()` for auto-initialization
- Clear error messages for unsupported envelope versions
- Updated existing test to verify auto-initialization works end-to-end
- Added 4 new validation tests (no version, v2, v0, valid v1)

### Phase 4: Add this.lmz.call() to LumenizeBase ✅

**Goal**: Implement `this.lmz.call()` method using `this.lmz.callRaw()` internally.

**Success Criteria**:
- [x] Move `call()` logic from @lumenize/call to LumenizeBase
- [x] Implement as method on the LmzApi object
- [x] Signature: `(calleeBindingName, calleeInstanceNameOrId?, remoteContinuation, handlerContinuation, options?)`
- [x] Uses `this.lmz.callRaw()` internally
- [x] Extracts chains from continuations
- [x] Validates `this.lmz.bindingName` exists (fail fast)
- [x] Uses `blockConcurrencyWhile` for non-blocking execution
- [x] Error handling with Error injection
- [x] All tests pass (10 new tests covering all scenarios)
- [x] JSDocs with link to website/docs/lumenize-base/call.mdx

**Location**: `@lumenize/lumenize-base/src/lmz-api.ts`

**Status**: ✅ Complete - 101 tests passing, full continuation pattern working

**Implementation**:
- Added `call()` method to LmzApi interface and implementation
- Synchronous signature (returns void immediately)
- Validates caller knows `bindingName` before proceeding
- Extracts chains from both remote and handler continuations
- Uses `blockConcurrencyWhile` to execute async work without blocking
- Calls `this.callRaw()` for actual RPC
- Substitutes result/error into handler continuation using `replaceNestedOperationMarkers`
- Executes handler locally on DO instance using `executeOperationChain`
- Added 10 new tests covering:
  - Basic DO→DO calls with result handling
  - Synchronous return behavior
  - Metadata propagation
  - Error handling (remote errors caught and handled)
  - Validation (bindingName required, invalid continuations caught)
  - Continuation marker substitution (result and error injection)

### Phase 5: Create LumenizeWorker Class ✅

**Goal**: Create WorkerEntrypoint base class with full call support.

**Success Criteria**:
- [x] `LumenizeWorker` class created
- [x] Extends `WorkerEntrypoint` from Cloudflare
- [x] `this.lmz` getter returning object with getters/setters (not a Proxy)
- [x] Same structure as LumenizeBase but identity stored in closure (not storage)
- [x] `this.lmz.type` returns `'LumenizeWorker'`
- [x] `this.lmz.bindingName` stored in closure variable (not persisted)
- [x] `this.lmz.instanceName`, `this.lmz.id`, and `this.lmz.instanceNameOrId` silently ignore sets, return undefined on get
- [x] `this.lmz.callRaw()` method (same signature as LumenizeBase)
- [x] `this.lmz.call()` method (async version, no blockConcurrencyWhile)
- [x] `this.ctn()` method for creating continuations
- [x] `__executeOperation()` receiver implemented
- [x] TestWorker class added for future integration testing
- [x] JSDocs with link to website/docs/lumenize-base/call.mdx

**Location**: `@lumenize/lumenize-base/src/lumenize-worker.ts`

**Status**: ✅ Complete - 120 tests passing (101 previous + 19 new Worker tests)

**Implementation**:
- Created `createLmzApiForWorker()` factory function using closure for identity storage
- Identity stored in closure variable (ephemeral, not persisted like DOs)
- Instance-related properties (instanceName, id, instanceNameOrId) always undefined and silently ignore sets
- `callRaw()` implementation identical to LumenizeBase
- `call()` is async (returns Promise<void>) instead of sync (Workers don't have blockConcurrencyWhile)
- Auto-initialization from envelope metadata works same as LumenizeBase
- Exported from `@lumenize/lumenize-base/src/index.ts`
- Added Worker service binding (`TEST_WORKER`) to `wrangler.jsonc`
- Created comprehensive unit tests (19 new tests) validating Worker functionality

**Testing Details**: 
- Pattern for testing WorkerEntrypoints in vitest-pool-workers: use `services` array in `wrangler.jsonc` with `entrypoint` field
- Tests access Workers via `env.TEST_WORKER` service binding
- Tests validate identity management, continuation support, envelope validation, and method execution
- **Important**: Workers are stateless - each RPC call creates new instance, so tests focus on within-call behavior
- Full RPC flow (Worker-to-Worker, DO-to-Worker) will be validated in integration tests (Phase 7)

### Phase 6: Delete @lumenize/call Package ✅

**Goal**: Remove obsolete @lumenize/call package and migrate all code.

**Success Criteria**:
- [x] Move remaining utilities (if any) to lumenize-base
- [x] Delete `packages/call/` directory
- [x] Update all imports across codebase
- [x] Move tests to `packages/lumenize-base/test/call.test.ts`
- [x] Move doc-tests to appropriate location
- [x] All tests still pass
- [x] No references to @lumenize/call remain

**Status**: ✅ Complete - 120 tests passing

**Implementation Summary**:
- Deleted `packages/call/` directory entirely (functionality now in `@lumenize/lumenize-base`)
- Deleted `website/docs/call/` directory
- Removed `import '@lumenize/call'` from `packages/proxy-fetch/test/test-worker-and-dos.ts`
- Updated all JSDoc comments to use `this.lmz.call()` instead of `@lumenize/call` or `this.svc.call()`
- Updated documentation links in `website/docs/alarms/index.mdx` and `website/docs/core/continuations.mdx`
- Removed obsolete `__processCallQueue()` method from `LumenizeBase` (no longer needed)
- Verified zero references to `@lumenize/call` remain in packages directory

**Impact**: One less package to maintain, simpler architecture

### Phase 7: Refactor @lumenize/proxy-fetch ✅

**Goal**: Update proxy-fetch to use CallEnvelope pattern with metadata.

**Success Criteria**:
- [x] Update to use LumenizeBase (extend it)
- [x] `FetchOrchestrator` → Origin DO uses envelope-based pattern
- [x] `FetchExecutor` → Origin DO uses envelope-based pattern
- [x] Remove manual metadata handling
- [x] All existing tests pass
- [x] Verify metadata flows correctly in timeout scenarios

**Status**: ✅ Complete - 8 tests passing

**Implementation Summary**:
- **Updated Origin → FetchOrchestrator** - `proxyFetch()` now uses `this.lmz.callRaw()`
  - Creates continuation for `enqueueFetch(message)`
  - Automatic metadata propagation!
- **Updated FetchOrchestrator → Origin** - `#sendTimeoutToOrigin()` now uses `this.lmz.callRaw()`
  - Sends timeout error via callRaw (not manual envelope)
  - Automatic metadata propagation!
- **Updated Worker → Origin** - `executeFetch()` now uses `worker.lmz.callRaw()`
  - Changed `FetchExecutorEntrypoint` to extend `LumenizeWorker` (instead of `WorkerEntrypoint`)
  - Passes worker instance to `executeFetch()` function
  - Uses `worker.lmz.callRaw()` to send results (not manual envelope)
  - Automatic metadata propagation!
- Updated `proxyFetch()` to use `doInstance.lmz.bindingName` instead of reading from storage directly
- Updated NADIS wrapper to enforce `LumenizeBase` type (not `any`)
- Updated test file to use `this.lmz.init()` instead of `__lmzInit()`
- Updated JSDoc examples to show new API pattern

**Critical Achievement**: **ZERO manual envelope construction!** Every RPC call now goes through `call` or `callRaw`, ensuring consistent metadata propagation and avoiding the error-prone manual patterns that caused issues in previous versions.

**API Design Validation**: The refactoring proved that `this.lmz.callRaw()` works for ALL RPC scenarios:
- DO → DO (LumenizeBase to LumenizeBase)
- Worker → DO (LumenizeWorker to LumenizeBase)  
- Error handling paths (orchestrator sending timeouts)
- Success paths (worker sending results)

The API is complete - no need for "Layer 1" manual envelope construction in application code. Manual envelopes only exist inside the implementation of `callRaw` itself.

**Type Safety Improvement**: 
- Changed `proxyFetch()` signature from accepting `DurableObject` to requiring `LumenizeBase`
- Changed NADIS wrapper registration from `(doInstance: any)` to `(doInstance: LumenizeBase)`
- Enforces type requirement at both wrapper level (NADIS) and function level
- Removed all TypeScript casts (`(doInstance as any)`)
- Makes the requirement explicit: to use `call`/`callRaw`/`proxyFetch`, you must extend `LumenizeBase` or `LumenizeWorker`
- No generic `DurableObject` support - this is intentional (no NADIS modules outside LumenizeBase/LumenizeWorker)

**Locations**:
- `proxyFetch.ts` - Origin DO → FetchOrchestrator (uses `this.lmz.callRaw()`, requires `LumenizeBase`)
- `FetchOrchestrator.ts` - Orchestrator → Origin DO (uses `this.lmz.callRaw()`)
- `FetchExecutorEntrypoint.ts` - Now extends `LumenizeWorker` instead of `WorkerEntrypoint`
- `workerFetchExecutor.ts` - Worker → Origin DO (uses `worker.lmz.callRaw()`)
- `index.ts` - NADIS wrapper now enforces `LumenizeBase` type at wrapper level

### Phase 8: Delete `__lmzInit()` ✅

**Goal**: Remove deprecated `__lmzInit()` method since nothing has been released yet.

**Success Criteria**:
- [x] Delete `__lmzInit()` method from `LumenizeBase`
- [x] Delete test helper `testLmzInit()` from test DOs
- [x] Delete all 13 `__lmzInit()` tests
- [x] Update JSDoc references from `__lmzInit()` to `this.lmz.init()`
- [x] Update actual code references in `__initFromHeaders()`
- [x] All remaining tests still pass

**Status**: ✅ Complete - 107 tests passing (13 tests deleted, no longer needed)

**Implementation Summary**:
- **Deleted `__lmzInit()` method** - Removed entire method from `LumenizeBase` (lines 436-527)
- **Updated `__initFromHeaders()`** - Changed from calling `this.__lmzInit()` to `this.lmz.init()`
- **Updated JSDoc** - Changed `__lmzInit()` references to `this.lmz.init()` in comments
- **Updated proxy-fetch** - Changed JSDoc example to use `this.lmz.init()` instead of `this.__lmzInit()`
- **Deleted test helper** - Removed `testLmzInit()` method from test DOs
- **Deleted 13 tests** - Removed entire `__lmzInit() - DO Metadata Initialization` test suite
- **Deleted integration tests** - Removed "Integration with __lmzInit()" test section

**Findings**:
- No application code was using `__lmzInit()` - only tests
- Storage key references (`__lmz_do_binding_name`, `__lmz_do_instance_name`) only in implementation and test helpers (intentional)
- Clean break: nothing to deprecate since nothing released yet

**Impact**: Cleaner API surface, no backward compatibility burden, tests reduced from 120 to 107.

## Design Decisions

### 1. Package location and inheritance

**Decision**: Bake everything into `@lumenize/lumenize-base` as methods on LumenizeBase and LumenizeWorker classes.

**Rationale**: Inheritance over composition prevents foot-guns. Delete `@lumenize/call` package entirely. Composition approach considered but rejected - easier to misuse, more complex.

### 2. Validation strategy

**Decision**: No validation in `callRaw()`, strict validation in `call()`.

**Rationale**: Infrastructure layer (`callRaw`) fails gracefully for testing flexibility. Application layer (`call`) fails fast with clear errors. DOs using `call()` must have `bindingName` set.

### 3. Envelope format

**Decision**: Versioned envelope (`version: 1`) with caller + callee metadata. Caller metadata enables logging/callbacks. Callee metadata enables auto-propagation of identity (receiver learns its own identity).

**Future evolution**: `requestId`, `traceId`, `timeout`, `retryCount` fields can be added. Version field enables non-breaking additions.

### 4. Type detection

**Decision**: Caller type determined by class (`this.lmz.type` getter returns `'LumenizeBase'` or `'LumenizeWorker'`). Callee type inferred from parameters (`calleeInstanceNameOrId` present → DO, absent → Worker).

## Success Metrics

**Observable outcomes**:
- All RPC calls use single envelope format
- No direct storage access for identity (use `this.lmz.*`)
- Tests simplified (use `this.lmz.init()` instead of storage manipulation)
- `@lumenize/call` package deleted
- >90% branch coverage on new code
- Zero regressions in existing tests

**Not in scope**:
- Timeout handling (caller's responsibility)
- Retry logic (separate concern)
- Custom metadata fields (future enhancement)
- Chain validation (receiver's job)

## Package Changes Required

### @lumenize/lumenize-base (Major Updates)

**New files**:
- `src/lumenize-worker.ts` - LumenizeWorker class for Worker Entrypoints
- `src/types.ts` - `CallEnvelope` interface and RPC types
- `test/call.test.ts` - Tests migrated from @lumenize/call
- `test/call-raw.test.ts` - Tests for callRaw infrastructure
- `test/lumenize-worker.test.ts` - Tests for Worker class

**Updated files**:
- `src/lumenize-base.ts` - Add `callRaw()`, `call()`, `__executeOperation()` with envelope handling
- `src/index.ts` - Export LumenizeWorker and RPC types
- `package.json` - Dependencies already include @lumenize/structured-clone and @lumenize/utils

**Existing dependencies (already present)**:
- `@lumenize/structured-clone` (for preprocess/postprocess)
- `@lumenize/utils` (for getDOStub)

### @lumenize/call (Delete Entire Package)

**Actions**:
- Delete entire `packages/call/` directory
- Migrate tests to `packages/lumenize-base/test/`
- Migrate doc-tests to appropriate location
- Update all imports across codebase

**Files to migrate**:
- `test/call.test.ts` → `packages/lumenize-base/test/call.test.ts`
- `test/for-docs/` → TBD based on structure
- Delete: `src/call.ts`, `src/execute-operation-handler.ts`, `src/types.ts`, `src/index.ts`

### @lumenize/proxy-fetch

**Updated files**:
- `src/workerFetchExecutor.ts` - Use `this.callRaw()` (extend LumenizeBase)
- `src/FetchOrchestrator.ts` - Use `this.callRaw()` (extend LumenizeBase)
- Remove manual metadata handling code
- `package.json` - Remove `@lumenize/call` dependency (now use @lumenize/lumenize-base which is already a dep)

**No new dependencies needed** - Already depends on @lumenize/lumenize-base

### Tests affected (Phase 7 - Opportunistic)

**Will need updates**:
- `packages/rpc/test/downstream-messaging.test.ts` - Use callRaw instead of manual __lmzInit
- `packages/rpc/test/test-worker-and-dos.ts` - Use callRaw where appropriate
- `packages/proxy-fetch/test/` - Verify still works after refactor
- `doc-test/rpc/*` - Update any that used @lumenize/call

**Import changes**:
```typescript
// Old
import { call } from '@lumenize/call';

// New
import { LumenizeBase } from '@lumenize/lumenize-base';
// Use: this.call() or this.callRaw()
```

## Summary: What We're Building

### Three-Layer RPC System

**Layer 0: this.lmz.* - Identity Abstraction**
- Properties: `bindingName`, `instanceName`, `id`, `instanceNameOrId`, `type`
- Getters/setters abstract storage details
- Validation prevents accidental changes
- Convenience: `init({ bindingName, instanceNameOrId })`
- Works consistently in both LumenizeBase and LumenizeWorker

**Layer 1: this.lmz.callRaw() - Infrastructure**
- Public async method on both LumenizeBase and LumenizeWorker
- Parameters: `(calleeBindingName, calleeInstanceNameOrId?, chainOrContinuation, options?)`
- Accepts both Continuation (from `this.ctn()`) and OperationChain
- Returns fully postprocessed result
- Builds envelope with caller + callee metadata using `this.lmz.*`
- Works for all combinations: DO↔DO, DO↔Worker, Worker↔DO, Worker↔Worker

**Layer 2: this.lmz.call() - Application Pattern**  
- LumenizeBase: Synchronous (void), uses `blockConcurrencyWhile`
- LumenizeWorker: Async (Promise<void>), natural async/await
- Parameters: `(calleeBindingName, calleeInstanceNameOrId?, remoteContinuation, handlerContinuation, options?)`
- Continuation pattern: handler receives result or Error
- Internally uses `this.lmz.callRaw()`

### Key Benefits

1. **Clean abstraction**: `this.lmz.*` hides storage/closure details
2. **Consistency**: Single envelope format everywhere
3. **Auto-initialization**: Callees learn their identity via `this.lmz.init()`
4. **Simpler tests**: `this.lmz.init({ bindingName: 'TEST' })` instead of storage manipulation
5. **Worker support**: LumenizeWorker class with full RPC capabilities
6. **Clear layers**: Identity (lmz.*) → Infrastructure (callRaw) → Application (call)
7. **Evolvable**: Versioned envelope, easy to add fields
8. **Less boilerplate**: Our code and user code both benefit

### Architecture Wins

- **Inheritance over composition**: Just extend LumenizeBase or LumenizeWorker
- **Delete @lumenize/call**: Consolidate into lumenize-base
- **Shared infrastructure**: Both classes use same `this.lmz.*` abstraction
- **Type safety**: TypeScript interfaces prevent mistakes
- **Namespaced API**: `this.lmz.*` clearly signals Lumenize infrastructure

## Next Steps

1. ✅ **Document reviewed and updated** with final architecture
2. **Get maintainer approval** on:
   - Three-layer system (this.lmz.* → callRaw → call)
   - `this.lmz.*` identity abstraction (getters/setters/init)
   - Namespaced API (`this.lmz.call` and `this.lmz.callRaw`)
   - Parameter order (callee info first, then payload)
   - LumenizeWorker with async `call()` and `ctn()`
   - Deleting @lumenize/call package
   - Caller + callee metadata structure
3. **Proceed with Phase 1** (Add this.lmz.* infrastructure)

Ready to start implementation!

