# Cloudflare Workers: Async Operations and Fetch Concurrency

## Date: October 28, 2025

This document captures experiments and findings about how Cloudflare Workers Durable Objects handle asynchronous operations, particularly related to alarms, `ctx.waitUntil()`, and concurrent fetch requests.

## Background

While building a DO-based proxy fetch system for `@lumenize/proxy-fetch`, we needed to understand:
1. Do async operations continue after an alarm handler completes?
2. Is `ctx.waitUntil()` required for background work?
3. What is the true limit on concurrent outbound fetch requests?
4. How does the pending fetch queue behave?

## Experimental Setup

We created a test Durable Object (`ExperimentDO`) with various alarm-based experiments to measure these behaviors.

### Challenge: Clock Stopping

**Critical insight**: The Cloudflare Workers runtime stops the clock during request processing. This means:
- `Date.now()` doesn't advance during synchronous code execution
- Timing measurements within the DO are unreliable
- All async operations appear to start simultaneously (at timestamp 0)
- External timing from Node.js would be needed for accurate measurements

This is why our experiments showed all 20 fetches "starting" at +0ms - the clock was frozen during the alarm execution.

## Experiment 1: Async Without waitUntil

**Test**: Start 3 async operations with `setTimeout` delays (1s, 1.5s, 2s) from an alarm, WITHOUT using `ctx.waitUntil()`.

```typescript
async alarm() {
  // Fire-and-forget - no await, no waitUntil
  this.#doAsyncWork(1, 1000);
  this.#doAsyncWork(2, 1500);
  this.#doAsyncWork(3, 2000);
  
  console.log('Alarm completing');
  // Alarm exits immediately
}
```

**Result**: ✅ All 3 operations completed successfully!

**Conclusion**: Async operations in alarms DO continue executing even after the alarm handler completes, even WITHOUT `ctx.waitUntil()`.

## Experiment 2: Async With waitUntil

**Test**: Same setup as Experiment 1, but wrap async work in `ctx.waitUntil()`.

```typescript
async alarm() {
  this.ctx.waitUntil(this.#doAsyncWork(1, 1000));
  this.ctx.waitUntil(this.#doAsyncWork(2, 1500));
  this.ctx.waitUntil(this.#doAsyncWork(3, 2000));
  
  console.log('Alarm completing');
}
```

**Result**: ✅ All 3 operations completed successfully!

**Conclusion**: `ctx.waitUntil()` also works, providing an explicit way to indicate background work.

## Experiment 3: Many Parallel Operations

**Test**: Start 10 async operations with random delays (500-1500ms) using `ctx.waitUntil()`.

**Result**: ✅ All 10 operations completed successfully!

**Conclusion**: Can successfully run many parallel async operations from a single alarm.

## Concurrent Fetch Limit - Official Documentation

We searched the [Cloudflare Workers limits documentation](https://developers.cloudflare.com/workers/platform/limits/) and found:

### Hard Limit: 6 Simultaneous Connections

From the "Account plan limits" table:
- **Simultaneous outgoing connections/request: 6**

This applies to ALL of the following API calls:
- `fetch()` (Fetch API)
- Workers KV operations (`get()`, `put()`, `list()`, `delete()`)
- Cache API operations
- R2 operations
- Queue operations
- TCP sockets via `connect()`
- Outbound WebSocket connections

### Pending Queue Behavior

When you attempt to open more than 6 connections:
- Additional attempts are **queued**, not rejected
- Connections initiate when an existing connection closes
- Earlier connections can delay later ones
- Stalled connections may be closed with `Response closed due to connection limit` exception

**No documented limit on pending queue capacity** - appears to be quite large (our experiment attempted 100 without errors, though we couldn't measure accurately due to clock stopping).

### Stalled Connection Detection

The system detects deadlocks:
- If a Worker has pending connection attempts
- But no in-progress reads/writes on open connections
- The least-recently-used open connection is canceled to unblock the Worker

### Best Practice: Cancel Unused Response Bodies

To free up connections when you don't need the response body:

```typescript
const response = await fetch(url);
if (response.statusCode > 299) {
  response.body.cancel();  // Frees up the connection
}
```

## Recommendations for ProxyFetchDO

Based on these findings:

### 1. Use MAX_IN_FLIGHT = 5

Keep **5 concurrent outbound fetches** maximum:
- Hard limit is 6
- Reserve 1 slot for other operations (KV, serialization, etc.)
- Provides safety margin
- Still achieves high throughput

### 2. Storage-Based Tracking

Use Durable Object storage to track in-flight requests:
```typescript
// Count in-flight
const inFlight = await this.ctx.storage.kv.list({ prefix: 'reqs-in-flight:' });
const count = inFlight.keys.length;

if (count >= MAX_IN_FLIGHT) {
  // At capacity - schedule alarm to check later
  await this.ctx.storage.setAlarm(Date.now() + 500);
  return;
}
```

**Why storage instead of in-memory?**
- Survives DO eviction/restart
- Provides accurate count across alarm invocations
- Enables recovery of orphaned requests

### 3. Alarm-Based Queue Processing

Use alarms for queue processing, not `setTimeout`:
```typescript
async alarm() {
  // Move items from queued → in-flight (transactional)
  // Start async fetches
  // Alarm completes, fetches continue in background
}
```

**Benefits**:
- Transactional guarantees for storage operations within alarm
- Alarms wake hibernated DOs automatically
- One alarm at a time (setting new one overwrites old)

### 4. Fire-and-Forget Fetches

Don't await fetches in the alarm - let them run in background:
```typescript
async alarm() {
  while (inFlightCount < MAX_IN_FLIGHT) {
    // Move queued item to in-flight
    const req = moveToInFlight();
    
    // Start fetch - DON'T await
    this.#processFetch(req);  // or ctx.waitUntil(this.#processFetch(req))
  }
}
```

When fetch completes, it:
- Updates storage
- Triggers queue processing again (alarm or direct call)

### 5. No Need for waitUntil?

Our experiments showed async ops continue without `waitUntil()`, but using it is probably safer and more explicit:
```typescript
this.ctx.waitUntil(this.#processFetch(req));
```

It clearly signals "this work should continue even if alarm completes."

## Experiment 4 & 5: Attempted Measurements

We attempted to measure:
- **Experiment 4**: True parallel fetch limit (20 fetches to slow endpoint)
- **Experiment 5**: Pending queue capacity (100+ fetches)

**Problem**: Clock stopping made accurate timing impossible. All fetches appeared to start at timestamp 0.

**What we observed**:
- All 20 fetches in Experiment 4 "started" at +0ms
- All completed in ~132ms (much faster than expected 3-second delay)
- This suggests httpbin.org/delay endpoint didn't actually delay, OR timing is completely unreliable

**Alternative approach needed**: External Node.js script to trigger experiments and measure from outside the Workers runtime.

## Key Takeaways

1. ✅ **Async operations survive alarm completion** - no need to keep alarm running
2. ✅ **Can run many parallel operations** - tested up to 10 successfully
3. ✅ **Official limit is 6 concurrent connections** - documented, not measured
4. ✅ **Use MAX_IN_FLIGHT = 5** - safe margin for production use
5. ⚠️ **Clock stops during processing** - makes internal timing measurements unreliable
6. ✅ **Use storage for tracking** - survives DO eviction, enables recovery
7. ✅ **Alarm-based processing** - provides transactional guarantees

## Code Examples

See `/packages/proxy-fetch/test/experiments/` for full experiment code:
- `experiment-worker.ts` - ExperimentDO implementation
- `experiments.test.ts` - Test harness

## Future Work

To get precise measurements, we would need:
- External Node.js script to trigger experiments
- Measure timing from outside Workers runtime
- Use endpoints with known, reliable delays
- Statistical analysis of completion patterns

However, for production use, the documented limit of 6 and our conservative choice of 5 is sufficient.

## References

- [Cloudflare Workers Platform Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Simultaneous Open Connections](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections)
- [Durable Objects Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Workers Runtime APIs - waitUntil](https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/)
