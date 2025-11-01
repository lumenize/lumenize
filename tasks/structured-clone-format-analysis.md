# Structured Clone Format Analysis

**Date**: 2025-01-27  
**Context**: After implementing Cap'n Web type support, analyzing differences and potential back-porting opportunities

## What We Learned

### 1. Format Verbosity Comparison

**Cap'n Web Format**: `["type", data]`
- Direct, inline values
- Human-readable JSON
- Example: `["map", [[["foo","bar"]]]]`

**@lumenize/structured-clone Format**: `[[TYPE_NUMBER, value], ...]`
- Indexed array system (everything gets an index)
- References use index numbers for cycle/alias support
- Example: `[[13, [[0, 1]]], [0, "foo"], [0, "bar"]]` (where 13 = MAP type)

**Key Difference**: Structured-clone format is necessary for cycle/alias support - it can't inline values because the same value might appear multiple times.

### 2. Human Readability

Cap'n Web's format is more readable because:
- Values are inline (you can see `"foo"` directly, not `[0, "foo"]` then look up index 0)
- No index lookup required to understand structure
- Type names are strings (`"map"`) not numbers (`13`)

However, structured-clone's indexed format enables:
- Cycle detection (same object referenced multiple times)
- Alias support (multiple paths to same object)
- Memory efficiency for large shared subtrees

### 3. Potential Improvements

#### Option A: $ref-like Format (with alternative marker)
Use reference markers similar to JSON Schema, but with a safe marker that won't conflict:

```json
{
  "root": {"__ref": 0},
  "objects": [
    {"type": "map", "entries": [["foo", {"__ref": 1}], ["bar", "value"]]},
    {"type": "string", "value": "shared"}
  ]
}
```

**Why not `$ref`**: JSON Schema uses `$ref` as a keyword. If user data contains `"$ref"` as a property, schema validators will try to resolve it as a reference, causing conflicts.

**Alternative markers to consider**:
- `__ref` - Double underscore convention for "internal use", unlikely in user data (6 characters)
- `@ref` - Used by JSON-LD, but might be confused with JSON-LD processing (4 characters)
- `$lmz` - Namespaced with `$` prefix (like JSON Schema `$ref`), very unlikely to conflict, shorter than `__ref` (5 characters)
- `$lmz_ref` - More verbose namespaced option, zero conflict risk (8 characters)

**Recommendation**: `$lmz` offers the best balance - one character shorter than `__ref` (5 vs 6), similarly collision-resistant due to namespace (`lmz` = Lumenize), and uses the `$` prefix convention (like JSON Schema `$ref`) which signals "special/internal" meaning.

**Pros**:
- More human-readable than indexed arrays
- Can still support cycles/aliases
- Uses safe marker that won't conflict with user data

**Cons**:
- Requires restructuring entire format
- More complex parsing logic
- Not compatible with existing data

#### Option B: Hybrid Format
Keep indexed array but make type codes strings instead of numbers:
```json
[["map", [["foo", 1], ["bar", 2]]], ["string", "foo"], ["string", "bar"]]
```

**Pros**:
- Minor change (just string type codes)
- More readable than numeric codes
- Backward compatible parsing (can support both)

**Cons**:
- Still requires index lookup
- Doesn't solve verbosity problem

#### Option C: Port Cap'n Web Format + Add Cycle Support
Start with Cap'n Web's `["type", data]` format, add cycle/alias detection using reference markers.

**Format idea** (using safe marker):
```json
["map", [
  ["foo", {"__ref": 1}],  // Reference to index 1 (using __ref to avoid $ref conflicts)
  ["bar", ["string", "value"]]
]]
// Later in serialization:
[{"__value": ["string", "shared-value"]}]  // Index 1, referenced above
```

Or inline markers:
```json
["map", [
  ["key1", ["string", "value1"]],
  ["key2", {"__ref": "#shared"}],  // Reference to shared value
  ["key3", {"__ref": "#shared"}]
],
"#shared": ["string", "shared-value"]
]

**Effort Assessment**:

**Low Risk (Easy)**:
- Port type detection logic (already done for Cap'n Web)
- Port serialization for non-cyclic cases (straightforward)
- Port error serialization improvements (already proven)

**Medium Risk**:
- Adding cycle/alias detection to Cap'n Web format
- Implementing reference markers without breaking inline readability
- Handling edge cases (self-referential objects, deep cycles)

**High Risk**:
- Maintaining backward compatibility with existing indexed format (NOT IMPORTANT)
- Test coverage for cycles/aliases (currently very limited - only 1 basic test)
- Request/Response async handling (already works in structured-clone)

### 4. Test Coverage Analysis

**Current cycle/alias tests** (7 tests found):
- ✅ Self-referencing objects
- ✅ Self-referencing arrays
- ✅ Complex bidirectional cycles (obj1.ref = obj2, obj2.ref = obj1)
- ✅ Cycles in Maps (map references itself as value)
- ✅ Cycles in Sets (set contains itself)
- ✅ Cycles in Error cause chains
- ✅ Cycles with Web API objects
- ✅ Cycles with special numbers

**Missing coverage**:
- ❌ Multiple paths to same object (true aliases - same object referenced via different paths)
- ❌ Deep cycles (A→B→C→A)
- ❌ Cycles in Map keys (keys can be objects too)
- ❌ Performance tests with large cyclic structures
- ❌ Shared subtree aliases (two different paths leading to same subtree)

**Assessment**: Good basic coverage, but alias detection (same object, different paths) is not explicitly tested. This is the riskiest area for format migration.

## Recommendations

### Short Term (Low Risk)
1. **Port Error serialization improvements**: Already proven in Cap'n Web, low risk
2. **Add string type codes**: Easy readability win, backward compatible
3. **Expand cycle/alias test coverage**: Critical before any format changes

### Medium Term (Medium Risk)
1. **Experiment with JSON $ref format**: Create proof-of-concept, compare verbosity
2. **Benchmark format differences**: Measure serialization size, parse performance
3. **Hybrid approach**: Use Cap'n Web format for non-cyclic values, indexed for cyclic

### Long Term (High Risk)
1. **Full format migration**: Only if experiments show significant benefits
2. **Maintain dual format support**: Allow both formats during transition period

## Questions to Answer

1. **Verbosity measurement**: How much larger is indexed format vs inline? Need benchmarks.
2. **Parse performance**: Does indexed format perform better/worse? (Likely better for large shared subtrees)
3. **Compatibility requirements**: Do we need to maintain compatibility with existing serialized data?
4. **Use case analysis**: What percentage of our use cases have cycles/aliases? (If low, could optimize for non-cyclic case)

## Next Steps

1. Create test suite for cycle/alias coverage
2. Build verbosity comparison tool (serialize same data in both formats, compare sizes)
3. Create proof-of-concept for $ref format
4. Benchmark parse/serialize performance

