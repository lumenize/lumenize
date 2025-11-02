# @lumenize/alarms - First NADIS Injectable

## Status: Planning

## Goal
Create a Lumenize-native alarms package that enables multiple scheduled tasks per Durable Object without requiring inheritance from Actor base class. This will be the first implementation of NADIS (Not A DI System) - demonstrating the pattern for all future injectables.

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

### Phase 0: Deep Dive (Before Implementation)

**Priority 1: Understand Storage Wrapper**
- [ ] Read `@cloudflare/actors/storage` source code
- [ ] Identify what it does to make `setAlarm()` work
- [ ] Determine if we can replicate just that functionality
- [ ] Test: Can we create minimal wrapper that only handles alarm integration?

**Priority 2: Understand Actor Initialization**
- [ ] What does Actor's `blockConcurrencyWhile` do for alarms?
- [ ] When/why is `setName()` called, and why does it matter?
- [ ] Is there state loading that affects alarm scheduling?

**Priority 3: Test Environment Considerations**
- [ ] Why does `runDurableObjectAlarm()` return false for plain DOs?
- [ ] Is this a test harness limitation or real runtime behavior?
- [ ] Can we test alarm firing in local dev without `runDurableObjectAlarm()`?

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

## Implementation Phases

### Phase 1: Research & Proof of Concept
**Goal**: Understand Storage wrapper, create minimal working version

- [ ] Clone `@cloudflare/actors` repo, study Storage implementation
- [ ] Identify minimal code needed to make `setAlarm()` work
- [ ] Create `packages/alarms/` with experimental implementation
- [ ] Test: Can we schedule AND execute alarms without Actor base class?
- [ ] Document findings in this task file

**Success Criteria**: One alarm fires reliably in test environment

### Phase 2: Core Implementation
**Goal**: Feature-complete standalone package

- [ ] Implement `Alarms` class API (compatible with Actor's API for familiarity)
- [ ] Support all schedule types: Date, delay (seconds), cron
- [ ] SQL storage for multiple alarms (or decide on alternative)
- [ ] Handle alarm execution and rescheduling (cron)
- [ ] Write comprehensive tests
- [ ] Create doc-test showing standalone usage

**Success Criteria**: 
- All features from `@cloudflare/actors/alarms` work
- No base class required
- Test coverage >80% branch

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

### Future: (Add learnings as we go)

---

## Next Steps (Immediate)

1. ✅ Create this task file (DONE)
2. Clean up `doc-test/actors/alarms/basic-usage/` to ONLY show Actor approach
3. Ship doc-test to website
4. Add backlog item: "Investigate Storage wrapper source code for @lumenize/alarms"
5. Take break (social stuff)
6. Return and start Phase 1 research


