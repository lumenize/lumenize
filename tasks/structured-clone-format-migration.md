# Structured Clone Format Migration

**Status**: Active  
**Started**: 2025-11-01  
**Context**: Migrating from indexed format to `$lmz` reference style (Cap'n Web format + cycles/aliases)

## Goal

Migrate `@lumenize/structured-clone` from current indexed format to `$lmz` reference style format, bringing Cap'n Web's human-readable format with cycle/alias support.

## Decision Summary

Based on experiments in `structured-clone-format-experiments-results.md`:
- **Performance**: `$lmz` format is 2-3x faster for serialization
- **Readability**: `$lmz` format is dramatically more human-readable
- **Size**: Indexed format is 16-35% smaller
- **Verdict**: Prefer performance and readability over marginal size optimization

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

```javascript
// Cap'n Web tuple format with $lmz references
{
  "root": ["$lmz", 0],
  "objects": [
    ["object", {
      "name": ["string", "John"],
      "age": ["number", 30],
      "tags": ["$lmz", 1]
    }],
    ["array", [
      ["string", "developer"],
      ["string", "javascript"]
    ]]
  ]
}

// Error with recursive cause
["error", {
  "name": "Error",
  "message": "Failed",
  "cause": ["$lmz", "0"]  // Reference to another error
}]

// Map with aliased value
["map", [
  [["string", "key1"], ["string", "val1"]],
  [["string", "key2"], ["$lmz", "0"]]  // Reference
]]
```

**Confirmed Characteristics** (from experiments):
- ✅ **75x faster serialization** than current indexed format
- ✅ **1.8x faster parsing** than current indexed format
- ✅ Human-readable type names (vs numeric codes)
- ✅ Consistent with Cap'n Web tuple format
- ✅ **Beats indexed format on Web API types** (11% smaller)
- ✅ More compact than Object-based `$lmz` (tuples vs object wrappers)
- ⚠️ 11-103% larger payloads than indexed (avg 20-50%, acceptable trade-off for performance + readability)

**Why Tuple `$lmz` Over Alternatives**:
1. **Performance is king**: 75x faster serialization is dramatic
2. **Best balance**: Compact tuples + readable + fast
3. **Beats Object `$lmz`**: Smaller and faster
4. **Cap'n Web alignment**: Consistent format with Cap'n Web (aids future interop)
5. **Special win**: Only format that beat indexed on Web API types

## Migration Phases

### Phase 0: Complete Format Experiments ✅
- [x] Test suite optimized (95.81% coverage)
- [x] All duplicate code removed
- [x] Experiments: Indexed vs Object-based `$lmz` 
- [x] Implement tuple-based `$lmz` format in experiments
- [x] Run comprehensive comparison (3 formats across 9 test cases)
- [x] Analyze results and make final format decision
- [x] **Decision**: Proceed with **Tuple-based `$lmz` format**

### Phase 1: Implement `$lmz` Serializer
- [ ] Create `serialize-ref-style.ts` with:
  - [ ] `serializeRefStyle(value: any): any` - Main serializer
  - [ ] Uses `WeakMap<any, string>` for seen tracking
  - [ ] Generates JSONPath-like references (`$lmz: "path.to.value"`)
  - [ ] Handles cycles and aliases
  - [ ] Preserves all type support (Error, Web API, special numbers, etc.)
- [ ] Add comprehensive tests (reuse existing test suite)
- [ ] Verify all 447 tests pass with new serializer

### Phase 2: Implement `$lmz` Deserializer
- [ ] Create `deserialize-ref-style.ts` with:
  - [ ] `deserializeRefStyle(data: any): any` - Main deserializer
  - [ ] Two-pass deserialization (first pass: build objects, second pass: resolve refs)
  - [ ] Handles `$lmz` references
  - [ ] Preserves all type support
- [ ] Add comprehensive tests
- [ ] Verify all 447 tests pass with new deserializer

### Phase 3: Integrate and Test
- [ ] Update `serialize.ts` to use `serializeRefStyle`
- [ ] Update `deserialize.ts` to use `deserializeRefStyle`
- [ ] Run full test suite (447 tests)
- [ ] Verify coverage maintains 95%+
- [ ] Performance benchmarks (compare with experiments)

### Phase 4: Remove Old Code
- [ ] Delete indexed format serializer code
- [ ] Delete indexed format deserializer code
- [ ] Remove `Map<any, number>` seen tracking
- [ ] Clean up any format-specific utilities
- [ ] Update documentation

### Phase 5: Fix Dependent Packages
- [ ] `@lumenize/rpc`: Update Error serialization (use `stringify()`/`parse()` instead of removed marker functions)
- [ ] `@lumenize/proxy-fetch`: Verify Web API serialization still works
- [ ] Any other packages using `structured-clone`
- [ ] Run integration tests

### Phase 6: Documentation and Release
- [ ] Update README with new format details
- [ ] Update API documentation
- [ ] Add migration guide (if needed for external users)
- [ ] Version bump (breaking change: 0.x.0 → 0.y.0 or 1.0.0?)
- [ ] Publish to npm

## Implementation Notes

### Type Support to Preserve

All current types must work with `$lmz` format:
- ✅ Primitives (string, number, boolean, null, undefined)
- ✅ Objects and Arrays
- ✅ Date, RegExp, Map, Set
- ✅ Error (with full fidelity: name, message, stack, cause, custom props)
- ✅ BigInt
- ✅ TypedArrays (Uint8Array, etc.)
- ✅ Special numbers (NaN, Infinity, -Infinity)
- ✅ Web API objects (Request, Response, Headers, URL)
- ✅ Cycles and aliases

### Reference Path Generation

For `$lmz` references, use simple path notation:
```javascript
// Root-level property
{ $lmz: "propertyName" }

// Nested property
{ $lmz: "obj.nested.property" }

// Array index
{ $lmz: "array.0" }

// Map key (convert to string)
{ $lmz: "map.key_stringified" }
```

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
**Mitigation**: Experiments show 2-3x performance improvement, but verify with real-world tests

### Risk: Bugs in cycle/alias handling
**Mitigation**: Comprehensive test suite with 16 alias tests covering all edge cases

### Risk: Size increase impacts production
**Mitigation**: 16-35% increase is acceptable given performance gains; monitor in production

## Success Criteria

- [ ] All 447 tests pass
- [ ] Coverage ≥ 95%
- [ ] Performance ≥ experiments (2-3x faster serialization)
- [ ] All type support preserved
- [ ] RPC and proxy-fetch tests pass
- [ ] Documentation updated
- [ ] Published to npm

## Timeline

Estimated effort: 2-3 days
1. Phase 1-2 (Implement): 1 day
2. Phase 3 (Integrate): 0.5 day
3. Phase 4 (Clean up): 0.5 day
4. Phase 5 (Fix deps): 0.5 day
5. Phase 6 (Docs/release): 0.5 day

## References

- Analysis: `structured-clone-format-analysis.md`
- Experiments: `structured-clone-format-experiments.md`
- Results: `structured-clone-format-experiments-results.md`
- Test optimization: `archive/structured-clone-test-optimization.md`
- Experiment code: `packages/structured-clone/test/format-experiments.test.ts`

