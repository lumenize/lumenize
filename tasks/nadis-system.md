# NADIS System - Not A DI System

## Status: Design & Prototype

## Goal
Create the NADIS (Not A DI System) architecture that enables:
1. **Injectables work standalone** - No base class required
2. **Auto-injection via LumenizeBase** - Convenient, less boilerplate
3. **Clear dependency relationships** - Injectables can depend on other injectables
4. **Simple, de✨light✨ful API** - Easy to understand and use

This task encompasses building three foundational packages:
- `@lumenize/core` - Universal injectables (starting with `sql`)
- `@lumenize/alarms` - Second injectable, proves dependency pattern
- `@lumenize/lumenize-base` - LumenizeBase class with auto-injection

## Context

We're building the foundational architecture for Lumenize's plugin/injectable system. This will establish patterns for all future functionality (cache, sessions, etc.).

### Core Design Principle

**Every injectable must work TWO ways:**
1. **Standalone**: `const alarms = new Alarms(this)` - works in any DurableObject
2. **Injected**: `this.svc.alarms` - auto-wired in LumenizeBase

### Why "Not A DI System"?

It's technically dependency injection, but we're keeping it:
- Simple (no containers, no decorators, no magic)
- Explicit (you can see what's happening)
- Optional (base class is convenience, not requirement)

## Key Architectural Decisions

### NADIS Service Naming Convention

**Decision (2025-11-04): Use string-based naming convention for NADIS services**

```typescript
// ✅ Use strings (RECOMMENDED)
this.svc.sql`SELECT * FROM users`;
this.svc.alarms.schedule(...);

// ❌ Don't use Symbols
export const NADIS_SQL = Symbol('nadis:sql');
this.svc[NADIS_SQL]`SELECT ...`; // Less ergonomic
```

**Rationale**:
1. **Simplicity**: `this.svc.sql` is more de✨light✨ful than `this.svc[NADIS_SQL]`
2. **Debuggability**: See `'sql'` in logs/debugger, not `Symbol(nadis:sql)`
3. **Accessibility**: Strings are familiar to vibe coders (no Symbol expertise needed)
4. **No foot-guns**: Collision risk is theoretical - we control the NADIS namespace
5. **Type safety**: Works perfectly with TypeScript declaration merging (see below)

### Automatic Type Safety via Declaration Merging

**The Magic**: Each injectable package augments a global `LumenizeServices` interface. TypeScript automatically merges all augmentations, giving full type safety without manual registration!

**How it works:**

```typescript
// @lumenize/core/src/sql.ts
export function sql(doInstance: any) {
  const ctx = doInstance.ctx;
  
  return (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.reduce((acc, str, i) => 
      acc + str + (i < values.length ? "?" : ""), ""
    );
    return [...ctx.storage.sql.exec(query, ...values)];
  };
}

// Augment global types - TypeScript merges this automatically
declare global {
  interface LumenizeServices {
    sql: ReturnType<typeof sql>;
  }
}

// @lumenize/alarms/src/alarms.ts
export class Alarms {
  // ... implementation
}

// Each package augments the same interface
declare global {
  interface LumenizeServices {
    alarms: Alarms;
  }
}

// @lumenize/lumenize-base/src/lumenize-base.ts
declare global {
  interface LumenizeServices {} // Empty base - packages fill it in
}

export class LumenizeBase<Env> extends DurableObject<Env> {
  #svcCache = new Map<string, any>();
  
  get svc(): LumenizeServices {
    return new Proxy({} as LumenizeServices, {
      get: (_, key: string) => {
        // Check cache first
        if (this.#svcCache.has(key)) {
          return this.#svcCache.get(key);
        }
        
        // Instantiate on first access
        let instance: any;
        if (key === 'sql') {
          instance = sql(this);
        } else if (key === 'alarms') {
          instance = new Alarms(this);
        }
        // ... more services as needed
        
        if (!instance) {
          throw new Error(`NADIS service '${key}' not found`);
        }
        
        this.#svcCache.set(key, instance);
        return instance;
      }
    });
  }
}
```

**User experience:**
```typescript
import { Alarms } from '@lumenize/alarms'; // Types auto-merge!

class MyDO extends LumenizeBase<Env> {
  async doWork() {
    // Full TypeScript autocomplete and type checking!
    this.svc.sql`SELECT * FROM users WHERE id = ${userId}`;
    this.svc.alarms.schedule(new Date(), 'myHandler', { data: 'test' });
  }
}
```

**Benefits**:
- ✅ No manual type registration needed
- ✅ Type safety automatic when you import a package
- ✅ Lazy instantiation (services created on first access)
- ✅ Each package declares its own types independently
- ✅ TypeScript merges all augmentations automatically
- ✅ IntelliSense shows all available services

### Injectable Context Access

**Decision**: Inject `this` (the DO instance), not just `ctx`

```typescript
// ✅ Good: Full access
new Alarms(this)  // Gets this.ctx, this.env, this.svc

// ❌ Less flexible
new Alarms(ctx)   // Only gets ctx, needs separate params for dependencies
```

**Benefits**:
- Injectables can access `doInstance.ctx`, `doInstance.env`
- Can discover other injectables via `doInstance.svc`
- Single parameter keeps API simple

### Injectable Dependency Resolution

**Decision**: Auto-discover from `doInstance.svc` with lazy instantiation via Proxy

```typescript
// In Alarms class (stateful, needs dependencies)
constructor(doInstance: any) {
  this.#ctx = doInstance.ctx;
  this.#doInstance = doInstance;
  
  // Lazy access: only instantiate sql if/when needed
  // Works for both standalone and injected modes
}

get #sql() {
  // Access via svc if available (injected mode)
  if (this.#doInstance.svc?.sql) {
    return this.#doInstance.svc.sql;
  }
  
  // Fallback: create and cache standalone instance
  if (!this.#sqlStandalone) {
    this.#sqlStandalone = sql(this.#doInstance);
  }
  return this.#sqlStandalone;
}
```

**Benefits**:
- Works in LumenizeBase (finds via svc)
- Works standalone (creates own instance)
- Lazy instantiation (only create when needed)
- No explicit dependency parameter needed

**Alternative considered**:
```typescript
// Explicit dependencies
new Alarms(this, { sql: mySql })

// Pros: Clear, testable
// Cons: More boilerplate, not "de✨light✨ful"
```

### Factory Functions vs Classes for Injectables

**Decision**: Use **factory functions for stateless injectables**, **classes for stateful ones**

**Factory functions (stateless):**
```typescript
// @lumenize/core/src/sql.ts
export function sql(doInstance: any) {
  const ctx = doInstance.ctx;
  
  return (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.reduce((acc, str, i) => 
      acc + str + (i < values.length ? "?" : ""), ""
    );
    return [...ctx.storage.sql.exec(query, ...values)];
  };
}

// Usage - beautiful template literal syntax!
this.svc.sql`SELECT * FROM users WHERE id = ${userId}`;
```

**Classes (stateful, with dependencies):**
```typescript
// @lumenize/alarms/src/alarms.ts
export class Alarms {
  #ctx: DurableObjectState;
  #doInstance: any;
  #sqlStandalone?: ReturnType<typeof sql>;
  
  constructor(doInstance: any) {
    this.#ctx = doInstance.ctx;
    this.#doInstance = doInstance;
  }
  
  get #sql() {
    return this.#doInstance.svc?.sql || (
      this.#sqlStandalone ??= sql(this.#doInstance)
    );
  }
  
  schedule(when: Date, callback: string, payload?: any) {
    // Uses this.#sql for database operations
    this.#sql`INSERT INTO _lumenize_alarms ...`;
  }
}

// Usage - clear method calls
this.svc.alarms.schedule(new Date(), 'myHandler');
```

**Rationale**:
- **Functions for pure wrappers**: Sql is just a thin wrapper around `ctx.storage.sql` - no state needed
- **Classes for complex logic**: Alarms has state, lifecycle, dependencies
- **Ergonomics matter**: `this.svc.sql\`...\`` is more beautiful than `this.svc.sql.exec\`...\``
- **Testability**: Both are equally testable by mocking at the DO level

### What Goes in `svc` vs Standalone?

**Decision**: `svc` is for injectables, utilities are separate imports

```typescript
// Injectables (need DO context, go in svc)
this.svc.sql       // Needs ctx.storage.sql
this.svc.alarms    // Needs ctx, uses sql
this.svc.cache     // Needs ctx.storage

// Utilities (stateless, imported directly)
import { getDOStub, routeDORequest } from '@lumenize/utils';
```

### Injectable Initialization Order

**Decision**: Dependencies first, dependents second

```typescript
this.svc = {
  sql: new Sql(this),              // No dependencies
  alarms: new Alarms(this),         // Depends on sql (auto-discovers)
  cache: new Cache(this),           // Depends on sql (auto-discovers)
};
```

**Note**: Since injectables auto-discover, order matters less, but keep it logical.

### LumenizeBase Registration Strategy

**Options:**

**A) Manual registration (Phase 1 approach)**
```typescript
class LumenizeBase {
  constructor(ctx, env) {
    super(ctx, env);
    this.svc = {
      sql: new Sql(this),
      alarms: new Alarms(this),
    };
  }
}
```

**B) Plugin registry (Future enhancement)**
```typescript
// In user code:
LumenizeBase.register('myPlugin', MyPlugin);

// LumenizeBase auto-injects registered plugins
class LumenizeBase {
  constructor(ctx, env) {
    super(ctx, env);
    this.svc = this.#initializePlugins();
  }
}
```

**Decision**: Start with A (manual), plan for B later

## Package Structure

```
@lumenize/core              # Foundational injectables (sql, future: routing-think hono)
@lumenize/lumenize-base     # LumenizeBase class with NADIS
@lumenize/lumenize          # Future: Lumenize class (extends LumenizeBase, batteries-included)
@lumenize/alarms            # Alarms injectable (depends on core)
@lumenize/rpc               # Future injectable
@lumenize/mcp               # Future injectable
@lumenize/[feature]         # Each feature is a separate injectable
```

### Why This Structure?

1. **Core** = universal injectables nearly every DO needs
2. **LumenizeBase** = minimal base class with NADIS auto-injection
3. **Lumenize** = future batteries-included base class (extends LumenizeBase)
4. **Feature packages** = optional, install as needed

### License Strategy

- `@lumenize/core` - **MIT** (universal utility, liberally licensed)
- `@lumenize/lumenize-base` - **MIT** (minimal base class, liberally licensed)
- `@lumenize/lumenize` - **BSI-1.1** (future, batteries-included framework piece)
- `@lumenize/alarms` - **MIT** (adapted from MIT-licensed Actor code)

## Implementation Plan

### Phase 1: @lumenize/core (sql injectable)
**Goal**: Get basic NADIS pattern working with simplest injectable

#### Package Setup
- [ ] Create `packages/core/` package structure
  - [ ] `package.json` with MIT license
  - [ ] `src/index.ts` for exports
  - [ ] `src/sql.ts` - Sql injectable
  - [ ] `tsconfig.json` extending root
  - [ ] `README.md` with link to docs

#### Sql Injectable Implementation

**Factory function approach** (stateless, beautiful syntax):

```typescript
// @lumenize/core/src/sql.ts
/**
 * SQL template literal tag for Durable Object storage.
 * 
 * @example
 * ```typescript
 * const users = sql(this)`SELECT * FROM users WHERE id = ${userId}`;
 * ```
 */
export function sql(doInstance: any) {
  const ctx = doInstance.ctx;
  
  return (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.reduce((acc, str, i) => 
      acc + str + (i < values.length ? "?" : ""), ""
    );
    return [...ctx.storage.sql.exec(query, ...values)];
  };
}

// TypeScript declaration merging magic - adds to global LumenizeServices
declare global {
  interface LumenizeServices {
    sql: ReturnType<typeof sql>;
  }
}
```

**Key features:**
- Factory function returns template literal tag function
- Zero state (stateless wrapper)
- Beautiful syntax: `sql(this)\`SELECT ...\`` or `this.svc.sql\`SELECT ...\``
- Automatic type safety via declaration merging

#### Testing
- [ ] Create minimal test DO that uses `sql(this)` standalone
- [ ] Test SQL template literal syntax
- [ ] Test query execution and results
- [ ] Test with multiple queries
- [ ] Verify type safety (TypeScript should catch errors)

**Success Criteria**: 
- Sql injectable works standalone
- API feels right (de✨light✨ful)
- Tests pass with >80% branch coverage

### Phase 2: @lumenize/alarms (proving dependencies)
**Goal**: Validate NADIS pattern with a dependent injectable

#### Background: @cloudflare/actors/alarms Investigation

**Current State:**
- Actor's Alarms requires extending `Actor` base class
- Uses `Storage` wrapper from `@cloudflare/actors/storage`
- Complex initialization with `blockConcurrencyWhile`, `setName()`, etc.
- Works well but forces architectural decisions on users

**Our Strategy (2025-11-03):** Instead of reimplementing from scratch, **adapt Actor's Alarms code** to work without their base class and Storage wrapper. This reduces risk and leverages their proven implementation.

**License:** MIT (Copyright 2025 Brayden Wilmoth) - we can freely adapt with attribution

#### What We Learned

**Storage Wrapper Investigation (2025-11-04):**
- ✅ **Storage wrapper is NOT needed for alarms!**
- Examined Actor source: Alarms receives `ctx` directly, not Storage wrapper
- Storage wrapper is just SQL convenience (template tags, migrations)
- Storage wrapper does NOT wrap alarm methods
- Alarms uses plain `ctx.storage.setAlarm()` and `ctx.storage.sql`
- **Path forward is clear**: Copy Alarms class, works with plain `ctx.storage`

**Actor Base Class Dependencies:**
- Constructor passes `ctx` and `this` (parent)
- Alarms calls `this.parent[row.callback]` to invoke handlers
- Uses `ctx.blockConcurrencyWhile()` during initialization (standard DO API!)
- `actorName` / `setName()` used for SQL identifier column (multi-tenancy feature)

**Alarm Scheduling Strategy (2025-11-03):**
- **Verified**: Actor uses ordered list approach (NOT periodic wake-up!)
- Queries SQL for earliest alarm: `SELECT time FROM _actor_alarms ORDER BY time ASC LIMIT 1`
- Schedules native alarm for that **exact time** (efficient!)
- Re-schedules after every schedule/cancel operation
- This is exactly what we want to replicate

#### Alarm Scheduling Design Decisions

**Decision: Use Ordered List Approach (Most Efficient)**

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

**Cron Behavior: Skip Missed Runs (Like Unix Cron)**

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

**Edge Cases to Handle:**

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

**Observability & Debugging:**

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

#### Package Setup & Extraction
- [ ] Create `packages/alarms/` directory structure
  - [ ] `package.json` with MIT license, dependencies on `@lumenize/core`
  - [ ] `src/index.ts` for main exports
  - [ ] `tsconfig.json` extending root
  - [ ] `README.md` with attribution to Actor
  
- [ ] Add entry to `ATTRIBUTIONS.md`:
  - Source: `@cloudflare/actors/alarms`
  - License: MIT
  - Copyright: (c) 2025 Brayden Wilmoth
  - Purpose: Adapted Alarms class for standalone use without Actor base class

- [ ] Copy Actor's `Alarms` class source to `src/alarms.ts`
  - [ ] Add MIT license header with attribution to Brayden Wilmoth
  - [ ] Convert from JavaScript to TypeScript
  - [ ] Add proper type annotations

#### Adaptation Work
- [ ] Simplify constructor: `constructor(doInstance: any)`
  - Already takes `ctx` and `parent`! Just update signature
  - Store `doInstance` for lazy sql access
  
- [ ] Add lazy `sql` dependency resolution
  ```typescript
  #doInstance: any;
  #sqlStandalone?: ReturnType<typeof sql>;
  
  get #sql() {
    // Use injected sql if available (LumenizeBase mode)
    if (this.#doInstance.svc?.sql) {
      return this.#doInstance.svc.sql;
    }
    
    // Fallback: create standalone instance (plain DurableObject mode)
    if (!this.#sqlStandalone) {
      this.#sqlStandalone = sql(this.#doInstance);
    }
    return this.#sqlStandalone;
  }
  ```
  
- [ ] Remove/simplify `actorName` feature
  - Actor uses this for multi-tenancy (multiple alarm sets per DO)
  - For v1, simplify to single alarm set per DO
  - Remove `identifier` column from SQL schema
  - Remove `setName()` logic
  
- [ ] Keep `ctx.blockConcurrencyWhile()` for SQL table initialization
  - This is a standard DO API, not Actor-specific
  
- [ ] Replace Actor's Storage wrapper with `sql` injectable
  - Actor: `storage.sql\`SELECT ...\``
  - Ours: `this.#sql\`SELECT ...\`` (using lazy getter)
  
- [ ] Add TypeScript declaration merging
  ```typescript
  declare global {
    interface LumenizeServices {
      alarms: Alarms;
    }
  }
  ```

#### Testing & Validation
- [ ] Test standalone usage: `new Alarms(this)` creates own Sql
- [ ] Test injected usage: Uses shared `this.svc.sql`
- [ ] Verify no duplicate Sql instances in injected mode
- [ ] Test all alarm types: Date, delay (seconds), cron
- [ ] Test cancellation
- [ ] Test multiple alarms
- [ ] Works with `@lumenize/testing` alarm simulation
- [ ] Create doc-test showing standalone usage

**Success Criteria**: 
- Alarms works in plain `DurableObject` without Actor base class
- All alarm types work (Date, delay, cron)
- Dependency discovery works (finds or creates Sql)
- Tests pass with `@lumenize/testing` alarm simulation
- Test coverage >80% branch
- Code is cleaner/simpler than Actor's version

#### Design Questions for Phase 2

**Q1: How do we handle the `alarm()` boilerplate?**
- Option A: User must implement `alarm()` that delegates (like Actor)
- Option B: LumenizeBase auto-implements `alarm()` and routes to `handleAlarm()`
- Option C: Some clever Proxy/Symbol magic?

**Q2: SQL vs KV for alarm storage?**
- Actor uses SQLite (`_actor_alarms` table)
- Pros: Can query, atomic operations
- Cons: Schema migrations, complexity
- Could we use KV instead? Tradeoffs?

**Q3: Per-request/message instance (`scp`)?**
- Alarms are instance-level, not request-level
- Do we need `scp.alarms` at all, or just `this.svc.alarms`?

### Phase 3: @lumenize/lumenize-base (LumenizeBase with auto-injection)
**Goal**: Create convenience base class that auto-wires injectables

#### Package Setup
- [ ] Create `packages/lumenize-base/` package structure
  - [ ] `package.json` with MIT license
  - [ ] Dependencies on `@lumenize/core` and `@lumenize/alarms`
  - [ ] `src/index.ts` for exports
  - [ ] `src/lumenize-base.ts` - Base class with NADIS
  - [ ] `tsconfig.json` extending root

#### LumenizeBase Implementation

**Lazy instantiation via Proxy** (services created on first access):

```typescript
// @lumenize/lumenize-base/src/lumenize-base.ts
import { DurableObject } from 'cloudflare:workers';
import { sql } from '@lumenize/core';
import { Alarms } from '@lumenize/alarms';

// Empty base interface - packages augment it via declaration merging
declare global {
  interface LumenizeServices {}
}

export class LumenizeBase<Env = any> extends DurableObject<Env> {
  #svcCache = new Map<string, any>();
  
  get svc(): LumenizeServices {
    return new Proxy({} as LumenizeServices, {
      get: (_, key: string) => {
        // Return cached instance if available
        if (this.#svcCache.has(key)) {
          return this.#svcCache.get(key);
        }
        
        // Instantiate on first access
        let instance: any;
        
        if (key === 'sql') {
          instance = sql(this);
        } else if (key === 'alarms') {
          instance = new Alarms(this);
        }
        // ... add more services here as they're created
        
        if (!instance) {
          throw new Error(`NADIS service '${key}' not found. Did you import the package?`);
        }
        
        // Cache for future access
        this.#svcCache.set(key, instance);
        return instance;
      }
    });
  }
  
  // Auto-implement alarm() boilerplate
  async alarm() {
    await this.svc.alarms.alarm();
  }
}
```

**Key features:**
- Proxy-based lazy instantiation (services only created when accessed)
- Map cache prevents duplicate instantiation
- Each service added as simple if-else (no complex registry needed)
- Type safety from declaration merging (IntelliSense works!)
- Helpful error message if service not found

#### Testing & Documentation
- [ ] Test basic usage: extend LumenizeBase
- [ ] Test `this.svc.sql` access
- [ ] Test `this.svc.alarms` access
- [ ] Test automatic `alarm()` delegation
- [ ] Create doc-test comparing standalone vs injected
- [ ] Document when to use LumenizeBase vs plain DurableObject

**Success Criteria**:
- Both usage patterns work (standalone and injected)
- Clear documentation on when to use each
- Pattern established for future injectables
- Minimal boilerplate for injected mode

### Phase 4: Refine & Document
**Goal**: Polish the API based on learnings

- [ ] Review API decisions from Phases 1-3
- [ ] Identify pain points, simplify where possible
- [ ] Add comprehensive TypeScript types
- [ ] Write comprehensive tests for all packages
- [ ] API documentation (TypeDoc) for all packages
- [ ] Create doc-tests showing all patterns
- [ ] Document NADIS pattern for future injectables
- [ ] Migration guide from `@cloudflare/actors/alarms`

**Success Criteria**: 
- De✨light✨ful API that's easy to explain
- Clear patterns for future injectables
- Good test coverage (>80% branch)
- Working examples in documentation

### Phase 5: Polish & Ship
- [ ] Performance testing (is our SQL implementation efficient?)
- [ ] Final code review
- [ ] Publish all packages to npm
- [ ] Announce on website
- [ ] Update related packages to use NADIS pattern

## Open Questions

1. **Type safety**: How do we type `doInstance` parameter? `any` is ugly but flexible.
2. **Testing**: How do we test injectables in isolation?
3. **Plugin lifecycle**: Do injectables need init/cleanup methods?
4. **Per-request state**: Do we need `scp` (scope) for per-request context?
5. **Naming**: Is `svc` the right name, or `plugins`, `injectables`, `services`?
6. **Compatibility**: Should our API be identical to Actor's for easy migration?
7. **Edge Cases**: How do Actor's alarms handle DO eviction/reloading?
8. **Observability**: Should we add logging/metrics beyond what Actor provides?

## Success Metrics

- [ ] Sql works standalone and injected
- [ ] Alarms works standalone and injected
- [ ] Alarms correctly finds/uses Sql in both modes
- [ ] Works with plain `DurableObject` (no base class required)
- [ ] Works as injectable via `LumenizeBase`
- [ ] All alarm types supported (Date, delay, cron)
- [ ] API is simple (minimal boilerplate)
- [ ] Pattern is clear (easy to add new injectables)
- [ ] Works with `@lumenize/testing` (RPC access to svc)
- [ ] Test coverage >80% branch for all packages
- [ ] Documentation quality (working examples in doc-tests)
- [ ] Performance: No slower than `@cloudflare/actors/alarms`
- [ ] Clear NADIS pattern documented for future injectables

## Related Tasks

- **Depends on**: None (this is foundational!)
- **Blocks**: All future injectable packages (cache, sessions, etc.)
- **Related**: 
  - `tasks/backlog.md` - Future injectables, "Integrate runDurableObjectAlarm into @lumenize/testing"

---

## Notes, Learnings, & Historical Record

### 2025-11-04: Initial NADIS Design

**Key decisions**:
- Inject `this` (DO instance) not just `ctx` → gives access to ctx, env, svc
- Auto-discover dependencies from `doInstance.svc` with fallback
- Use string-based naming convention (not Symbols) for service keys
- **TypeScript declaration merging**: Each package augments global `LumenizeServices` interface
  - No manual type registration needed
  - Types automatically merge when you import a package
  - Full IntelliSense support
- **Factory functions for stateless injectables** (sql), **classes for stateful ones** (alarms)
  - `this.svc.sql\`SELECT ...\`` - beautiful template literal syntax
  - `this.svc.alarms.schedule(...)` - clear method calls
- **Lazy instantiation via Proxy**: Services only created on first access
  - Map cache prevents duplicate instantiation
  - Simple if-else in LumenizeBase (no complex registry)
- `@lumenize/core` for universal injectables (sql)
- `@lumenize/alarms` proves dependency pattern
- `@lumenize/lumenize-base` for auto-injection base class (MIT licensed)

**To be determined**:
- Exact TypeScript types for `doInstance` parameter (currently `any`)
- How to handle injectable lifecycle (init/cleanup)
- Future plugin registry system (Phase 1 uses manual if-else)

### 2025-11-02: Actor Alarms Initial Investigation
- Discovered Storage wrapper appears essential for native alarm integration
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

### 2025-11-04: Storage Wrapper Mystery Solved
- **Storage wrapper is NOT needed for alarms** (corrects 2025-11-02 assumption)
- Examined Actor source: Alarms receives `ctx` directly, not Storage wrapper
- Storage wrapper (`@cloudflare/actors/storage`) is just SQL convenience:
  - Template tag syntax: `storage.sql\`SELECT * FROM table\``
  - SQL schema migrations support
  - No alarm-related functionality at all
- Alarms uses standard DO APIs: `ctx.storage.setAlarm()`, `ctx.storage.sql`
- **Path forward is clear**: Copy Alarms class, works with plain `ctx.storage`
- Remaining dependencies are minimal:
  - `ctx.blockConcurrencyWhile()` during init (standard DO API)
  - `this.parent[callback]` for invoking handlers (works in any DO)
  - `actorName` identifier (can remove or simplify)

### Future: (Add learnings as we go)

---

## Next Steps (Immediate)

1. **Start Phase 1**: Create `@lumenize/core` with Sql injectable
   - Package structure
   - Sql class with template literal support
   - Basic tests
2. Iterate on API until it feels right
3. Once Sql works, move to Phase 2 (Alarms extraction)
4. Document NADIS pattern as we go
5. Clean up `doc-test/actors/alarms/basic-usage/` to ONLY show Actor approach (ship to website)

