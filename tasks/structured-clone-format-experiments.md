# Structured Clone Format Experiments

**Date**: 2025-01-27  
**Goal**: Compare format verbosity, readability, and package size between current indexed format and potential alternatives

## Experiments to Run

### Experiment 1: Verbosity Comparison

**Setup**: Create test cases with various structures:
- Simple objects (no cycles/aliases)
- Objects with cycles
- Objects with aliases (same object, different paths)
- Deep nested structures
- Large shared subtrees

**Measure**:
- Serialized JSON size (bytes, minified)
- Serialized JSON size (bytes, pretty-printed)
- Number of characters
- Parse time
- Serialize time

**Formats to compare**:
1. Current indexed format: `[[TYPE_NUMBER, value], ...]`
2. Cap'n Web format (no cycles): `["type", data]`
3. Proposed $ref-like format: TBD (see Experiment 2)

### Experiment 2: Reference Marker Alternatives

**Problem**: `$ref` conflicts with JSON Schema's `$ref` keyword. If user data contains `"$ref"` as a property, our reference marker breaks.

**Alternatives to test**:
1. `__ref` (double underscore - common convention for "internal")
2. `@ref` (at-sign - used by JSON-LD, less common in user data)
3. `$lmz_ref` (namespaced - very unlikely to conflict)
4. Numeric index in array: `["map", [["key", [1]], ...]]` where 1 is index
5. Separate references array: `{root: {...}, refs: [{...}]}`

**Criteria**:
- Unlikely to conflict with user data
- Human-readable
- Easy to parse
- Compact

### Experiment 3: Type Code String vs Number

**Test**: Change `[[13, value]]` to `[["map", value]]`

**Measure**:
- Size impact (number vs string)
- Readability improvement
- Parse performance impact

### Experiment 4: Package Size Impact

**Measure**:
- Bundle size with current format
- Bundle size with proposed format
- Code size (LOC) for serialization/deserialization

## Implementation Plan

### Phase 1: Test Infrastructure
1. Create test suite with diverse data structures
2. Implement serialization in multiple formats side-by-side
3. Add benchmarking utilities

### Phase 2: Experiments
1. Run verbosity comparison
2. Test reference marker alternatives
3. Measure type code impact
4. Calculate package size differences

### Phase 3: Analysis
1. Compare results
2. Identify trade-offs
3. Recommend path forward

## Reference Marker Conflict Analysis

**JSON Schema $ref**: Used for schema references. If user data contains `$ref` property, schema validators will interpret it as a reference, causing conflicts.

**Recommendation**: Avoid `$ref`. Prefer:
- `__ref` - Unlikely in user data, clear "internal use" signal
- `@ref` - Standard in JSON-LD, but might be confused with JSON-LD processing
- `$lmz_ref` - Namespaced, zero conflict risk, but verbose

**Preferred**: `__ref` seems best balance of readability and safety.

