# NADIS Plugin Base Class

**Status**: Planning
**Type**: Implementation-First (Internal Infrastructure)

## Objective

Create a `NadisPlugin` base class that makes it easy for users (and our own packages) to create NADIS-compatible plugins in a consistent manner with minimal boilerplate, eager dependency validation, and full type safety.

## Goals

1. **Minimize boilerplate** - Reduce registration code to ~3 lines
2. **Eager validation** - Fail immediately if dependencies missing (not at first access)
3. **Consistent pattern** - All NADIS plugins follow same structure
4. **Type safety** - Incrementally built full autocomplete (no `as any`). Each plugin adds to global `LumenizeServices` interface via declaration merging.
5. **Dogfooding** - Our own plugins use the same pattern we recommend to users
6. **Support both functions and classes** - Simple stateless services (sql) can stay functions, complex stateful services (alarms) use classes

## Success Criteria

- ✅ `NadisPlugin` base class provides common infrastructure (ctx, svc, doInstance access)
- ✅ Static `register()` helper reduces boilerplate
- ✅ Clear documentation pattern for users
- ✅ All internal plugins (sql, debug, alarms) refactored to use new pattern
- ✅ proxy-fetch conversion validates the design (acid test)

## Phase 1: Create NadisPlugin Base Class

**Goal**: Implement `NadisPlugin` abstract class in `@lumenize/lumenize-base` with helper method for registration.

**Location**: `packages/lumenize-base/src/nadis-plugin.ts`

**Core Implementation**:
```typescript
export abstract class NadisPlugin {
  protected doInstance: any;
  protected ctx: DurableObjectState;
  protected svc: LumenizeServices;
  
  constructor(doInstance: any) {
    this.doInstance = doInstance;
    this.ctx = doInstance.ctx;
    this.svc = doInstance.svc;
  }
  
  // Helper to reduce registration boilerplate
  static register<T>(name: string, factory: (doInstance: any) => T): void {
    if (!(globalThis as any).__lumenizeServiceRegistry) {
      (globalThis as any).__lumenizeServiceRegistry = {};
    }
    (globalThis as any).__lumenizeServiceRegistry[name] = factory;
  }
}
```

**Success Criteria**:
- ✅ `NadisPlugin` class created and exported from `@lumenize/lumenize-base`
- ✅ Provides `doInstance`, `ctx`, `svc` to subclasses
- ✅ Static `register()` method handles runtime registration
- ✅ No breaking changes to existing NADIS system
- ✅ Tests verify base functionality

## Phase 2: Convert SQL and Debug to Use NadisPlugin.register()

**Goal**: Convert `@lumenize/core` (sql and debug) to use `NadisPlugin.register()` helper for consistent registration pattern.

**Why First**: Alarms depends on sql, so sql must use the new registration pattern before we convert alarms.

**Note**: These remain functions (not classes) since they're stateless. We're just cleaning up the registration boilerplate.

**Current** (sql):
```typescript
// In packages/core/sql/index.ts
if (!(globalThis as any).__lumenizeServiceRegistry) {
  (globalThis as any).__lumenizeServiceRegistry = {};
}
(globalThis as any).__lumenizeServiceRegistry.sql = (doInstance: any) => sql(doInstance);
```

**After** (sql):
```typescript
import { NadisPlugin } from '@lumenize/lumenize-base';

// Registration (2 lines)
declare global { interface LumenizeServices { sql: ReturnType<typeof sql>; } }
NadisPlugin.register('sql', (doInstance) => sql(doInstance));
```

**Success Criteria**:
- ✅ sql uses `NadisPlugin.register()`
- ✅ debug uses `NadisPlugin.register()`
- ✅ Declaration merging unchanged (still works)
- ✅ All tests pass unchanged
- ✅ Reduced boilerplate (from 4 lines to 2 for registration)

## Phase 3: Refactor Alarms to Use NadisPlugin

**Goal**: Convert `@lumenize/alarms` to extend `NadisPlugin` base class as dogfooding test.

**Key Changes**:
- Extend `NadisPlugin` instead of standalone class
- Use `this.svc.sql` for eager dependency validation
- Simplify registration using `NadisPlugin.register()`

**Before** (current pattern):
```typescript
export class Alarms {
  #ctx: DurableObjectState;
  #parent: any;
  #sql: ReturnType<typeof sqlType>;
  
  constructor(ctx: DurableObjectState, doInstance: any, deps?: { sql?: ... }) {
    this.#ctx = ctx;
    this.#parent = doInstance;
    // Manual injection with fallback
    if (deps?.sql) {
      this.#sql = deps.sql;
    } else if (doInstance.svc?.sql) {
      this.#sql = doInstance.svc.sql;
    } else {
      throw new Error('...');
    }
  }
}

// Registration boilerplate
if (!(globalThis as any).__lumenizeServiceRegistry) {
  (globalThis as any).__lumenizeServiceRegistry = {};
}
(globalThis as any).__lumenizeServiceRegistry.alarms = (doInstance: any) => {
  const deps: any = {};
  if (doInstance.svc && doInstance.svc.sql) {
    deps.sql = doInstance.svc.sql;
  }
  return new Alarms(doInstance.ctx, doInstance, deps);
};
```

**After** (using NadisPlugin):
```typescript
import { NadisPlugin } from '@lumenize/lumenize-base';

export class Alarms extends NadisPlugin {
  #sql: ReturnType<typeof sqlType>;
  
  constructor(doInstance: any) {
    super(doInstance);
    // Eager dependency check - fails immediately if missing
    this.#sql = this.svc.sql;
  }
  
  // ... rest of implementation unchanged
}

// Simplified registration (3 lines, unavoidable)
declare global { interface LumenizeServices { alarms: Alarms; } }
NadisPlugin.register('alarms', (doInstance) => new Alarms(doInstance));
```

**Success Criteria**:
- ✅ Alarms extends `NadisPlugin`
- ✅ Simplified constructor (no manual ctx/deps handling)
- ✅ Registration uses `NadisPlugin.register()`
- ✅ All tests pass unchanged
- ✅ Eager dependency validation works (error if sql not imported)
- ✅ **Dogfooding in tests**: `test/test-worker-and-dos.ts` uses NADIS import pattern:
  - Imports `'@lumenize/core'` and `'@lumenize/alarms'`
  - Test DOs extend `LumenizeBase`
  - Use `this.svc.sql` and `this.svc.alarms` (not manual instantiation)

## Phase 4: Acid Test - Convert proxy-fetch

**Goal**: Convert `@lumenize/proxy-fetch` to full NADIS plugin as final validation of the design.

**Why Before Documentation**: If conversion reveals design issues, we can adjust the pattern before documenting it.

**Why This Is The Acid Test**:
- proxy-fetch currently uses monkey-patching (`__handleProxyFetchResult` on prototype)
- More complex than other plugins (state, alarm coordination, worker communication)
- If conversion is painful, our abstraction failed
- If conversion is smooth, we've succeeded

**Current Pattern**:
- Not registered in `__lumenizeServiceRegistry`
- Monkey-patches LumenizeBase prototype
- Called via `proxyFetch(this, ...)`

**Target Pattern**:
- Full NADIS plugin: `this.svc.proxyFetch.fetch(...)`
- No monkey-patching (everything on service instance)
- Uses `NadisPlugin` base class

**Success Criteria**:
- ✅ `ProxyFetch` class extends `NadisPlugin`
- ✅ Registered with `NadisPlugin.register()`
- ✅ No prototype monkey-patching
- ✅ Namespaced: `this.svc.proxyFetch.fetch(...)`
- ✅ All tests pass with new pattern
- ✅ Conversion was smooth (validates design quality)

**If Conversion Is Hard**: Revisit NadisPlugin design before documenting.

## Phase 5: Document the Pattern

**Goal**: Create comprehensive documentation for users to write their own NADIS plugins (after pattern validated by proxy-fetch conversion).

**Location**: Add new section to `website/docs/lumenize-base/write-your-own-nadis-plugin.mdx`

**Content to Cover**:
1. **Why create NADIS plugins** - DRY, auto-injection, tree-shaking
2. **Two patterns** - Functions (stateless) vs Classes (stateful)
3. **Step-by-step guide** with both patterns
4. **Declaration merging explanation** - Why it's required, how it works
5. **Dependency validation** - Eager checks in constructor
6. **Testing** - How to test NADIS plugins

**Key Example** (from docs):
```typescript
// Creating a stateful NADIS plugin
import { NadisPlugin, type LumenizeServices } from '@lumenize/lumenize-base';

export class MyService extends NadisPlugin {
  #cache = new Map();
  
  constructor(doInstance: any) {
    super(doInstance);
    // Eager dependency validation
    this.svc.sql; // Throws if @lumenize/core not imported
  }
  
  getData(key: string) {
    if (!this.#cache.has(key)) {
      const rows = this.svc.sql`SELECT * FROM data WHERE key = ${key}`;
      this.#cache.set(key, rows[0]);
    }
    return this.#cache.get(key);
  }
}

// Type declaration (enables autocomplete)
declare global {
  interface LumenizeServices {
    myService: MyService;
  }
}

// Runtime registration
NadisPlugin.register('myService', (doInstance) => new MyService(doInstance));
```

**Success Criteria**:
- ✅ New "Creating NADIS Plugins" section in lumenize-base docs
- ✅ Examples for both function and class patterns
- ✅ Explains declaration merging clearly (why unavoidable, how it works)
- ✅ Shows dependency validation pattern
- ✅ Includes testing examples
- ✅ Code examples validated with `@check-example`
- ✅ Reflects lessons learned from proxy-fetch conversion

## Notes

### Why Not Decorators?

- Decorators can't help with type-level declaration merging (compile-time vs runtime)
- User still must write `declare global { interface LumenizeServices { ... } }`
- Decorators would only save 1 line of runtime registration
- Not worth the complexity and mental overhead

### Function vs Class Trade-offs

**Functions** (e.g., sql):
- ✅ Simpler for stateless services
- ✅ Natural template literal syntax
- ❌ No namespacing (`this.svc.sql` not `this.svc.sql.query`)

**Classes** (e.g., alarms):
- ✅ Natural state management
- ✅ Natural namespacing (`this.svc.alarms.schedule()`)
- ✅ Can use NADIS dependencies internally
- ❌ Slightly more boilerplate

**Decision**: Support both, document when to use each.

### Declaration Merging Is Unavoidable

This is a TypeScript limitation. Declaration merging happens at compile time. No runtime mechanism (decorators, reflection, etc.) can affect the type system. The 2-3 lines are unavoidable but:
- Makes dependency explicit (good for tree-shaking)
- Clear what's being added to the interface
- Standard TypeScript pattern

### Import Order

With eager validation in constructors, import order matters:
```typescript
// WRONG - will fail
import '@lumenize/alarms';  // Tries to access this.svc.sql in constructor
import '@lumenize/core';    // Too late!

// RIGHT
import '@lumenize/core';    // sql available
import '@lumenize/alarms';  // can access this.svc.sql
```

This is a feature (fail fast) but needs clear documentation.

## Open Questions

1. Should we provide a helper for function-based plugins too, or just document the pattern?
2. Do we want to validate dependency declarations somehow (e.g., plugin declares `dependencies: ['sql']`)?
3. Should we add explicit version compatibility checking in plugins?

## References

- Current NADIS docs: `website/docs/lumenize-base/index.mdx`
- Alarms implementation: `packages/alarms/src/alarms.ts`
- LumenizeBase: `packages/lumenize-base/src/lumenize-base.ts`

