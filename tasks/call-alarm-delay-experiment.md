# Call Alarm Delay Experiment

**Status**: Not Started  
**Created**: 2025-01-14  
**Goal**: Measure the latency cost of using `schedule(0, ...)` vs direct async calls in `@lumenize/call`

## Background

The `@lumenize/call` package currently uses `alarms.schedule(0, ...)` to defer async work, which provides a narrow durability window (protects against DO eviction between schedule and execution). However, this comes at the cost of uncertain delay added by Cloudflare's native alarm system.

**Questions to answer:**
1. What is the average latency overhead of `schedule(0, ...)` vs direct async call?
2. What is the variance/p95/p99 of that overhead?
3. Is the durability benefit worth the latency cost?

## Measurement Constraints

- **Cloudflare freezes Date.now()** between I/O events - cannot measure inside DOs
- **WebSocket message latency is variable** - cannot measure individual operations
- **Solution**: Measure total wall-clock time from Node.js for batches of operations (1000+)

## Phases

### Phase 1: Local Development with triggerAlarms

Set up experiment infrastructure and validate with fast local iteration.

**Tasks:**
- [ ] Create `experiments/call-alarm-delay/` directory structure
- [ ] Add experimental flag `__experimentDirectCall` to `call()` function signature
- [ ] Implement two code paths in `call()`:
  - Alarm-based: `schedule(0, ...)` (current)
  - Direct call: `processCallQueue.call(doInstance, callId)` (new)
- [ ] Create test DOs:
  - `OriginDO`: Initiates calls via WebSocket messages, reports completion
  - `RemoteDO`: Simple echo DO for call targets
- [ ] Create Node.js measurement script:
  - WebSocket connection to OriginDO
  - Batch operation sender (1000 ops)
  - Wall-clock time measurement
  - Statistical analysis (avg, min, max)
- [ ] Add `triggerAlarms()` helper to OriginDO for local testing
- [ ] Validate locally: Both modes work and show ~0ms difference (using triggerAlarms)

**Files to create:**
```
experiments/call-alarm-delay/
├── README.md
├── MEASUREMENTS.md (results)
├── package.json
├── wrangler.jsonc (single config, no secrets needed)
├── src/
│   └── index.ts (OriginDO, RemoteDO, worker)
└── test/
    └── delay-measurements.mjs (Node.js script)
```

**Local validation command:**
```bash
# Terminal 1
npm run dev

# Terminal 2  
npm test  # Runs both modes, should be ~equal with triggerAlarms
```

### Phase 2: Production Measurements

Deploy and measure with real Cloudflare alarm timing.

**Tasks:**
- [ ] Disable/remove `triggerAlarms()` calls from OriginDO
- [ ] Deploy to production: `npm run deploy`
- [ ] Update measurement script with production URL
- [ ] Run measurements (1000+ ops per mode)
- [ ] Collect multiple runs for confidence
- [ ] Document results in `MEASUREMENTS.md`

**Measurements to capture:**
```
Alarm-based:
  - Total time: Xms
  - Avg per op: X.XXms
  - Min/Max: X-Xms

Direct call:
  - Total time: Xms  
  - Avg per op: X.XXms
  - Min/Max: X-Xms

Difference: X.XXms per operation
```

### Phase 3: Analysis and Decision

**Tasks:**
- [ ] Analyze results and variance
- [ ] Document trade-offs:
  - Durability benefit: Protects against eviction in narrow window between schedule and execution
  - Latency cost: Measured overhead per operation
- [ ] Make recommendation:
  - Keep current design (if overhead is acceptable)
  - Switch to direct calls (if overhead is too high)
  - Make it configurable (if use cases vary)
- [ ] Update documentation with findings
- [ ] If changing: Update `@lumenize/call` implementation
- [ ] Remove experimental flag or make it official

## Code Changes

### Add Experimental Flag to Call Package

```typescript
// packages/call/src/types.ts
export interface CallOptions {
  timeout?: number;
  __experimentDirectCall?: boolean;  // Experimental: bypass alarm scheduling
}

// packages/call/src/call.ts
export function call(
  doInstance: any,
  doBinding: string,
  doInstanceNameOrId: string,
  remoteOperation: any,
  continuation: any,
  options?: CallOptions
): void {
  // ... existing setup ...
  
  ctx.storage.kv.put(`__lmz_call_data:${callId}`, {
    remoteChain,
    continuationChain,
    doBinding,
    doInstanceNameOrId,
    options
  });

  if (options?.__experimentDirectCall) {
    // Direct async call (fire and forget, output gates track it)
    processCallQueue.call(doInstance, callId);
  } else {
    // Current alarm-based approach
    doInstance.svc.alarms.schedule(
      0,
      doInstance.ctn().__processCallQueue(callId)
    );
  }
}
```

### Measurement Infrastructure

```typescript
// experiments/call-alarm-delay/src/index.ts

class OriginDO extends LumenizeBase<Env> {
  // For local testing only - remove for production measurements
  async triggerAlarms() {
    if (this.svc?.alarms?.triggerAlarms) {
      return await this.svc.alarms.triggerAlarms();
    }
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    const msg = JSON.parse(message);
    
    if (msg.action === 'test-call') {
      // Execute call with specified mode
      await this.svc.call(
        'REMOTE_DO',
        'test-instance',
        this.ctn<RemoteDO>().echo('test'),
        this.ctn().onComplete(ws, msg.id),
        { __experimentDirectCall: msg.mode === 'direct' }
      );
      
      // Local testing only - remove for production
      // await this.triggerAlarms();
    }
  }
  
  onComplete(ws: WebSocket, id: number, result: any | Error) {
    // Notify Node.js that operation completed
    ws.send(JSON.stringify({ 
      type: 'call-complete', 
      id 
    }));
  }
}

class RemoteDO extends LumenizeBase<Env> {
  echo(value: string): string {
    return `echo: ${value}`;
  }
}
```

```javascript
// experiments/call-alarm-delay/test/delay-measurements.mjs

async function measureBatchLatency(ws, mode, iterations = 1000) {
  console.log(`\n📊 Measuring ${mode} mode (${iterations} operations)`);
  
  const startTime = Date.now();
  
  // Send all operations
  for (let i = 0; i < iterations; i++) {
    ws.send(JSON.stringify({ 
      action: 'test-call', 
      mode,
      id: i 
    }));
  }
  
  // Wait for all completions
  let completed = 0;
  await new Promise((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.type === 'call-complete') {
        completed++;
        if (completed === iterations) resolve();
      }
    });
  });
  
  const endTime = Date.now();
  const totalTime = endTime - startTime;
  const avgPerOp = totalTime / iterations;
  
  return { totalTime, avgPerOp, iterations };
}

async function runExperiment() {
  const ws = await connectWebSocket();
  
  // Warm up
  await measureBatchLatency(ws, 'alarm', 10);
  await sleep(2000);
  
  // Measure both modes
  const alarmResults = await measureBatchLatency(ws, 'alarm', 1000);
  await sleep(2000);
  const directResults = await measureBatchLatency(ws, 'direct', 1000);
  
  console.log('\n📈 RESULTS:');
  console.log(`Alarm-based: ${alarmResults.totalTime}ms total, ${alarmResults.avgPerOp.toFixed(2)}ms avg`);
  console.log(`Direct call: ${directResults.totalTime}ms total, ${directResults.avgPerOp.toFixed(2)}ms avg`);
  console.log(`Difference: ${(alarmResults.avgPerOp - directResults.avgPerOp).toFixed(2)}ms per operation`);
  
  ws.close();
}
```

## Success Criteria

- [ ] Both code paths work correctly (calls complete, continuations execute)
- [ ] Production measurements collected (1000+ operations per mode)
- [ ] Statistical confidence in the overhead measurement
- [ ] Decision made and documented about design choice
- [ ] Code cleaned up (experimental flag removed or finalized)

## Notes

- No test endpoints needed - just DO-to-DO calls
- Single wrangler.jsonc works for both local and production
- Use triggerAlarms locally for fast iteration, remove for production
- Focus on average overhead - variance is secondary but interesting
- Consider p95/p99 if alarm timing is highly variable

## Related

- `experiments/proxy-fetch-latency/` - Similar measurement methodology
- `packages/call/` - Package being evaluated
- `packages/alarms/` - Alarm system being measured

