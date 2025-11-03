# @lumenize/alarms - First NADIS Injectable

## Status: Planning

## Goal
Create a Lumenize-native alarms package that enables multiple scheduled tasks per Durable Object without requiring inheritance from Actor base class. This will be the first implementation of NADIS (Not A DI System) - demonstrating the pattern for all future injectables.

**Strategy Update (2025-11-03)**: Instead of reimplementing from scratch, **adapt Actor's Alarms code** to work without their base class and Storage wrapper. This reduces risk and leverages their proven implementation.

## Context & Motivation

### Current State (@cloudflare/actors/alarms)
- Requires extending `Actor` base class
- Requires `Storage` wrapper from `@cloudflare/actors/storage`
- Complex initialization with `blockConcurrencyWhile`, `setName()`, etc.
- Works well but forces architectural decisions on users

### Why Build Our Own
1. **NADIS Principle**: Every injectable should work TWO ways:
   - Via injection: `this.#svc.alarms.schedule(...)`
   - Standalone: `import { Alarms } from '@lumenize/alarms'; this.alarms = new Alarms(this.ctx, this);`
   
2. **Flexibility**: Don't force base class inheritance - align with Lumenize mixin/composition philosophy

3. **Learning Opportunity**: First NADIS implementation sets patterns for all future injectables

### What We Learned (2025-11-02 Investigation)

#### Key Discovery: Storage Wrapper Magic
Through systematic elimination (brilliant suggestion to copy Actor and strip it down):
- ✅ **With Storage wrapper**: `setAlarm()` gets called by Alarms class
- ❌ **Without Storage wrapper**: Alarms only schedules in SQL, no native alarm
- ⚠️ **With Storage wrapper BUT without full Actor init**: Still doesn't fire reliably

This suggests Storage wrapper intercepts or wraps `state.storage.setAlarm()` somehow.

#### What Works
```typescript
// Actor-based (fully working)
class MyDO extends Actor<Env> {
  async alarm() {
    await this.alarms.alarm(); // boilerplate
  }
  
  async handleAlarm(payload: any, schedule: Schedule) {
    // your code
  }
}
```

#### What Doesn't Work (Yet)
```typescript
// Plain DO with manual Alarms setup
class MyDO extends DurableObject<Env> {
  constructor(state, env) {
    super(state, env);
    this.storage = new Storage(state.storage); // Key piece
    this.alarms = new Alarms(state, this);
  }
  // Even with this, alarms don't fire reliably in tests
}
```

## Investigation Needed

### Phase 0: Understand Actor's Dependencies (Before Extraction)

**Priority 1: Storage Wrapper Analysis**
- [ ] Read `@cloudflare/actors/storage` source code
- [ ] Determine if Storage wrapper is needed or if we can use `ctx.storage` directly
- [ ] Test hypothesis: Can Actor's Alarms code work with plain `ctx.storage.setAlarm()`?
- [ ] Document: What (if anything) does Storage wrapper add beyond proxying?

**Priority 2: Actor Base Class Dependencies**
- [ ] Identify all Actor base class methods/properties used by Alarms
- [ ] What does `blockConcurrencyWhile` do during Alarms initialization?
- [ ] Can we replace Actor-specific code with plain DO equivalents?
- [ ] What is `setName()` / `actorName` used for? (SQL identifier column)

**Priority 3: License & Attribution**
- [x] Check `@cloudflare/actors` license: **MIT License** ✅ (can adapt freely)
  - Copyright (c) 2025 Brayden Wilmoth
  - Must include copyright notice and license text
- [ ] Plan proper attribution in source files
- [ ] Add entry to ATTRIBUTIONS.md with:
  - Source: `@cloudflare/actors/alarms`
  - License: MIT
  - Purpose: Adapted Alarms class for standalone use without Actor base class

## Proposed Architecture

### Core Principles (NADIS Pattern)

1. **Standalone Usage** (more boilerplate):
```typescript
import { Alarms } from '@lumenize/alarms';

class MyDO extends DurableObject<Env> {
  #alarms: Alarms;
  
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#alarms = new Alarms(state, this);
  }
  
  async alarm() {
    await this.#alarms.alarm();
  }
  
  async handleAlarm(payload: any, schedule: Schedule) {
    // your code
  }
}
```

2. **Injectable Usage** (less boilerplate):
```typescript
import { LumenizeBase } from '@lumenize/base';

class MyDO extends LumenizeBase<Env> {
  // this.#svc.alarms is automatically available
  
  async handleAlarm(payload: any, schedule: Schedule) {
    // your code - alarm() boilerplate handled by LumenizeBase
  }
}
```

### Design Questions

**Q1: How do we handle the `alarm()` boilerplate?**
- Option A: User must implement `alarm()` that delegates (like Actor)
- Option B: LumenizeBase auto-implements `alarm()` and routes to `handleAlarm()`
- Option C: Some clever Proxy/Symbol magic?

**Q2: Do we need our own Storage wrapper?**
- If yes: What's the minimal functionality needed?
- If no: How do we make native alarms work without it?

**Q3: SQL vs KV for alarm storage?**
- Actor uses SQLite (`_actor_alarms` table)
- Pros: Can query, atomic operations
- Cons: Schema migrations, complexity
- Could we use KV instead? Tradeoffs?

**Q4: Per-request/message instance (`scp`)?**
- Alarms are instance-level, not request-level
- Do we need `scp.alarms` at all, or just `this.#svc.alarms`?

### Alarm Scheduling Strategy

**Decision: Use Ordered List Approach (Most Efficient)**

#### Actor Alarms Already Uses Ordered List! (2025-11-03 Verification)
**Verified**: Actor's implementation DOES use the ordered list approach:
- Queries SQL for earliest alarm: `SELECT time FROM _actor_alarms ORDER BY time ASC LIMIT 1`
- Schedules native alarm for that **exact time** (not a fixed cadence)
- Re-schedules after every schedule/cancel operation
- This is the efficient approach we want to replicate!

#### Our Recommended Approach: Ordered List with Dynamic Scheduling

```typescript
class AlarmScheduler {
  alarms: SortedList<Alarm>;  // Sorted by dueTime
  
  scheduleAlarm(alarm: Alarm) {
    this.alarms.insert(alarm);
    
    // Only reschedule native alarm if this becomes the earliest
    if (alarm === this.alarms.first()) {
      ctx.storage.setAlarm(alarm.dueTime);
    }
  }
  
  async alarm() {
    const now = Date.now();
    
    // Fire all alarms that are due (could be multiple if timing is tight)
    while (this.alarms.first()?.dueTime <= now) {
      const alarm = this.alarms.removeFirst();
      await alarm.handler();
      
      // If recurring (cron), calculate next and re-insert
      if (alarm.isRecurring()) {
        alarm.dueTime = this.calculateNext(alarm);
        this.alarms.insert(alarm);
      }
    }
    
    // Schedule next alarm (if any remaining)
    if (this.alarms.first()) {
      ctx.storage.setAlarm(this.alarms.first().dueTime);
    }
  }
}
```

**Benefits**:
- Minimal `setAlarm()` calls (only when top of queue changes)
- No wasted wake-ups (sleep until actually needed)
- Scales to thousands of alarms efficiently
- Natural handling of multiple alarms at same time

#### Cron Behavior: Skip Missed Runs (Like Unix Cron)

**Decision**: Follow Unix cron behavior - **do NOT catch up** on missed runs.

**Rationale**:
- Unix cron skips missed runs (server down during scheduled time → waits for next occurrence)
- Catching up can be dangerous:
  - Cleanup jobs processing stale data incorrectly
  - Notifications sent hours late (often worse than not sending)
  - Running 100 missed "every minute" jobs could overwhelm the system
- Most use cases expect "next occurrence from now", not retroactive execution

**Implementation**:
```typescript
class CronAlarm {
  cronSpec: string;
  lastRunTime: number | null;
  
  calculateNext(fromTime: number): number {
    // Always calculate from current time, never try to "catch up"
    return nextCronMatch(this.cronSpec, Date.now());
  }
  
  async run() {
    const now = Date.now();
    
    // Optionally detect missed runs (for monitoring/alerting, not execution)
    if (this.lastRunTime) {
      const expectedRuns = this.countExpectedRunsSince(this.lastRunTime, now);
      if (expectedRuns > 1) {
        console.warn(`Missed ${expectedRuns - 1} cron runs`, {
          lastRun: this.lastRunTime,
          now,
          spec: this.cronSpec
        });
      }
    }
    
    // Run the handler
    await this.handler();
    this.lastRunTime = now;
    
    // Schedule NEXT occurrence from NOW (not from last run time)
    return this.calculateNext(now);
  }
}
```

#### Edge Cases to Handle

1. **Clock skew/backwards time**:
   - If `Date.now() < lastRunTime`: Skip run (likely clock adjustment)
   - Or run immediately if difference is small (< 1 minute)
   
2. **Long-running handler**:
   - If handler takes longer than cron interval, don't queue up runs
   - Calculate next occurrence from when it **finishes**, not when it **started**
   - Prevents "every 5 minutes" job that takes 10 minutes from stacking up
   
3. **Alarms at exact same time**:
   - Fire in insertion order (stable sort)
   - Or assign priority/ordering to alarm types if needed
   
4. **DO eviction/reloading**:
   - Persist alarm list to storage (SQL or KV)
   - Reload on constructor and reschedule earliest alarm
   - Ensure `lastRunTime` is persisted for cron tracking

#### Observability & Debugging

Track metrics for each alarm:
```typescript
interface AlarmMetrics {
  totalRuns: number;
  missedRuns: number;      // Detected but skipped
  lastRunTime: number;
  lastRunDuration: number;
  lastMissedTime?: number;
  failureCount: number;
}
```

**Benefits**:
- Visibility into alarm health without dangerous catch-up behavior
- Can alert on missed runs without executing them
- Performance tracking (handler duration)

## Implementation Phases

### Phase 1: Extract & Adapt Actor's Alarms Code
**Goal**: Copy Actor's Alarms implementation and make it work standalone

- [ ] Copy Actor's `Alarms` class source code to `packages/alarms/src/`
- [ ] Remove dependencies on Actor base class (constructor params, etc.)
- [ ] Remove/adapt Storage wrapper dependencies
  - Identify what Storage wrapper does for `setAlarm()` integration
  - Replace with direct `ctx.storage.setAlarm()` calls
- [ ] Update constructor to accept `(ctx: DurableObjectState, parent: any)`
- [ ] Test: Can we schedule AND execute alarms without Actor base class?
- [ ] Document findings in this task file

**Success Criteria**: Actor's code works in plain `DurableObject` without modifications to DO class

**Key Question**: Does Storage wrapper do anything special, or can we just use `ctx.storage.setAlarm()` directly?

### Phase 2: Clean Up & Enhance
**Goal**: Polish the adapted code, add Lumenize patterns

- [ ] Clean up Actor-specific code (remove unnecessary complexity)
- [ ] Add proper TypeScript types for all methods
- [ ] Implement cron skipping missed runs (if Actor doesn't already)
- [ ] Add observability metrics (AlarmMetrics interface)
- [ ] Write comprehensive tests using `@lumenize/testing`
  - Test all schedule types: Date, delay (seconds), cron
  - Test cancellation
  - Test multiple alarms
- [ ] Create doc-test showing standalone usage

**Success Criteria**: 
- All features from Actor's Alarms work
- Code is cleaner/simpler than Actor's version
- Test coverage >80% branch
- Works with `@lumenize/testing` alarm simulation

### Phase 3: NADIS Integration
**Goal**: Make it work as an injectable

- [ ] Design `LumenizeBase` service injection pattern
- [ ] Implement `this.#svc.alarms` registration
- [ ] Auto-implement `alarm()` delegation in base class
- [ ] Update doc-test showing both usage patterns
- [ ] Document NADIS pattern for future injectables

**Success Criteria**:
- Both usage patterns work
- Clear documentation on when to use each
- Pattern established for other injectables

### Phase 4: Polish & Ship
- [ ] API documentation (TypeDoc)
- [ ] Migration guide from `@cloudflare/actors/alarms`
- [ ] Performance testing (is our SQL implementation efficient?)
- [ ] Publish to npm
- [ ] Announce on website

## Open Questions

1. **Compatibility**: Should our API be identical to Actor's for easy migration?
2. **Dependencies**: Can we avoid depending on `@cloudflare/actors` at all?
3. **Testing**: Do we need special test utilities like Actor provides?
4. **Edge Cases**: How do Actor's alarms handle DO eviction/reloading?
5. **Observability**: Should we add logging/metrics beyond what Actor provides?

## Success Metrics

- [ ] Works with plain `DurableObject` (no base class required)
- [ ] Works as injectable via `LumenizeBase`
- [ ] All alarm types supported (Date, delay, cron)
- [ ] Test coverage >80% branch
- [ ] Documentation quality (working examples in doc-tests)
- [ ] Performance: No slower than `@cloudflare/actors/alarms`
- [ ] Clear NADIS pattern for future injectables

## Related Tasks

- **Prerequisite**: None (this is the first NADIS injectable!)
- **Blocks**: All future NADIS injectables follow this pattern
- **Related**: `tasks/backlog.md` - "Integrate runDurableObjectAlarm into @lumenize/testing"

## Notes & Learnings

### 2025-11-02: Initial Investigation
- Discovered Storage wrapper is essential for native alarm integration
- Plain Alarms instantiation schedules in SQL but doesn't trigger native alarms
- Actor base class handles complex initialization we haven't fully replicated
- Tests pass for Actor-based approach, fail for plain DO approach
- Need to understand what Storage wrapper actually does

### 2025-11-03: Alarm Scheduling Strategy Design
- **Verified Actor Alarms uses ordered list approach** (not periodic wake-up as initially assumed!)
- Examined source: `_scheduleNextAlarm()` queries SQL for earliest alarm and schedules exactly
- **Strategic Decision: Adapt Actor's code** rather than reimplement from scratch
  - Reduces risk, leverages proven implementation
  - Focus on removing base class / Storage wrapper dependencies
  - Add NADIS (injectable) pattern support
- **Cron behavior**: Skip missed runs (like Unix cron), don't catch up
- Rationale: Catching up is often more dangerous than skipping
- Will track missed runs for monitoring/alerting without executing them
- Identified 4 key edge cases: clock skew, long handlers, same-time alarms, DO eviction
- Designed observability metrics for debugging without complexity

**100x Speedup Issue Explained**:
- The problem with Actor Alarms + 100x speedup was our `@lumenize/testing` simulation
- Actor may call `setAlarm()` hundreds of times during initialization (synchronously)
- Each call cleared the previous `setTimeout` in our simulation
- With 100x speedup, timeouts fired before Actor finished setup → missed alarms
- With 1x speedup, plenty of time for Actor to finish before timeout fires
- This is an artifact of our simulation's `setTimeout` approach, not Actor's design
- Real Cloudflare `setAlarm()` doesn't have this issue (native operation)

### Future: (Add learnings as we go)

---

## Next Steps (Immediate)

1. ✅ Create this task file (DONE)
2. ✅ Verify Actor Alarms scheduling strategy (ordered list confirmed!)
3. ✅ Verify license compatibility (MIT - all good!)
4. ✅ Decide on strategy: **Adapt Actor's code** (vs reimplement)
5. Clean up `doc-test/actors/alarms/basic-usage/` to ONLY show Actor approach
6. Ship doc-test to website
7. Start Phase 0: Analyze Actor's dependencies (Storage wrapper, base class)
8. Start Phase 1: Extract and adapt Alarms code


