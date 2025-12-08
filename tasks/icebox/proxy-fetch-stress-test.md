# ProxyFetch Stress Test - RPC Concurrency Limits

**Goal**: Use the experiments framework to stress test `@lumenize/proxy-fetch` and determine if there are concurrency limits between FetchOrchestrator and FetchExecutorEntrypoint when using RPC service bindings.

## Background

After refactoring proxy-fetch to use RPC (service bindings) instead of HTTP:
- Traditional HTTP/1.1 has a 6-connection limit per origin
- RPC service bindings might not have this limit (or might have different limits)
- Need empirical data to confirm behavior under stress

## Research Questions

1. **Is there a concurrency limit?** How many simultaneous RPC calls can FetchOrchestrator make to FetchExecutor?
2. **What happens at the limit?** Queue? Error? Timeout?
3. **Performance characteristics**: Does latency degrade with more concurrent operations?
4. **Comparison**: RPC vs HTTP dispatch (if we want to compare)

## Experiment Design

### Using test-endpoints `/delay/` endpoint

**Key Insight**: Use a delay endpoint as a "timer" to reveal concurrency limits!

- If 6-connection limit: 60 requests × 1000ms delay = ~10 seconds (10 batches of 6)
- If no limit: 60 requests × 1000ms delay = ~1 second (all parallel)

### Using `@lumenize/for-experiments` Framework

Similar to `experiments/call-patterns/`, create `experiments/proxy-fetch-stress/`:

**Structure**:
```
experiments/proxy-fetch-stress/
├── package.json
├── wrangler.jsonc
├── tsconfig.json
├── src/
│   └── index.ts              # Experiment controller DO
├── test/
│   └── measurements.mjs      # Node.js client
└── RESULTS.md                # Findings
```

### Test Variations

Using test-endpoints `/delay/1000` (1 second delay per request):

1. **Sequential**: 10 requests, one at a time (baseline: ~10s)
2. **Parallel-6**: 60 requests all at once
   - If 6-limit: ~10 seconds (10 batches)
   - If no-limit: ~1 second (all parallel)
3. **Parallel-12**: 120 requests all at once
   - If 6-limit: ~20 seconds (20 batches)
   - If 12-limit: ~10 seconds (10 batches)
   - If no-limit: ~1 second
4. **Parallel-50**: 50 requests all at once
5. **Parallel-100**: 100 requests all at once (max stress)

### Metrics to Capture

For each variation, measure:
- **Queue rate**: Time to enqueue N requests
- **Completion rate**: Time until all N complete
- **Per-operation latency**: Distribution (min, avg, max, p50, p95, p99)
- **Errors**: Any failures, timeouts, or limits hit
- **Queue depth**: Peak queue size in FetchOrchestrator

### Implementation Details

**Experiment Controller DO**:
```typescript
import { LumenizeExperimentDO } from '@lumenize/for-experiments';
import { proxyFetchWorker } from '@lumenize/proxy-fetch';
import { createTestEndpoints } from '@lumenize/test-endpoints';

export class StressTestController extends LumenizeExperimentDO {
  async runSequential(count: number): Promise<Stats> {
    const TEST_ENDPOINTS = createTestEndpoints(
      this.env.TEST_TOKEN,
      this.env.TEST_ENDPOINTS_URL,
      'stress-test'
    );
    
    const startTime = Date.now();
    
    for (let i = 0; i < count; i++) {
      await proxyFetchWorker(
        this,
        TEST_ENDPOINTS.buildUrl('/delay/1000'),
        this.ctn().handleFetchResult(),
        { originBinding: 'STRESS_CONTROLLER' }
      );
    }
    
    // Wait for all to complete...
    const totalTime = Date.now() - startTime;
    return { count, totalTime, avgTime: totalTime / count };
  }
  
  async runParallel(count: number): Promise<Stats> {
    const TEST_ENDPOINTS = createTestEndpoints(
      this.env.TEST_TOKEN,
      this.env.TEST_ENDPOINTS_URL,
      'stress-test'
    );
    
    const startTime = Date.now();
    
    // Fire all requests at once
    const promises = Array.from({ length: count }, (_, i) =>
      proxyFetchWorker(
        this,
        TEST_ENDPOINTS.buildUrl('/delay/1000'),
        this.ctn().handleFetchResult(i),
        { originBinding: 'STRESS_CONTROLLER' }
      )
    );
    
    await Promise.all(promises);
    
    // Wait for all results to arrive via continuations...
    const totalTime = Date.now() - startTime;
    return { count, totalTime, avgTime: totalTime / count };
  }
  
  // Handler for results
  handleFetchResult(index: number) {
    return (result: Response | Error) => {
      const completionTime = Date.now();
      // Mark completion with storage marker
      this.ctx.storage.kv.put(`completed_${index}`, completionTime);
    };
  }
}
```

**Node.js Client**:
```javascript
// Similar to call-patterns/test/measurements.mjs
const variations = [
  { name: 'sequential', count: 10, parallel: false },
  { name: 'parallel-6', count: 60, parallel: true },
  { name: 'parallel-12', count: 120, parallel: true },
  { name: 'parallel-50', count: 50, parallel: true },
  { name: 'parallel-100', count: 100, parallel: true },
];

for (const variation of variations) {
  const result = await runVariation(variation);
  console.log(`${variation.name}: ${result.totalTime}ms total, ${result.avgTime}ms avg`);
}

// Expected results:
// sequential (10): ~10s (1s × 10)
// parallel-6 (60): ~10s if 6-limit, ~1s if no-limit
// parallel-12 (120): ~20s if 6-limit, ~10s if 12-limit, ~1s if no-limit
// parallel-50 (50): reveals higher limits
// parallel-100 (100): max stress test
```

### Wrangler Configuration

```jsonc
{
  "name": "proxy-fetch-stress",
  "main": "src/index.ts",
  "compatibility_date": "2025-09-12",
  "durable_objects": {
    "bindings": [
      { "name": "STRESS_CONTROLLER", "class_name": "StressTestController" },
      { "name": "FETCH_ORCHESTRATOR", "class_name": "FetchOrchestrator" }
    ]
  },
  "services": [
    {
      "binding": "FETCH_EXECUTOR",
      "service": "proxy-fetch-stress",
      "entrypoint": "FetchExecutorEntrypoint"
    }
  ],
  "vars": {
    "TEST_TOKEN": "will-be-loaded-from-.dev.vars",
    "TEST_ENDPOINTS_URL": "https://test-endpoints.transformation.workers.dev"
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["StressTestController", "FetchOrchestrator"] }
  ]
}
```

## Expected Outcomes

### Scenario A: No RPC Limit (Ideal)
- **Sequential (10)**: ~10 seconds (baseline)
- **Parallel-6 (60)**: ~1 second (all execute simultaneously)
- **Parallel-12 (120)**: ~1 second (all execute simultaneously)
- **Parallel-50 (50)**: ~1 second (all execute simultaneously)
- **Parallel-100 (100)**: ~1 second (all execute simultaneously)
- **Conclusion**: RPC scales without connection limits! 🎉

### Scenario B: 6-Connection Limit (Like HTTP/1.1)
- **Sequential (10)**: ~10 seconds (baseline)
- **Parallel-6 (60)**: ~10 seconds (60 requests / 6 concurrent = 10 batches)
- **Parallel-12 (120)**: ~20 seconds (120 requests / 6 concurrent = 20 batches)
- **Parallel-50 (50)**: ~9 seconds (50 requests / 6 concurrent = 8.33 batches)
- **Parallel-100 (100)**: ~17 seconds (100 requests / 6 concurrent = 16.67 batches)
- **Conclusion**: RPC has same limits as HTTP

### Scenario C: Different Limit (e.g., 50 concurrent)
- **Sequential (10)**: ~10 seconds (baseline)
- **Parallel-6 (60)**: ~2 seconds (60 requests / 50 concurrent = 1.2 batches)
- **Parallel-12 (120)**: ~3 seconds (120 requests / 50 concurrent = 2.4 batches)
- **Parallel-50 (50)**: ~1 second (all execute simultaneously)
- **Parallel-100 (100)**: ~2 seconds (100 requests / 50 concurrent = 2 batches)
- **Conclusion**: RPC has a specific limit (document it!)

### Scenario D: Other Bottleneck
- Subrequest depth limits from Cloudflare Workers
- FetchOrchestrator queue management issues
- Memory or CPU constraints
- Timeouts or errors at high concurrency

## Success Criteria

1. ✅ Experiment runs all variations
2. ✅ Clear metrics for each variation
3. ✅ Answer: "Is there a concurrency limit for RPC service bindings?"
4. ✅ Document findings in RESULTS.md
5. ✅ Update proxy-fetch docs if limits discovered

## Next Steps After Experiment

If limits are found:
1. Document in `@lumenize/proxy-fetch` README
2. Consider queue management in FetchOrchestrator
3. Potentially add concurrency control options

If no limits found:
1. Celebrate! 🎉
2. Document that RPC scales well
3. Update proxy-fetch performance docs

## References

- `experiments/call-patterns/` - Similar experiment framework usage
- `tooling/for-experiments/` - Experiment framework
- `packages/proxy-fetch/` - Package under test

## Prerequisites

Before running stress tests, we need to implement **robust retry and timeout logic**:

1. **Idempotent result handler** in Origin DO (`__receiveResult`)
   - Track processed reqIds to prevent duplicate processing
   - Log duplicates as errors (race condition detection)
   
2. **Delivery confirmation** in Executor
   - `markDelivered(reqId)` - successful delivery to Origin
   - `markDeliveryFailed(reqId, error)` - failed delivery (retry)
   
3. **Alarm-based monitoring** in Orchestrator
   - Track delivery timeouts
   - Retry failed deliveries with exponential backoff
   - Send timeout error to Origin after max retries exhausted
   
4. **Documentation** of failure modes
   - See `website/docs/proxy-fetch/architecture-and-failure-modes.mdx`
   - Critical: Timeout doesn't mean fetch didn't execute!

**Note**: Stress testing will reveal edge cases in this retry logic (race conditions, timeouts under load, etc.).

## Timeline

**Phase 1: Implement Retry Logic**:
1. Add idempotency to `__receiveResult` in LumenizeBase
2. Update Executor to report delivery status
3. Add alarm-based monitoring to Orchestrator
4. Write tests for race conditions
5. Document in MDX (✅ Done)

**Phase 2: Stress Testing**:
1. Create experiment structure
2. Implement controller and client
3. Run experiments locally
4. Analyze results
5. Document findings

**Estimated**: 1-2 days for Phase 1, 4-6 hours for Phase 2

