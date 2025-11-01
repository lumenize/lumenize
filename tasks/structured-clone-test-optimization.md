# Structured Clone Test Optimization

**Status**: Active  
**Started**: 2025-01-27  
**Context**: Preparing for format migration from indexed to `$lmz` reference format (Cap'n Web format backport)

## Goal

Optimize test suite to be format-agnostic before format migration. Ensure comprehensive alias test coverage and remove format-specific assertions that would break during migration.

## Current State

### Coverage
- **Statements**: 78.18%
- **Branches**: 68.88%
- **Functions**: 80%
- **Lines**: 78.01%

### Test Files
- `test/core.test.ts` - Core round-trip tests (good foundation)
- `test/errors.test.ts` - Error serialization tests
- `test/web-api-objects.test.ts` - Web API type tests
- `test/special-numbers.test.ts` - Special number tests
- `test/for-docs/*.test.ts` - Documentation examples (round-trip)
- `test/format-experiments.test.ts` - **Format-specific experiments** (not core tests)

### Test Philosophy
Most tests are **round-trip tests** (serialize → parse → verify equality) - this is the correct approach. Round-trip tests verify correctness regardless of format.

## Issues to Address

### 1. Format-Specific Tests

**Problem**: Some tests inspect the serialized format structure, which will break when we migrate formats.

**Examples to review/remove**:
- `test/format-experiments.test.ts` - Entire file is format-specific (experiments only, not core tests)
- `test/special-numbers.test.ts` line 172: `expect(jsonString).not.toContain('null')` - This checks format structure
  - **Decision needed**: Is this testing behavior (NaN shouldn't become null) or format structure?
  - If behavior: Keep but verify the property, not the format
  - If format: Remove or make format-agnostic

**Action**: Audit all tests for format-specific assertions:
- Assertions on `JSON.parse(await stringify(x))` structure
- Assertions checking for specific array/index patterns
- Assertions checking marker property names in specific format

### 2. Missing Alias Tests

**Problem**: We have good cycle tests (A→B→A) but missing alias tests (obj.a and obj.b both point to same object C, where C doesn't reference back).

**Current cycle tests** (from `core.test.ts`):
- ✅ Self-referencing objects
- ✅ Self-referencing arrays
- ✅ Complex circular structures (A→B→A)
- ✅ Circular references in Maps
- ✅ Circular references in Sets

**Missing alias tests**:
- ❌ Multiple paths to same object (true aliases)
  ```typescript
  const shared = { id: 1, data: 'shared' };
  const obj = {
    a: { ref: shared },
    b: { ref: shared },
    c: shared, // Direct reference
    list: [shared, shared] // Multiple times in array
  };
  // After round-trip: obj.a.ref === obj.b.ref === obj.c === obj.list[0] === obj.list[1]
  ```
- ❌ Deep cycles (A→B→C→A)
- ❌ Cycles in Map keys (keys can be objects)
  ```typescript
  const key = { id: 1 };
  const map = new Map();
  map.set(key, 'value');
  map.set(key, 'updated'); // Same key object
  // After round-trip: should have one entry with updated value
  ```
- ❌ Shared subtree aliases (two different paths leading to same subtree)
  ```typescript
  const shared = {
    config: { theme: 'dark' },
    data: { value: 42 }
  };
  const obj = {
    user1: { settings: shared.config },
    user2: { settings: shared.config },
    system: { defaultConfig: shared.config }
  };
  // After round-trip: all should reference same config object
  ```
- ❌ Aliases in nested structures (alias appears at different nesting levels)
- ❌ Performance tests with large aliased structures

### 3. Coverage Gaps

**Files with low coverage**:
- `web-api-serialization.ts`: **0% coverage** (marker-based utilities, not used by main API)
- `error-serialization.ts`: **0% coverage** (marker-based utilities, not used by main API)

**Decision needed**: 
- These are low-level marker-based utilities for explicit control (queue storage, DO persistence)
- Main API uses native serialization which handles Web API/Error types automatically
- **Question**: Do we need tests for these marker-based utilities, or are round-trip tests sufficient?

**Files with partial coverage**:
- `serialize.ts`: 99.15% statements, 94.2% branches (line 109 uncovered)
- `web-api-objects.ts`: 91.22% statements, 93.18% branches
- `special-numbers.ts`: 87.5% statements, 89.47% branches

**Action**: Review uncovered lines to determine if:
1. Tests are missing
2. Code paths are unreachable/defensive
3. Edge cases need explicit testing

## Phases

### Phase 0: Deduplicate Error and Web API Serialization Code

**Problem**: We have duplicated code for Error and Web API serialization:
- **Error**: Inline in `serialize.ts` (better - handles `cause` recursively) vs `error-serialization.ts` (stale)
- **Web API**: `web-api-objects.ts` (used by main API) vs `web-api-serialization.ts` (different markers, unused)

**Approach**: Extract inlined implementations (the better ones) to the same-named files and import them.

- [ ] **Error serialization**:
  - Extract Error serialization logic from `serialize.ts` (lines 208-257) to `error-serialization.ts`
  - Create helper functions that accept `pair()`, `as()`, `currentChain` parameters
  - Replace inline code with function call
  - Update `deserialize.ts` to import from `error-serialization.ts` instead of inline (lines 74-112)
  - Verify the exported `serializeError()`/`deserializeError()` marker-based API still works (or remove if truly unused)

- [ ] **Web API serialization**:
  - Verify `web-api-serialization.ts` is actually unused (check for imports)
  - If unused: Remove it, document that `web-api-objects.ts` is the canonical implementation
  - If used: Document why both exist and when to use each

- [ ] Verify tests still pass after refactoring
- [ ] Verify coverage improves (files should now be exercised)

**Notes**:
- Inlined Error serialization handles `cause` recursively and custom props via `customProps` object (better)
- `web-api-objects.ts` uses `__lmz_*` markers, `web-api-serialization.ts` uses `__isSerialized*` markers (different formats)
- Extraction will make codebase more modular while maintaining functionality
- Auto-bundling (Vite/Wrangler) means no build complexity from splitting files

### Phase 1: Audit and Remove Format-Specific Tests

- [ ] Search for format-specific assertions:
   - `expect(serialized).toMatch(/pattern/)`
   - `expect(serialized).toContain('specific-marker')`
   - `expect(JSON.parse(serialized)[0][0]).toBe(TYPE_NUMBER)`
   - Any assertion that relies on indexed array structure
- [ ] For each format-specific test:
  - **Option A**: Remove if redundant (covered by round-trip test)
  - **Option B**: Convert to round-trip test if testing behavior
  - **Option C**: Keep if testing preprocess/postprocess hooks (format-agnostic)
- [ ] Verify coverage doesn't drop below current levels after removal

**Notes**:
- Remove `test/format-experiments.test.ts` from core test suite (keep as experiments only)
- Coverage may drop slightly, revealing gaps in round-trip tests

### Phase 2: Add Missing Alias Tests

- [ ] Create `test/aliases.test.ts` with comprehensive alias test cases:
   - Multiple paths to same object
   - Deep cycles (A→B→C→A)
   - Cycles in Map keys
   - Shared subtree aliases
   - Aliases in nested structures
   - Large aliased structures (performance/scalability)
- [ ] Add alias tests to existing files where appropriate:
   - Map/Set alias tests in `core.test.ts`
   - Error alias tests (errors with shared cause) in `errors.test.ts`
   - Web API alias tests (shared URLs/Headers) in `web-api-objects.test.ts`
- [ ] Verify all alias tests pass (they should with current indexed format)

**Notes**:
- Baseline established before format migration
- Confidence that format migration preserves alias handling

### Phase 3: Address Coverage Gaps

- [ ] Review uncovered lines in `serialize.ts`, `web-api-objects.ts`, `special-numbers.ts`
- [ ] Add targeted tests for missing coverage
- [ ] Decide on `web-api-serialization.ts` and `error-serialization.ts`:
   - If these are internal utilities: Document as such, test via integration
   - If they're exported APIs: Add explicit tests
- [ ] Aim for >90% statement coverage, >80% branch coverage

**Expected outcome**:
- Improved coverage metrics
- All critical paths tested
- Uncovered code explicitly documented as defensive/unreachable

**Notes**:
- Current coverage: 78% statements, 69% branches
- Target: >90% statements, >80% branches

### Phase 4: Verify Test Suite Quality

- [ ] Run full test suite after Phase 1-3
- [ ] Verify coverage is maintained or improved
- [ ] Document any intentionally uncovered code
- [ ] Create test suite summary document

**Expected outcome**:
- Clean, format-agnostic test suite
- Comprehensive alias test coverage
- Ready for format migration

## Success Criteria

- ✅ No format-specific assertions in core test files
- ✅ Comprehensive alias test coverage (all scenarios from backlog)
- ✅ Coverage maintains or improves (target: >90% statements, >80% branches)
- ✅ All tests are round-trip tests (verify correctness, not format structure)
- ✅ Test suite provides confidence for format migration

## Next Steps After Test Optimization

Once test optimization is complete:
1. Format migration can proceed with confidence
2. Tests will validate correctness regardless of format
3. Any test failures during migration indicate implementation bugs, not test issues

## Questions to Answer

1. **Format-specific assertions**: Are there any format-specific tests we should keep for debugging/documentation purposes?
2. **Marker-based utilities**: Should `web-api-serialization.ts` and `error-serialization.ts` have explicit tests, or are integration tests via main API sufficient?
3. **Coverage targets**: What are acceptable coverage targets before format migration? (Suggested: >90% statements, >80% branches)
4. **Test organization**: Should alias tests go in separate file or integrated into existing test files?

