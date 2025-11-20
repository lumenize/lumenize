# ProxyFetch: Timeout Monitoring & Idempotency

**Status**: Design Complete, Ready for Implementation  
**Design Document**: `/website/docs/proxy-fetch/architecture-and-failure-modes.mdx`

## Goal

Implement robust timeout monitoring and idempotency for `@lumenize/proxy-fetch` with a clear separation of concerns:
- **Orchestrator = Timeout Watchdog Only** (dispatch once, monitor timeout)
- **Origin = Retry Decision Maker** (examines results, controls retry logic)

## Design Principles (See MDX for Details)

1. **Orchestrator dispatches once**: No retry logic at Orchestrator level
2. **Orchestrator monitors timeout**: Sends timeout error if no delivery confirmation
3. **Origin handles idempotency**: First result wins, duplicates logged as errors
4. **Origin controls retries**: Examines Error/Response, decides if/when to retry
5. **Timeout ambiguity**: Timeout doesn't mean fetch didn't execute - warn user!

## Prerequisites

- ✅ RPC refactor complete (using `ctx.waitUntil`)
- ✅ Design documented in MDX
- ✅ Error categorization clarified

## Implementation Phases

### Phase 1: Idempotent Result Handler in LumenizeBase

**Goal**: Prevent duplicate result processing from race conditions.

**Changes to `lumenize-base/src/lumenize-base.ts`**:

```typescript
async __receiveResult(handlerType: string, reqId: string, resultData: any): Promise<void> {
  const log = debug(this.ctx)('lmz.base.receiveResult');
  
  // Check if we've already processed this reqId
  const processedKey = `__lmz_result_processed:${handlerType}:${reqId}`;
  const alreadyProcessed = this.ctx.storage.kv.get(processedKey);
  
  if (alreadyProcessed) {
    log.error('Duplicate result received - race condition detected', {
      reqId,
      handlerType,
      firstProcessedAt: alreadyProcessed,
      duplicate: 'Race between successful delivery and timeout'
    });
    return; // IGNORE duplicate
  }
  
  // Mark as processed BEFORE executing continuation (prevents race)
  this.ctx.storage.kv.put(processedKey, Date.now());
  
  // Get pending continuation
  const pendingKey = `__lmz_${handlerType}_pending:${reqId}`;
  const pendingData = this.ctx.storage.kv.get(pendingKey);
  
  if (!pendingData) {
    log.warn('No pending continuation found', { reqId, handlerType });
    return;
  }
  
  // Execute continuation
  const handler = (globalThis as any).__lumenizeResultHandlers?.[handlerType];
  if (!handler) {
    log.error('No result handler registered', { handlerType });
    return;
  }
  
  try {
    await handler(this, reqId, resultData);
  } catch (error) {
    log.error('Continuation execution failed', {
      reqId,
      handlerType,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  }
  
  // Clean up pending continuation
  this.ctx.storage.kv.delete(pendingKey);
  
  // Clean up processed marker after 5 minutes (prevents storage bloat)
  // Note: This uses setTimeout which is OK in this context because it's
  // a storage cleanup, not critical to correctness
  setTimeout(() => {
    this.ctx.storage.kv.delete(processedKey);
  }, 5 * 60 * 1000);
}
```

**Tests**:
- ✅ Normal result processing works
- ✅ Duplicate result is logged as error and ignored
- ✅ Processed marker is cleaned up after 5 minutes
- ✅ Missing continuation is handled gracefully
- ✅ Missing handler is handled gracefully

### Phase 2: Delivery Confirmation in Executor ✅

**Status**: COMPLETE

**Goal**: Report delivery status (delivered/failed_to_deliver) to Orchestrator for monitoring and queue cleanup.

**Changes to `proxy-fetch/src/workerFetchExecutor.ts`**:

```typescript
import { ResponseSync } from '@lumenize/structured-clone';

export async function executeFetch(message: WorkerFetchMessage, env: any): Promise<void> {
  const log = debug({ env })('lmz.proxyFetch.worker');
  
  // Execute fetch (success or error)
  let responseSync: ResponseSync | undefined;
  let error: Error | undefined;

  try {
    const request = await postprocess(message.request) as Request;
    // Use fetchTimeout from message (set by Orchestrator based on user's options.timeout)
    const timeout = message.fetchTimeout ?? 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(request, { signal: controller.signal });
      clearTimeout(timeoutId);
      log.debug('Fetch completed', { reqId: message.reqId, status: response.status });
      
      // CRITICAL: Convert Response to ResponseSync (read body now, so handler can be sync)
      // Handler can't do await response.json() because handlers are synchronous
      // ResponseSync.fromResponse() reads body based on Content-Type and stores it
      responseSync = await ResponseSync.fromResponse(response);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
    log.error('Fetch failed', { reqId: message.reqId, error: error.message });
  }

  // Prepare result
  const result: FetchResult = {
    reqId: message.reqId,
    response: responseSync ? await preprocess(responseSync) : undefined,
    error,
    retryCount: message.retryCount,
    duration: Date.now() - message.startTime
  };

  // Try to deliver to Origin
  let deliverySuccessful = false;
  try {
    const originId = env[message.originBinding].idFromString(message.originId);
    const originDO = env[message.originBinding].get(originId);
    
    const preprocessedResult = await preprocess(result);
    await originDO.__receiveResult('proxyFetch', message.reqId, preprocessedResult);
    
    deliverySuccessful = true;
    log.debug('Result delivered to origin DO', { reqId: message.reqId });
  } catch (deliveryError) {
    log.error('Failed to deliver result to origin DO', {
      reqId: message.reqId,
      error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError)
    });
  }

  // Report delivery status to orchestrator (for monitoring and queue cleanup)
  try {
    const orchestratorId = env.FETCH_ORCHESTRATOR.idFromName('singleton');
    const orchestrator = env.FETCH_ORCHESTRATOR.get(orchestratorId);
    await orchestrator.reportDelivery(message.reqId, deliverySuccessful);
    
    log.debug('Reported delivery status to orchestrator', { 
      reqId: message.reqId,
      delivered: deliverySuccessful
    });
  } catch (reportError) {
    log.error('Failed to report delivery status to orchestrator', {
      reqId: message.reqId,
      delivered: deliverySuccessful,
      error: reportError instanceof Error ? reportError.message : String(reportError),
      note: 'Orchestrator may not clean up queue entry'
    });
  }
}
```

**Changes to `proxy-fetch/src/FetchOrchestrator.ts`**:
- Renamed `markComplete(reqId)` → `reportDelivery(reqId, delivered: boolean)`
- Logs delivery failures with `log.error()` for monitoring/alerting
- Cleans up queue entry regardless of delivery status

**Key Implementation Details**:
- Track `delivered` boolean in executor
- Always report status to orchestrator (success or failure)
- Orchestrator logs delivery failures for monitoring
- Orchestrator always cleans up queue (whether delivered or not)

**Tests**:
- ✅ Successful delivery → reported to orchestrator, queue cleaned up
- ✅ Failed delivery → reported to orchestrator with error log, queue cleaned up
- ✅ Failed status report → logged but doesn't crash execution
- ✅ Existing integration tests pass (9/15, same 6 pre-existing timeout failures)
- ✅ Handler can call `result.text()` synchronously (no await needed)
- ✅ Handler can call `result.arrayBuffer()` synchronously (no await needed)

### Phase 3: Alarm-Based Timeout Monitoring in Orchestrator

**Goal**: Monitor for delivery timeouts and send timeout errors to Origin.

**Changes to `proxy-fetch/src/types.ts`**:

```typescript
export interface WorkerFetchMessage {
  reqId: string;
  request: any; // Preprocessed Request
  originBinding: string;
  originId: string;
  fetchTimeout: number; // NEW: Timeout for AbortController (not orchestrator timeout)
  options?: ProxyFetchWorkerOptions;
  startTime: number;
}

// ResponseSync: Response with synchronous body access
// Provides .json(), .text(), .arrayBuffer() methods that work without await
// See @lumenize/structured-clone for full API
export type { ResponseSync } from '@lumenize/structured-clone';

export interface FetchResult {
  reqId: string;
  response?: ResponseSync; // ResponseSync instead of Response
  error?: Error;
  retryCount?: number;
  duration: number;
}
```

**Why ResponseSync?**
- User handlers are synchronous (no `async`)
- Can't do `await response.json()` in a sync handler
- `ResponseSync` provides synchronous body methods: `.json()`, `.text()`, `.arrayBuffer()`
- Executor converts Response → ResponseSync using `ResponseSync.fromResponse()`
  - Reads body once based on Content-Type (JSON, text, or binary)
  - Stores in serializable format (string, ArrayBuffer, or plain object)
- Handler calls `.json()` or `.text()` **without await**

**Changes to `proxy-fetch/src/FetchOrchestrator.ts`**:

```typescript
export class FetchOrchestrator extends LumenizeBase {
  async enqueueFetch(message: FetchOrchestratorMessage): Promise<void> {
    const log = debug(this.ctx)('lmz.proxyFetch.orchestrator');
    
    log.debug('Enqueueing fetch request', {
      reqId: message.reqId,
      originBinding: message.originBinding,
      originId: message.originId
    });

    // Store in queue with timeout
    const queueKey = `__lmz_fetch_queue:${message.reqId}`;
    const fetchTimeout = message.options?.timeout ?? 30000;
    
    // Orchestrator timeout = fetch timeout + alarm polling period + buffer
    // This ensures the fetch has time to complete AND report back before timeout
    const ALARM_POLLING_PERIOD = 5000; // 5 seconds
    const BUFFER = 5000; // 5 seconds for network latency and RPC delivery
    const orchestratorTimeout = fetchTimeout + ALARM_POLLING_PERIOD + BUFFER;
    
    this.ctx.storage.kv.put(queueKey, {
      ...message,
      fetchTimeout,  // For executor's AbortController
      timeoutAt: Date.now() + orchestratorTimeout
    });

    // Dispatch to Worker immediately (once only)
    await this.#dispatchToWorker(message);
    
    // Schedule alarm to check for timeouts (if not already running)
    // Alarm runs on 5-second cadence while queue has items
    this.#scheduleAlarm();
  }

  async markDelivered(reqId: string): Promise<void> {
    const log = debug(this.ctx)('lmz.proxyFetch.orchestrator');
    
    log.debug('Marking fetch delivered', { reqId });

    // Remove from queue - delivery confirmed
    const queueKey = `__lmz_fetch_queue:${reqId}`;
    this.ctx.storage.kv.delete(queueKey);
  }

  async alarm(): Promise<void> {
    const log = debug(this.ctx)('lmz.proxyFetch.orchestrator');
    const now = Date.now();
    const items = [...this.ctx.storage.kv.list({ prefix: '__lmz_fetch_queue:' })];
    
    log.debug('Alarm checking for timeouts', { queueSize: items.length });
    
    for (const [key, item] of items) {
      if (item.timeoutAt < now) {
        // Timeout! Send error to origin
        log.warn('Fetch delivery timeout', { reqId: item.reqId });
        await this.#sendTimeoutToOrigin(item);
        this.ctx.storage.kv.delete(key);
      }
    }
    
    // Schedule next alarm if queue not empty
    if (items.length > 0) {
      this.#scheduleAlarm();
    }
  }

  #scheduleAlarm(): void {
    // Schedule alarm 5 seconds from now
    // Note: setAlarm will replace any existing alarm, so safe to call multiple times
    const nextCheck = Date.now() + 5000;
    this.ctx.storage.setAlarm(nextCheck);
  }

  async #sendTimeoutToOrigin(item: FetchOrchestratorMessage): Promise<void> {
    const log = debug(this.ctx)('lmz.proxyFetch.orchestrator');
    
    try {
      const originId = this.env[item.originBinding].idFromString(item.originId);
      const originDO = this.env[item.originBinding].get(originId);
      
      const timeoutError = {
        reqId: item.reqId,
        error: new Error(
          `Fetch delivery timeout: Unable to confirm result delivery. ` +
          `WARNING: The external fetch may have executed successfully and ` +
          `modified state on the 3rd party system. Check the external ` +
          `system's state before retrying to avoid duplicate operations.`
        ),
        duration: Date.now() - item.timestamp
      };
      
      const preprocessed = await preprocess(timeoutError);
      await originDO.__receiveResult('proxyFetch', item.reqId, preprocessed);
      
      log.debug('Timeout error sent to origin DO', { reqId: item.reqId });
    } catch (error) {
      log.error('Failed to send timeout to origin', { 
        reqId: item.reqId, 
        error: error instanceof Error ? error.message : String(error)
      });
      // Not much we can do - log and move on
    }
  }

  async #dispatchToWorker(message: FetchOrchestratorMessage): Promise<void> {
    const log = debug(this.ctx)('lmz.proxyFetch.orchestrator');
    
    try {
      const executor = this.env[message.executorBinding || 'FETCH_EXECUTOR'];
      if (!executor) {
        throw new Error(`Executor binding not found: ${message.executorBinding || 'FETCH_EXECUTOR'}`);
      }
      
      // Create worker message with fetchTimeout
      const workerMessage: WorkerFetchMessage = {
        reqId: message.reqId,
        request: message.request,
        originBinding: message.originBinding,
        originId: message.originId,
        fetchTimeout: message.options?.timeout ?? 30000,  // Pass fetch timeout to executor
        options: message.options,
        startTime: Date.now()
      };
      
      // Dispatch to executor via RPC (returns immediately due to ctx.waitUntil)
      await executor.executeFetch(workerMessage);
      
      log.debug('Dispatched fetch to executor', { reqId: message.reqId });
    } catch (error) {
      log.error('Failed to dispatch to executor', {
        reqId: message.reqId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  // Keep existing getQueueStats method
}
```

**Key Changes**:
- Add `fetchTimeout` field to `WorkerFetchMessage` type
- Calculate `orchestratorTimeout = fetchTimeout + 10s` when enqueueing (5s alarm polling + 5s buffer)
- Store both `fetchTimeout` (for executor) and `timeoutAt` (for orchestrator) in queue
- Pass `fetchTimeout` to executor in `#dispatchToWorker`
- Implement `alarm()` to check for timeouts using `timeoutAt` every 5 seconds
- **Alarm cadence**: Runs every 5s while queue has items, deleted when queue becomes empty
- Send timeout error with clear warning message
- Remove any retry logic (dispatch once only)

**Tests**:
- ✅ Normal flow: delivery confirmed before timeout
- ✅ Timeout flow: no confirmation → timeout error sent
- ✅ Timeout coordination: fetch completing at fetchTimeout doesn't trigger orchestrator timeout
- ✅ Alarm scheduling: queue receives first item → alarm scheduled
- ✅ Alarm continues: queue has items → alarm reschedules every 5s
- ✅ Alarm cleanup: queue becomes empty → alarm not rescheduled
- ✅ Timeout message: contains warning about potential success

### Phase 4: Rename to proxyFetch and Register as NADIS Service

**Goal**: 
1. Rename `proxyFetchWorker` → `proxyFetch` (old variants are gone)
2. Register as NADIS service (like `@lumenize/call`)
3. Leverage `@lumenize/call` for the Origin → Orchestrator invocation (first hop only)

**Key Insight**: 
- `call()` handles the **synchronous invocation** of `Orchestrator.enqueueFetch()` (inherits V4 learnings)
- The **fetch result** comes back via a separate path: `Executor → Origin.__receiveResult()`
- We need TWO continuation mechanisms:
  1. `call()`'s continuation (fires when `enqueueFetch` returns - we don't need this)
  2. `proxyFetch`'s continuation (fires when fetch result arrives - this is what user cares about)

**Changes to `proxy-fetch/src/proxyFetch.ts`** (renamed from `proxyFetchWorker.ts`):

```typescript
import { call } from '@lumenize/call';
import { preprocess } from '@lumenize/structured-clone';
import type { DurableObject } from 'cloudflare:workers';

export function proxyFetch<TOrigin extends DurableObject>(
  doInstance: TOrigin,
  request: Request | string,
  continuation: any,
  options?: ProxyFetchWorkerOptions
): string {
  const reqId = crypto.randomUUID();
  
  // Prepare request
  const req = typeof request === 'string' ? new Request(request) : request;
  
  // Get origin binding
  const originBinding = options?.originBinding || getOriginBinding(doInstance, doInstance.env);
  
  // Store OUR continuation for when fetch result comes back (separate from call's mechanism)
  const pendingKey = `__lmz_proxyFetch_pending:${reqId}`;
  const preprocessedContinuation = await preprocess(continuation);
  doInstance.ctx.storage.kv.put(pendingKey, {
    continuation: preprocessedContinuation,
    timestamp: Date.now()
  });
  
  // Use @lumenize/call to invoke FetchOrchestrator (inherits V4 learnings)
  // Note: call()'s continuation would fire when enqueueFetch returns (immediately)
  // We don't need that - we care about the fetch result which comes back later
  call(
    doInstance,
    options?.orchestratorBinding || 'FETCH_ORCHESTRATOR',
    options?.orchestratorInstanceName || 'singleton',
    (orchestrator) => orchestrator.enqueueFetch({
      reqId,
      request: await preprocess(req),
      originBinding,
      originId: doInstance.ctx.id.toString(),
      options,
      timestamp: Date.now()
    })
    // No continuation parameter - we don't care when enqueueFetch returns
  );
  
  return reqId;
}

// Create NADIS service wrapper
export const createProxyFetchService = (doInstance: DurableObject) => {
  return (
    request: Request | string,
    continuation: any,
    options?: ProxyFetchWorkerOptions
  ): string => {
    return proxyFetch(doInstance, request, continuation, options);
  };
};
```

**Add to `proxy-fetch/src/index.ts`**:

```typescript
import { proxyFetch, createProxyFetchService } from './proxyFetch';

// Export function for direct use
export { proxyFetch };

// Register as NADIS service
if (!(globalThis as any).__lumenizeServices) {
  (globalThis as any).__lumenizeServices = {};
}
(globalThis as any).__lumenizeServices.proxyFetch = createProxyFetchService;

// TypeScript declaration merging
declare global {
  interface LumenizeServices {
    proxyFetch: (
      request: Request | string,
      continuation: any,
      options?: ProxyFetchWorkerOptions
    ) => string;  // Returns reqId for logging/debugging
  }
}
```

**Benefits**:
- **NADIS service**: `this.svc.proxyFetch(...)` - no imports needed in DO files
- **Consistent API**: Matches `this.svc.call(...)` pattern
- **`$result` marker**: Explicit, type-safe result placement (last parameter)
- **Context-friendly**: Easy to pass additional data to handlers
- **Cleaner name**: Just `proxyFetch` (old variants gone)
- **Returns reqId**: Useful for logging, debugging, or correlation
- Leverages `call()`'s V4 pattern for Origin → Orchestrator invocation
- Inherits all learnings from call experiments (blockConcurrencyWhile, storage ordering, etc.)
- Separate continuation mechanism for fetch results (correct async pattern)
- Clear separation of concerns: invocation vs result delivery

**Why Not Pass Continuation to `call()`?**
- `call()`'s continuation fires when `enqueueFetch()` returns (milliseconds)
- User's continuation should fire when fetch result arrives (seconds/minutes later)
- These are two different events on completely different timelines

**Usage**:
```typescript
import '@lumenize/proxy-fetch';  // Registers as NADIS service

class MyDO extends LumenizeBase {
  fetchData(userId: string) {
    const reqId = this.svc.proxyFetch(
      `https://api.example.com/users/${userId}`,
      this.ctn().handleResult({ userId })
    );
    // Result implicitly goes as last parameter
    // Returns immediately with reqId (useful for logging)
    console.log('Fetch initiated:', reqId);
  }
  
  handleResult(context: { userId: string }, result: ResponseSync | Error) {
    // Result comes as LAST parameter (implicit)
    if (result instanceof Error) {
      console.error('Fetch failed for user', context.userId, result);
    } else {
      const data = result.json();  // Synchronous!
      console.log('User data for', context.userId, data);
    }
  }
}
```

**API Pattern: Result as Last Parameter**

The result goes as the **last parameter** in the handler. You can use either implicit or explicit syntax:

**Implicit (no marker) - Recommended**
```typescript
// Call site - result implicitly goes last
this.ctn().handleResult({ userId: '123' })

// Handler - result is last parameter
handleResult(context: { userId: string }, result: ResponseSync | Error) {
  // context comes first (your data)
  // result comes last (the fetch result - implicit)
}
```

**Explicit ($result marker) - For flexibility**
```typescript
// Call site - result explicitly placed
this.ctn().handleResult({ userId: '123' }, this.ctn().$result)

// Handler - result is last parameter
handleResult(context: { userId: string }, result: ResponseSync | Error) {
  // context comes first (your data)
  // result comes last (the fetch result - explicit)
}
```

**Why last parameter?**
- **Conventional**: Output parameters typically go last
- **Implicit support**: Can omit `$result` marker for clean syntax
- **Flexible**: `$result` marker allows alternate positions if needed
- **Type-safe**: TypeScript infers correct types either way

**Tests**:
- ✅ NADIS registration works (`this.svc.proxyFetch` available)
- ✅ Returns reqId immediately (type `string`)
- ✅ `enqueueFetch` invoked via `call()` (inherits V4 pattern)
- ✅ Continuation stored correctly for later result delivery
- ✅ Result arrives via `__receiveResult` and fires user's continuation
- ✅ Handler receives actual `ResponseSync` or `Error` as last parameter
- ✅ **Implicit pattern**: `this.ctn().handleResult({ userId })` - result appended as last param
- ✅ **Explicit pattern**: `this.ctn().handleResult({ userId }, this.ctn().$result)` - result at marker position
- ✅ Context parameters passed correctly to handler in both patterns
- ✅ Type safety: continuation parameters have correct types
- ✅ Direct function call still works: `proxyFetch(doInstance, url, continuation)`

### Phase 5: Integration Tests for Race Conditions

**Goal**: Verify idempotency handles races correctly.

**Test Scenarios**:

1. **Success + Timeout Race**:
   - Mock slow `markDelivered()` (network delay)
   - Verify Origin receives result
   - Verify timeout arrives later
   - Verify duplicate is logged as error and ignored

2. **Timeout Arrives First**:
   - Mock very slow delivery
   - Let timeout fire first
   - Verify Origin receives timeout error
   - Verify actual result arrives later
   - Verify late result is logged as error and ignored

3. **Multiple Concurrent Fetches**:
   - Fire 10 fetches in parallel
   - Verify all receive results
   - Verify no crosstalk between reqIds

4. **Timeout Coordination**:
   - Set `options.timeout = 5000` (5 seconds)
   - Mock a fetch that takes exactly 5 seconds
   - Verify Orchestrator doesn't fire timeout (should wait 5s + 10s = 15s)
   - Verify Origin receives success result, not timeout error

**Implementation Notes**:
- May need to add test hooks to delay `markDelivered()`
- May need to mock network delays in test environment
- Use `test-endpoints` `/delay/{milliseconds}` endpoint for timeout coordination tests

## Success Criteria

1. ✅ Idempotency implemented in `__receiveResult`
2. ✅ Duplicate results logged as errors and ignored
3. ✅ Delivery confirmation works (`markDelivered()`)
4. ✅ ResponseSync conversion (body already read for sync handlers)
5. ✅ Timeout monitoring via alarms works
6. ✅ Timeout coordination correct (orchestratorTimeout = fetchTimeout + 10s)
7. ✅ Timeout errors sent to Origin with warning message
8. ✅ Renamed `proxyFetchWorker` → `proxyFetch`
9. ✅ Registered as NADIS service (`this.svc.proxyFetch`)
10. ✅ `proxyFetch` uses `@lumenize/call` for Origin → Orchestrator invocation
11. ✅ All existing tests pass
12. ✅ New race condition tests pass
13. ✅ Coverage remains >90%

## Timeline

**Estimated**: 1-2 days

**Phase 1** (Idempotency): 2-3 hours  
**Phase 2** (Delivery confirmation): 1-2 hours  
**Phase 3** (Timeout monitoring + coordination): 3-4 hours  
**Phase 4** (Use @lumenize/call): 1 hour  
**Phase 5** (Integration tests + timeout coordination tests): 3-4 hours  

## References

- **Design Doc**: `/website/docs/proxy-fetch/architecture-and-failure-modes.mdx`
- **Related**: `@lumenize/call` package (for reference pattern)
- **Related**: `tasks/proxy-fetch-stress-test.md` (blocked by this work)

## Notes

- The MDX doc serves as both user-facing docs and design reference
- After implementation, review MDX to remove implementation details if needed
- Stress testing (next task) will validate this design under load

