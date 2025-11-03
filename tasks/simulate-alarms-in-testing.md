# Simulate Alarms in @lumenize/testing

**Status**: Active
**Started**: 2025-11-02

## Goal

Add automatic alarm simulation to `@lumenize/testing` so alarms fire at the right moment in test time, eliminating the need for manual `runDurableObjectAlarm()` calls and `vi.waitFor()` polling. This will also require adding support for downstream messaging (`sendDownstream`, `onDownstream`, `onClose`) to @lumenize/testing and documenting it in both packages.

## Background

Currently, Cloudflare DO alarms don't fire automatically in test environments. The workaround is:
1. Manually call `runDurableObjectAlarm(stub)` from `cloudflare:test`
2. Use `vi.waitFor()` to poll for alarm execution
3. Repeat for each alarm

This is unsatisfying because:
- Tests don't simulate production behavior (time-based triggers)
- Requires knowledge of when alarms "should" fire
- Boilerplate-heavy
- Makes time-based testing awkward

See: `tasks/backlog.md` line 7-10, `doc-test/actors/alarms/basic-usage/test/basic-usage.test.ts` lines 134-145

### Key Challenge: The Frozen Clock

Cloudflare Workers runtime **stops the clock** during DO execution:
- `Date.now()` returns the same value throughout synchronous code
- Clock only advances during I/O operations (unpredictably)
- Two consecutive `Date.now()` calls return identical timestamps
- However, `setTimeout()` and `setInterval()` work as expected

See: `packages/proxy-fetch/ASYNC_FETCH_EXPERIMENTS.md` lines 19-27

This means:
```typescript
// In production DO code
this.ctx.storage.setAlarm(Date.now() + 10 * 1000); // 10 seconds from now
```

To simulate this:
```typescript
// In our mock setAlarm()
const alarmTime = scheduledTimeMs; // absolute epoch time
const now = Date.now(); // frozen clock
const delay = alarmTime - now; // can calculate delta
setTimeout(() => this.alarm(), delay); // setTimeout works!
```

### Downstream Messaging Connection

Alarm simulation will likely require downstream messaging because:
- Tests may need to be notified when alarms fire (without polling)
- Setup/teardown of alarm simulation may need async communication
- Debugging alarm state requires querying the DO

Currently `@lumenize/rpc` has `sendDownstream()`, `onDownstream`, and `onClose` but:
- Not exported from `@lumenize/testing`
- Not documented in user-facing RPC docs (only in TypeDoc API reference)
- Testing examples don't demonstrate this capability

## Phases

### Phase 1: Export Downstream Messaging from @lumenize/testing

**Goal**: Make `sendDownstream`, `onDownstream`, and `onClose` available in @lumenize/testing

- [ ] Export `sendDownstream` from `@lumenize/testing` index
- [ ] Add type re-exports for downstream messaging handlers
- [ ] Verify types work correctly in test environment
- [ ] Consider whether `createTestingClient` should default to WebSocket transport
  - Current: HTTP transport (simpler, faster for basic tests)
  - Needed for downstream: WebSocket transport (persistent connection)
  - Decision: Keep HTTP default, document how to use WebSocket when needed?
  - Or: Auto-detect if `onDownstream`/`onClose` present and switch to WebSocket?

**Notes**:
- `sendDownstream` is already exported from `@lumenize/rpc` (packages/rpc/src/index.ts line 2)
- Just needs re-export from `@lumenize/testing/src/index.ts`
- May need to export transport factory functions too (`createWebSocketTransport`)

**Decisions**:
1. **Switch default to WebSocket**: `createTestingClient` will use WebSocket by default (breaking change)
   - Rationale: WebSocket is better default now that we have downstream messaging
   - HTTP was a mistake - never used in practice
   - Extra round trip for upgrade is negligible in tests
2. **Accept downstream config**: Add optional `onDownstream` and `onClose` to `createTestingClient`
   - Will explore cleaner API later (less boilerplate)

### Phase 2: Document Downstream Messaging in RPC Docs

**Goal**: Add user-facing documentation for `sendDownstream`, `onDownstream`, and `onClose`

Currently these only appear in TypeDoc API reference (`website/docs/rpc/api/functions/sendDownstream.md`) but not in the narrative docs.

- [ ] Create `website/docs/rpc/downstream-messaging.mdx`
- [ ] Show basic usage: server-to-client push notifications
- [ ] Show authentication pattern with clientId
- [ ] Show `onClose` handler for cleanup
- [ ] Show how to test downstream messaging
- [ ] Add to sidebar in `website/sidebars.ts`
- [ ] Link from introduction and quick-start docs

**Content to cover**:
- When to use downstream messaging vs polling
- Fire-and-forget semantics (no queuing, no retries)
- Application-layer patterns for reliability (catchup by message ID)
- How clientId tagging works
- Security considerations (who can receive messages)
- Examples with Agent patterns (chat notifications, state updates)

### Phase 3: Update Testing Docs for Downstream Messaging

**Goal**: Show how to test DOs that use downstream messaging

- [ ] Add section to `website/docs/testing/usage.mdx` showing:
  - Setting up WebSocket client with `onDownstream` handler
  - Triggering DO methods that call `sendDownstream`
  - Asserting on received downstream messages
  - Testing `onClose` behavior
- [ ] Create test example in appropriate doc-test location
- [ ] Ensure examples validate with `@check-example`

### Phase 4: Initial Experiments ✅ COMPLETED

**Goal**: Answer critical questions about alarm mocking feasibility

**STATUS**: ✅ **COMPLETED - November 2, 2025**

**RESULT**: All `ctx.storage` alarm methods (`setAlarm`, `getAlarm`, `deleteAlarm`) are **MUTABLE** in vitest-pool-workers environment.

**Decision**: Proceed with **Approach A - Transparent Mocking**
- Inject alarm simulation during `instrumentDOProject`
- Users call `ctx.storage.setAlarm()` as normal
- No code changes required for users
- Most seamless approach possible

#### Experiment 4.1: Can we override ctx.storage methods?

```typescript
it('tests if ctx.storage methods are writable', async () => {
  using client = createTestingClient<typeof TestDO>('TEST_DO', 'override-test');
  
  // Try to override setAlarm
  const originalSetAlarm = await client.ctx.storage.setAlarm;
  let setAlarmCalled = false;
  
  try {
    // Can we assign to this?
    client.ctx.storage.setAlarm = (time: number) => {
      setAlarmCalled = true;
      return originalSetAlarm(time);
    };
    
    // Test if our override works
    await client.someMethodThatSetsAlarm();
    expect(setAlarmCalled).toBe(true);
  } catch (error) {
    console.log('Cannot override ctx.storage.setAlarm:', error);
    // If we can't override, we'll need a different approach
  }
});
```

**Outcomes**:
- ✅ If writable: Proceed with mock injection approach
- ❌ If immutable: Need to create our own `this.alarms` API (less seamless)

#### Experiment 4.2: Verify setTimeout behavior with frozen clock

```typescript
it('tests setTimeout with frozen clock', async () => {
  using client = createTestingClient<typeof TestDO>('TEST_DO', 'settimeout-test');
  
  const startTime = Date.now();
  const events: string[] = [];
  
  // Inside DO: Clock is frozen
  await client.testClockAndSetTimeout(startTime, events);
  
  // Events should show:
  // 1. start: X
  // 2. after-sync: X (same as start - clock frozen)
  // 3. in-setTimeout: X+100 (setTimeout worked!)
  expect(events[0]).toContain('start:');
  expect(events[1]).toContain('after-sync:');
  expect(events[1]).toBe(events[0]); // Same time!
  
  // Wait for setTimeout to complete
  await vi.waitFor(() => expect(events.length).toBe(3));
  expect(events[2]).toContain('in-setTimeout:');
  // Time advanced during setTimeout
  const timeoutTime = parseInt(events[2].split(':')[1]);
  expect(timeoutTime).toBeGreaterThan(startTime);
});
```

**Implementation in TestDO**:
```typescript
async testClockAndSetTimeout(startTime: number, events: string[]) {
  const t1 = Date.now();
  events.push(`start:${t1}`);
  
  // Synchronous work - clock stays frozen
  const t2 = Date.now();
  events.push(`after-sync:${t2}`);
  
  // setTimeout - clock advances!
  setTimeout(() => {
    const t3 = Date.now();
    events.push(`in-setTimeout:${t3}`);
  }, 100);
}
```

**Purpose**: Confirm our understanding that `setTimeout` works despite frozen `Date.now()`

#### Experiment 4.3: Test alarm handler invocation

```typescript
it('tests manual alarm invocation', async () => {
  using client = createTestingClient<typeof TestDO>('TEST_DO', 'alarm-invoke');
  
  // Set an alarm
  await client.ctx.storage.setAlarm(Date.now() + 1000);
  
  // Get the stub
  const { env } = await import('cloudflare:test');
  const stub = env.TEST_DO.get(env.TEST_DO.idFromName('alarm-invoke'));
  
  // Manually trigger
  await runDurableObjectAlarm(stub);
  
  // Verify alarm handler ran
  const alarmRan = await client.didAlarmRun();
  expect(alarmRan).toBe(true);
});
```

**Purpose**: Baseline - ensure we understand the current manual approach

### Phase 5: Implement Alarm Simulation

**Goal**: Create automatic alarm firing mechanism

#### Approach A: Mock ctx.storage alarm methods (if Experiment 4.1 succeeds)

Create a new module: `packages/testing/src/alarm-simulation.ts`

```typescript
/**
 * Wraps a DO instance with alarm simulation.
 * Intercepts ctx.storage.setAlarm/getAlarm/deleteAlarm
 * and uses setTimeout to trigger alarm() at the right time.
 */
export function enableAlarmSimulation(doInstance: any): void {
  const alarmState = {
    scheduledTime: null as number | null,
    timeoutId: null as any
  };
  
  // Store original methods
  const originalSetAlarm = doInstance.ctx.storage.setAlarm.bind(doInstance.ctx.storage);
  const originalGetAlarm = doInstance.ctx.storage.getAlarm.bind(doInstance.ctx.storage);
  const originalDeleteAlarm = doInstance.ctx.storage.deleteAlarm.bind(doInstance.ctx.storage);
  
  // Mock setAlarm
  doInstance.ctx.storage.setAlarm = (scheduledTimeMs: number) => {
    // Clear any existing timeout
    if (alarmState.timeoutId) {
      clearTimeout(alarmState.timeoutId);
    }
    
    // Calculate delay
    const now = Date.now();
    const delay = scheduledTimeMs - now;
    
    // Store scheduled time
    alarmState.scheduledTime = scheduledTimeMs;
    
    // Set timeout to fire alarm
    if (delay > 0) {
      alarmState.timeoutId = setTimeout(async () => {
        try {
          await doInstance.alarm({ retryCount: 0, isRetry: false });
          // Cloudflare automatically clears alarm after successful execution
          alarmState.scheduledTime = null;
          alarmState.timeoutId = null;
        } catch (error) {
          console.error('Alarm simulation caught error in alarm():', error);
          // TODO: Implement retry logic with exponential backoff
        }
      }, delay);
    } else {
      // Immediate alarm
      setTimeout(async () => {
        try {
          await doInstance.alarm({ retryCount: 0, isRetry: false });
          alarmState.scheduledTime = null;
          alarmState.timeoutId = null;
        } catch (error) {
          console.error('Alarm simulation caught error in alarm():', error);
        }
      }, 0);
    }
    
    // Call original to maintain state
    return originalSetAlarm(scheduledTimeMs);
  };
  
  // Mock getAlarm
  doInstance.ctx.storage.getAlarm = () => {
    return alarmState.scheduledTime;
  };
  
  // Mock deleteAlarm
  doInstance.ctx.storage.deleteAlarm = () => {
    if (alarmState.timeoutId) {
      clearTimeout(alarmState.timeoutId);
      alarmState.timeoutId = null;
    }
    alarmState.scheduledTime = null;
    return originalDeleteAlarm();
  };
}
```

**Integration into @lumenize/testing**:

Option A: Automatic (invasive)
- `instrumentDOProject()` automatically wraps DOs with alarm simulation
- Pro: Zero config, alarms "just work"
- Con: Unexpected for users, harder to debug

Option B: Opt-in (safer)
- Add `simulateAlarms: true` option to `InstrumentDOProjectConfig`
- Pro: Explicit, clear when simulation is active
- Con: Requires opt-in (but alarms are opt-in anyway)

**Decision**: Option A (automatic simulation by default)

Rationale:
- Alarms don't work in vitest-pool-workers without `runDurableObjectAlarm()` workaround
- We want tests to work like production (alarms just fire)
- If users want @lumenize/rpc behavior without simulation, they should use `@lumenize/rpc` directly
- Compromise: Add `simulateAlarms: false` opt-out if needed

```typescript
const instrumented = instrumentDOProject({
  sourceModule,
  doClassNames: ['AlarmDO'],
  // simulateAlarms: false  // <-- Optional opt-out
});
```

#### Approach B: Custom alarms API (if Experiment 4.1 fails)

If we can't override `ctx.storage.*`, create parallel API:

```typescript
// In DO code
export class AlarmDO extends DurableObject {
  // User code uses this instead of ctx.storage.setAlarm
  setAlarm(scheduledTimeMs: number) {
    if (isTestEnvironment()) {
      // Use our simulation
      return this.#alarmSim.setAlarm(scheduledTimeMs);
    } else {
      // Production
      return this.ctx.storage.setAlarm(scheduledTimeMs);
    }
  }
}
```

**Pro**: Works regardless of mutability
**Con**: Less seamless, requires code changes, violates copy-paste principle

#### Approach C: RPC Client-Side Trap (if Approach A fails)

If `ctx.storage.*` is immutable, intercept at RPC client level:

```typescript
// In RPC client proxy
if (operationChain matches 'ctx.storage.setAlarm') {
  // Send special message type instead of normal RPC
  // Server-side handler installs alarm simulation
}
```

**Pro**: No user code changes, works with immutable storage
**Con**: Moderately complex, special-case handling in RPC layer

#### Retry Logic

Cloudflare alarms have automatic retry with exponential backoff:
- Starting at 2 second delay (2s, 4s, 8s, 16s, 32s, 64s)
- Up to 6 retries
- Only if alarm() throws

**Decision**: Speed up by 100x for tests (20ms, 40ms, 80ms, 160ms, 320ms, 640ms)
- Configurable for users who want exact timing
- Fancy future: monkey-patch `Date` during DO instrumentation to make times appear correct

**Simulation approach**:
```typescript
async function fireAlarmWithRetries(
  doInstance: any, 
  retryCount: number = 0,
  maxRetries: number = 6,
  timeScale: number = 100  // 100x faster for tests
): Promise<void> {
  try {
    await doInstance.alarm({ retryCount, isRetry: retryCount > 0 });
    // Success - clear alarm state
    alarmState.scheduledTime = null;
    alarmState.timeoutId = null;
  } catch (error) {
    if (retryCount < maxRetries) {
      // Cloudflare: 2s, 4s, 8s, 16s, 32s, 64s
      // Test default: 20ms, 40ms, 80ms, 160ms, 320ms, 640ms
      const cloudflareDelay = Math.pow(2, retryCount + 1) * 1000;
      const testDelay = cloudflareDelay / timeScale;
      console.log(`Alarm failed (retry ${retryCount + 1}/${maxRetries}), retrying in ${testDelay}ms`);
      alarmState.timeoutId = setTimeout(
        () => fireAlarmWithRetries(doInstance, retryCount + 1, maxRetries, timeScale),
        testDelay
      );
    } else {
      console.error('Alarm failed after max retries:', error);
      // Cloudflare would give up here too
      alarmState.scheduledTime = null;
      alarmState.timeoutId = null;
    }
  }
}
```

### Phase 6: Testing & Edge Cases

- [ ] Test alarm cancellation (deleteAlarm before fire)
- [ ] Test alarm override (setAlarm while one is pending)
- [ ] Test alarm in constructor (common pitfall)
- [ ] Test multiple DOs with different alarm schedules
- [ ] Test alarm failures and retry logic
- [ ] Test very short delays (< 10ms)
- [ ] Test very long delays (> 60s)
- [ ] Test alarm during DO eviction (can't really simulate, document limitation)
- [ ] Performance: Many alarms firing rapidly

### Phase 7: Documentation

**Goal**: Document alarm simulation for users

- [ ] Create `website/docs/testing/alarm-simulation.mdx`
- [ ] Update `website/docs/testing/usage.mdx` to mention alarm support
- [ ] Show before/after comparison (manual vs automatic)
- [ ] Document opt-in flag
- [ ] Document limitations:
  - Doesn't simulate DO eviction/restart scenarios
  - Retry timing may differ slightly from production
  - Clock behavior approximation (real clock vs frozen DO clock)
- [ ] Show debugging techniques (inspecting alarm state)
- [ ] Add to doc-test if appropriate

**Example content**:
````markdown
## Testing Alarms

By default, Cloudflare DO alarms don't fire in test environments. Enable simulation:

```typescript
const instrumented = instrumentDOProject({
  sourceModule,
  doClassNames: ['AlarmDO'],
  simulateAlarms: true
});
```

Now alarms fire automatically at the scheduled time:

```typescript
it('tests alarm automatically fires', async () => {
  using client = createTestingClient<typeof AlarmDO>('ALARM_DO', 'auto');
  
  // Schedule alarm for 100ms from now
  await client.ctx.storage.setAlarm(Date.now() + 100);
  
  // Wait for alarm to fire (no manual runDurableObjectAlarm needed!)
  await vi.waitFor(async () => {
    const executed = await client.getExecutedAlarms();
    expect(executed.length).toBe(1);
  });
});
```
````

### Phase 8: Polish & Release Prep

- [ ] Add JSDoc comments to all new functions
- [ ] Update package README if needed
- [ ] Run full test suite
- [ ] Update CHANGELOG
- [ ] Consider adding to Actor/Alarms doc-tests as an example

## Open Questions

1. **Experiment 4.1 outcome**: Can we override ctx.storage methods?
   - If yes: Proceed with Approach A (transparent mocking)
   - If no: Need Approach B (custom API) or give up on seamless integration

2. **Transport switching for createTestingClient**: ✅ DECIDED
   - **Switch to WebSocket default** (breaking change, but right choice)
   - Accept `onDownstream`/`onClose` config in `createTestingClient`

3. **Opt-in vs automatic**: ✅ DECIDED
   - **Automatic by default** - alarms just work in tests
   - Optional `simulateAlarms: false` to disable if needed

4. **Retry simulation fidelity**: ✅ DECIDED
   - **100x faster by default** (20ms, 40ms, 80ms... instead of 2s, 4s, 8s...)
   - Make configurable (some users may want exact timing)
   - Future fancy: monkey-patch `Date` to make apparent times correct

5. **Time control**:
   - Should we provide `vi.setSystemTime()` equivalent for alarm testing?
   - Or rely on natural setTimeout timing?

6. **Multiple alarms limitation**: ✅ DECIDED
   - **Exactly match Cloudflare behavior** - new setAlarm silently overwrites pending alarm
   - No warnings, no errors - just matches production
   - Note: This testing work enables building @lumenize/alarms (multiplexing single alarm)

## Success Criteria

- ✅ Can write alarm tests without manual `runDurableObjectAlarm()` calls
- ✅ Alarms fire at approximately the right time (within vitest timeout resolution)
- ✅ Retry logic simulates Cloudflare behavior
- ✅ Downstream messaging fully documented and usable
- ✅ All existing tests still pass
- ✅ Documentation clearly explains opt-in and limitations
- ✅ Test coverage >80% for new alarm simulation code

## Notes

### Related Files to Study

- `packages/testing/src/instrument-do-project.ts` - Where we'd add simulateAlarms option
- `doc-test/actors/alarms/basic-usage/test/basic-usage.test.ts` - Current manual approach
- `packages/proxy-fetch/ASYNC_FETCH_EXPERIMENTS.md` - Clock behavior insights
- Cloudflare docs: https://developers.cloudflare.com/durable-objects/api/alarms/

### Alternative: Time-travel testing

Instead of real setTimeout, could we provide a "mock clock" that advances on demand?

```typescript
it('tests alarm with mock clock', async () => {
  using client = createTestingClient<typeof AlarmDO>('ALARM_DO', 'mock-time');
  
  await client.ctx.storage.setAlarm(Date.now() + 10000); // 10 seconds
  
  // Advance test time by 10 seconds
  await advanceTime(10000);
  
  // Alarm should have fired
  const executed = await client.getExecutedAlarms();
  expect(executed.length).toBe(1);
});
```

**Pros**:
- Instant test execution (no real waiting)
- Deterministic timing
- Can test very long alarms quickly

**Cons**:
- Much more complex to implement
- Needs to intercept Date.now(), setTimeout, setInterval
- May not work well with Cloudflare's frozen clock
- Out of scope for initial implementation

**Decision**: Defer to future if needed. Real setTimeout is simpler and "good enough".


