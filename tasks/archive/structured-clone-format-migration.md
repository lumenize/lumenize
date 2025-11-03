# Structured Clone Format Migration

**Status**: ✅ Complete  
**Started**: 2025-11-01  
**Completed**: 2025-11-02  
**Context**: Migrated from indexed format to Tuple-based `$lmz` format (Cap'n Web tuples + cycle/alias support)

## Goal

Migrate `@lumenize/structured-clone` from current indexed format to **Tuple-based `$lmz` format**, combining Cap'n Web's human-readable tuple format with full cycle and alias support.

## Decision Summary

**Decision**: Adopt **Tuple-based `$lmz` format** after comprehensive experiments comparing 3 formats across 9 test cases.

### Key Findings (from `structured-clone-format-experiments-results.md`):
- **Performance**: Tuple `$lmz` is **75x faster serialization**, 1.8x faster parsing
- **Readability**: Dramatically more human-readable (type names vs numeric codes)
- **Size**: Current indexed is 11-103% smaller (avg 20-50% penalty)
- **Special win**: Tuple `$lmz` actually **beats indexed on Web API types** (11% smaller!)
- **Verdict**: Performance (75x!) and readability gains outweigh size penalty

### Why Tuple `$lmz` Over Alternatives:
1. **Dramatically faster**: 75x serialization speedup is game-changing
2. **Human-readable**: Easy debugging and inspection
3. **Best of both worlds**: Combines Cap'n Web's compact tuples with cycle support
4. **Consistent with Cap'n Web**: Enables future interoperability
5. **Beats Object `$lmz`**: Smaller and faster than object-based alternative

## Current State

### Test Suite: ✅ Ready
- All 447 tests pass (optimized in `structured-clone-test-optimization.md`)
- 95.81% coverage (up from 83.73%)
- Comprehensive alias tests added (16 new tests)
- All tests are format-agnostic round-trip tests
- No duplicate code - clean, single implementations

### Code State: ✅ Clean
- Single Error serialization implementation
- Single Web API serialization implementation  
- No format conversion adapters
- Ready for migration

## Current Format (Indexed)

```javascript
// Array of [type, value] records with numeric indices for references
[
  [1, "value"],           // Index 0
  [2, [0]],               // Index 1: array containing reference to index 0
  [0, { x: 1, y: 1 }]     // Index 2: object referencing index 1 twice
]
```

**Characteristics**:
- Compact (16-35% smaller)
- Requires separate seen map (`Map<any, number>`) for cycle detection
- Not human-readable
- Index-based referencing

## Target Format: **Tuple-based `$lmz`** ✅

### Format Structure

**Top-level wrapper**:
```javascript
{
  "root": <serialized value or reference>,
  "objects": [<array of serialized complex objects>]
}
```

**Primitive values** - Use Cap'n Web tuples `["type", data]`:
```javascript
["string", "hello"]
["number", 42]
["boolean", true]
["bigint", "123456789"]
["null"]
["undefined"]

// Special numbers
["number", "NaN"]
["number", "Infinity"]
["number", "-Infinity"]
```

**Complex objects** - Stored in `objects` array, referenced by index:
```javascript
// Plain object
["object", {
  "name": ["string", "John"],
  "age": ["number", 30]
}]

// Array
["array", [
  ["string", "item1"],
  ["number", 2]
]]

// Error with full fidelity
["error", {
  "name": "Error",
  "message": "Failed",
  "stack": "Error: Failed\n  at ...",
  "cause": ["$lmz", 1]  // Reference to another object
}]

// Map
["map", [
  [["string", "key1"], ["string", "val1"]],
  [["string", "key2"], ["number", 42]]
]]

// Set
["set", [
  ["string", "item1"],
  ["number", 42]
]]

// Date, RegExp, URL, Headers
["date", "2024-01-01T00:00:00.000Z"]
["regexp", {"source": "^\\d+$", "flags": "gi"}]
["url", {"href": "https://example.com"}]
["headers", [["content-type", "application/json"]]]

// TypedArray
["arraybuffer", [1, 2, 3, 4]]  // Array of bytes
```

**References** - For cycles and aliases:
```javascript
["$lmz", 0]  // Reference to objects[0]
["$lmz", 5]  // Reference to objects[5]
```

### Complete Example

```javascript
// Input: Object with cycle
const shared = { id: 999, data: "shared" };
const obj = {
  name: "Root",
  shared1: shared,
  shared2: shared,  // Alias - same object
  tags: ["tag1", "tag2"]
};
obj.self = obj;  // Cycle

// Output: Tuple $lmz format
{
  "root": ["$lmz", 0],
  "objects": [
    ["object", {
      "name": ["string", "Root"],
      "shared1": ["$lmz", 1],
      "shared2": ["$lmz", 1],  // Same reference - alias preserved!
      "tags": ["$lmz", 2],
      "self": ["$lmz", 0]  // Self-reference - cycle preserved!
    }],
    ["object", {
      "id": ["number", 999],
      "data": ["string", "shared"]
    }],
    ["array", [
      ["string", "tag1"],
      ["string", "tag2"]
    ]]
  ]
}
```

**Key Features**:
- ✅ **75x faster serialization** (7.4ms → 0.1ms in experiments)
- ✅ **1.8x faster parsing** (0.127ms → 0.069ms in experiments)
- ✅ Human-readable type names make debugging easy
- ✅ Consistent with Cap'n Web tuple format
- ✅ Full cycle and alias support via `["$lmz", index]` references
- ✅ **Smaller than indexed for Web API types** (only format to beat indexed!)
- ⚠️ 20-50% larger payloads on average (acceptable trade-off for massive performance + readability gains)

## Migration Phases

### Phase 0: Complete Format Experiments ✅
- [x] Test suite optimized (95.81% coverage)
- [x] All duplicate code removed
- [x] Experiments: Indexed vs Object-based `$lmz` 
- [x] Implement tuple-based `$lmz` format in experiments
- [x] Run comprehensive comparison (3 formats across 9 test cases)
- [x] Analyze results and make final format decision
- [x] **Decision**: Proceed with **Tuple-based `$lmz` format**

### Phase 1: Extract and Refine Tuple `$lmz` Implementation ✅
- [x] Extract `serializeTupleStyle()` from `test/format-experiments.test.ts` to new `src/preprocess.ts`
- [x] Extract `parseTupleStyle()` from experiments to new `src/postprocess.ts`
- [x] Extract `resolveValue()` helper from experiments
- [x] Refine error handling and edge cases
- [x] Add JSDoc documentation
- [x] Verify implementation handles all types from experiments

### Phase 2: Integrate Tuple `$lmz` as Main Format ✅
- [x] Update serialization:
  - [x] Replace indexed format serialization with tuple serializer
  - [x] Keep same public API (`stringify(value)`)
  - [x] Remove old indexed format code
- [x] Update deserialization:
  - [x] Replace indexed format deserialization with tuple deserializer
  - [x] Keep same public API (`parse(json)`)
  - [x] Remove old indexed format code
- [x] Update type definitions (LmzIntermediate interface)

### Phase 3: Test and Verify ✅
- [x] Run full test suite (480 tests) - all pass
- [x] Verify coverage maintains 95%+
- [x] Confirmed performance matches initial results
- [x] All test scenarios show expected characteristics
- [x] Test with real-world data structures

### Phase 4: Update Type Codes and Constants ✅
- [x] Remove numeric type code constants (e.g., `const OBJECT = 0`)
- [x] Update any remaining references to old format
- [x] Clean up unused utilities and helpers
- [x] Remove `Map<any, number>` for index tracking

### Phase 5: Update Exports and Public API ✅
- [x] Verify `stringify()` and `parse()` still work as expected
- [x] Removed `serializeWebApiObject()` and `deserializeWebApiObject()` (replaced with `encodeRequest/Response` and `decodeRequest/Response`)
- [x] Removed `isWebApiObject()` (unnecessary duplication of instanceof checks)
- [x] Remove any old format-specific exports
- [x] Update `src/index.ts` exports

### Phase 6: Fix Dependent Packages ✅
- [x] `@lumenize/rpc`: Verified Error serialization works with `stringify()`/`parse()`
- [x] `@lumenize/proxy-fetch`: Updated Web API serialization to use new encode/decode functions
- [x] Run integration tests for both packages - all pass
- [x] Fixed all issues found

### Phase 7: Documentation and Release ✅
- [x] Update documentation with new format details and benefits
- [x] Update API documentation (TypeDoc)
- [x] Add performance benefits to docs (efficient tuple format)
- [x] Add format examples and API tier documentation
- [x] Update CHANGELOG with changes
- [x] Version bump: **0.15.0 → 0.17.0**
- [x] Publish to npm with release notes
- [x] Deploy documentation website

## Implementation Notes

### Type Support (Verified in Experiments ✅)

All current types work with Tuple `$lmz` format (tested in experiments):
- ✅ Primitives (string, number, boolean, null, undefined)
- ✅ Objects and Arrays
- ✅ Date, RegExp, Map, Set
- ✅ Error (with full fidelity: name, message, stack, cause, custom props)
- ✅ BigInt
- ✅ TypedArrays (Uint8Array, etc.)
- ✅ Special numbers (NaN, Infinity, -Infinity)
- ✅ Web API objects (Request, Response, Headers, URL)
- ✅ **Cycles and aliases** (via `["$lmz", index]` references)

### Reference Format

Tuple `$lmz` uses **numeric indices** (simpler than path-based):
```javascript
["$lmz", 0]  // Reference to objects[0]
["$lmz", 5]  // Reference to objects[5]
```

**Why numeric instead of path-based?**
- Simpler implementation (already working in experiments)
- Faster lookup (array index vs path parsing)
- No ambiguity with special characters in keys
- Consistent with implementation that's already 75x faster

### Serialization Algorithm (Two-Pass)

**Pass 1: Identify objects and assign indices**
- Use `WeakMap<any, number>` to track seen objects
- Assign sequential indices (0, 1, 2, ...)
- Build `objects` array with serialized objects
- Primitives serialized inline, objects get `["$lmz", index]` references

**Pass 2: Resolve references**
- Replace `["$lmz", index]` with actual object references
- Build final data structure

### Backward Compatibility

**Not maintaining backward compatibility** - rationale:
- Pre-1.0 (currently 0.15.0)
- Published only ~1 week ago
- Internal Lumenize use only (no external users yet)
- Clean migration preferred over compatibility burden

## Breaking Changes

### For `@lumenize/structured-clone` Users:
1. Serialized format changed (old serialized data won't deserialize)
2. Removed exports: `serializeError`, `deserializeError`, `isSerializedError` (already done in Phase 0)
3. Different error messages for serialization failures

### For `@lumenize/rpc`:
1. Must use `stringify()`/`parse()` for Error serialization
2. No functional changes (just API change)

### For `@lumenize/proxy-fetch`:
1. Should continue working (uses exported `serializeWebApiObject`)
2. Verify integration tests pass

## Testing Strategy

1. **Unit tests**: All existing round-trip tests must pass
2. **Alias tests**: 16 comprehensive alias tests must pass
3. **Integration tests**: RPC and proxy-fetch tests must pass
4. **Performance tests**: Verify performance matches experiments
5. **Coverage**: Maintain 95%+ coverage

## Risks and Mitigation

### Risk: Breaking dependent packages
**Mitigation**: Fix RPC and proxy-fetch immediately, version bump clearly indicates breaking change

### Risk: Performance regression
**Mitigation**: Experiments show **75x serialization improvement**, 1.8x parsing improvement - significant gains, but verify with real-world tests

### Risk: Bugs in cycle/alias handling
**Mitigation**: Comprehensive test suite with 16 alias tests covering all edge cases

### Risk: Size increase impacts production
**Mitigation**: 20-50% average increase (11-103% range) is acceptable given 75x performance gains and readability benefits; enable gzip compression to mitigate; monitor in production

## Success Criteria

- [ ] All 447 tests pass
- [ ] Coverage ≥ 95%
- [ ] Performance ≥ experiments (75x faster serialization, 1.8x faster parsing)
- [ ] All type support preserved
- [ ] RPC and proxy-fetch tests pass
- [ ] Documentation updated
- [ ] Published to npm

## Timeline

Estimated effort: **1-2 days** (faster because we have working implementation from experiments!)
1. Phase 1 (Extract from experiments): 0.25 day
2. Phase 2 (Integrate): 0.25 day
3. Phase 3 (Test): 0.25 day
4. Phase 4 (Clean up): 0.25 day
5. Phase 5 (Update exports): 0.25 day
6. Phase 6 (Fix deps): 0.25 day
7. Phase 7 (Docs/release): 0.25 day

## References

- **Decision**: `tasks/decisions/TUPLE_LMZFORMAT_RECOMMENDATION.md` - Executive summary
- **Analysis**: `tasks/decisions/structured-clone-format-analysis.md` - Initial analysis
- **Experiments Plan**: `tasks/decisions/structured-clone-format-experiments.md` - Experiment design
- **Results**: `tasks/decisions/structured-clone-format-experiments-results.md` - Detailed results (9 test cases, 3 formats)
- **Test optimization**: `tasks/archive/structured-clone-test-optimization.md` - Test suite prep
- **Working code**: `packages/structured-clone/test/format-experiments.test.ts` - Tuple `$lmz` implementation to extract

## Running Experiments

To re-run format experiments:
```bash
cd packages/structured-clone
npm test -- format-experiments --project=node
```

**Note**: Experiments are excluded from default test runs to avoid overhead.

