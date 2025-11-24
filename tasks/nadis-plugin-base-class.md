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

## Phase 2: Convert sql and debug to use NadisPlugin.register() ✅ COMPLETED

**Goal**: Migrate sql and debug from `@lumenize/core` to use `NadisPlugin.register()`.

**Initial Concern**: Potential circular dependency:
- `@lumenize/lumenize-base` has `@lumenize/core` as devDependency (for tests)
- Converting `@lumenize/core` to use `NadisPlugin` would make it depend on `@lumenize/lumenize-base`

**Resolution**: No circular dependency exists:
- `@lumenize/core` **depends on** `@lumenize/lumenize-base` (production dependency)
- `@lumenize/lumenize-base` **devDepends on** `@lumenize/core` (test-only)
- This is a valid one-way dependency (core → lumenize-base)

**Key Insight**: Tests must dogfood the NADIS pattern. The initial error was caused by test files directly importing `sql()` and `debug()` instead of using `this.svc.sql` and `this.svc.debug` via NADIS auto-registration.

**Implementation**:
1. Modified `packages/core/sql/index.ts` to use `NadisPlugin.register()`
2. Modified `packages/core/debug/index.ts` to use `NadisPlugin.register()`
3. Created `packages/core/test-worker-and-dos.ts` with DOs extending `LumenizeBase`
4. Updated all tests to access services via NADIS (`this.svc.*`)

**Converted** (sql and debug now use):
```typescript
import { NadisPlugin } from '@lumenize/lumenize-base';

// ... implementation ...

declare global {
  interface LumenizeServices {
    sql: ReturnType<typeof sql>;
  }
}

NadisPlugin.register('sql', (doInstance) => sql(doInstance));
```

**Success Criteria**:
- ✅ sql and debug use `NadisPlugin.register()` for registration
- ✅ All tests pass (47 tests across 6 test files)
- ✅ Tests dogfood NADIS pattern (use `this.svc.*` not direct imports)
- ✅ No runtime circular dependency
- ✅ Declaration merging provides full type safety
- ✅ Removed tests of internal implementation details (pattern-matcher, error handling)

## Phase 3: Refactor Alarms to Use NadisPlugin ✅ COMPLETED

**Goal**: Convert `@lumenize/alarms` to extend `NadisPlugin` base class as dogfooding test.

**Key Changes**:
- ✅ Extend `NadisPlugin` instead of standalone class
- ✅ Use `this.svc.sql` for eager dependency validation
- ✅ Simplify registration using `NadisPlugin.register()`

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
- ✅ All tests pass (52 tests passing)
- ✅ Eager dependency validation works (error if sql not imported)
- ✅ **Dogfooding in tests**: `test/test-worker-and-dos.ts` uses NADIS import pattern:
  - Imports `'@lumenize/core'` and `'@lumenize/alarms'` as side-effect imports
  - Test DOs extend `LumenizeBase`
  - Use `this.svc.sql` and `this.svc.alarms` (not manual instantiation)

**Completed**: All tests passing. Alarms now extends `NadisPlugin`, uses `this.ctx` (inherited), accesses `this.svc.sql` for eager validation, and registers via `NadisPlugin.register()`.

## Phase 4: Acid Test - Rename and Convert proxy-fetch to Fetch Plugin

**Goal**: Rename `@lumenize/proxy-fetch` to `@lumenize/fetch` and convert to full NADIS plugin as final validation of the design.

**Why Before Documentation**: If conversion reveals design issues, we can adjust the pattern before documenting it.

**Why This Is The Acid Test**:
- proxy-fetch currently uses monkey-patching (`__handleProxyFetchResult` on prototype)
- More complex than other plugins (state, alarm coordination, worker communication)
- If conversion is painful, our abstraction failed
- If conversion is smooth, we've succeeded

**Current Pattern**:
- Package: `@lumenize/proxy-fetch`
- Not registered in `__lumenizeServiceRegistry`
- Monkey-patches LumenizeBase prototype
- Called via `proxyFetch(this, url, continuation, options, reqId)`

**Target Pattern**:
- Package: `@lumenize/fetch`
- Full NADIS plugin: `this.svc.fetch.proxy(url, continuation, options, reqId)`
- Add stub: `this.svc.fetch.direct(url, continuation, options)` (for future implementation)
- No monkey-patching - `__handleProxyFetchResult` becomes internal method
- Clean class-based implementation extending `NadisPlugin`

**Steps**:
1. Rename package directory from `proxy-fetch` to `fetch`
2. Update `package.json` name from `@lumenize/proxy-fetch` to `@lumenize/fetch`
3. Create `Fetch` class extending `NadisPlugin`
4. Move `__handleProxyFetchResult` from prototype monkey-patch to internal class method
5. Refactor `proxyFetch()` function to `proxy()` method on `Fetch` class
6. Add stub `direct()` method for future direct fetch implementation
7. Register using `NadisPlugin.register('fetch', ...)` (not 'proxyFetch')
8. Update all imports across codebase from `@lumenize/proxy-fetch` to `@lumenize/fetch`
9. Update all test files to use NADIS pattern (side-effect imports, `this.svc.fetch.proxy()`)
10. Update wrangler.jsonc, vitest configs, and other package references
11. Verify all tests pass

**Success Criteria**:
- ✅ Package renamed to `@lumenize/fetch`
- ✅ No more monkey-patching of LumenizeBase
- ✅ Clean `this.svc.fetch.proxy()` API
- ✅ Stub `this.svc.fetch.direct()` ready for future implementation
- ✅ All existing tests pass
- ✅ Test files dogfood NADIS pattern (side-effect imports, extend LumenizeBase)
- ✅ All package references updated across monorepo

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

