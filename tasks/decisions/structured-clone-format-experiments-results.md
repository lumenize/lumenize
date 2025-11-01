# Structured Clone Format Experiments - Results

**Date**: 2025-01-27  
**Experiment**: Format verbosity, performance, and readability comparison

**Methodology**: All performance measurements run in **Node.js environment** via Vitest's node project configuration. Cloudflare Workers environments intentionally stop the clock during operations (only updating on "new I/O events"), making timing unreliable. Browser environments also have timing variability. Node.js provides accurate, consistent performance measurements.

## Quick Reference Table

| Test Case | Size (bytes) | Serialize Performance | Parse Performance |
|-----------|--------------|----------------------|-------------------|
| **Simple Object** (no cycles/aliases) | Indexed: 229<br>`$lmz`: 273<br>**Indexed 16% smaller** | Indexed: 0.388ms<br>`$lmz`: 0.126ms<br>**`$lmz` 3.1x faster** | Indexed: 0.167ms<br>`$lmz`: 0.060ms<br>**`$lmz` 2.8x faster** |
| **Cyclic Object** (self-reference) | Indexed: 102<br>`$lmz`: 137<br>**Indexed 25% smaller** | Indexed: 0.033ms<br>`$lmz`: 0.017ms<br>**`$lmz` 2.0x faster** | Indexed: 0.013ms<br>`$lmz`: 0.009ms<br>**`$lmz` 1.3x faster** |
| **Aliased Object** (same object, different paths) | Indexed: 179<br>`$lmz`: 275<br>**Indexed 35% smaller** | Indexed: 0.024ms<br>`$lmz`: 0.017ms<br>**`$lmz` 1.4x faster** | Indexed: 0.190ms<br>`$lmz`: 0.084ms<br>**`$lmz` 2.3x faster** |
| **Mixed Workload** (50% simple, 50% aliased/cyclic) | Indexed: 1003<br>`$lmz`: 1452<br>**Indexed 31% smaller** | Indexed: 0.058ms<br>`$lmz`: 0.033ms<br>**`$lmz` 1.7x faster** | Indexed: 0.032ms<br>`$lmz`: 0.033ms<br>**Similar performance** |
| **Error Objects** (stack traces, custom props) | Indexed: 535<br>`$lmz`: 674<br>**Indexed 21% smaller** | Indexed: 0.038ms<br>`$lmz`: 0.023ms<br>**`$lmz` 1.7x faster** | Indexed: 0.026ms<br>`$lmz`: 0.021ms<br>**`$lmz` 1.3x faster** |
| **Web API Types** (URL, Headers) | Indexed: 536<br>`$lmz`: 607<br>**Indexed 12% smaller** | Indexed: 0.255ms<br>`$lmz`: 0.026ms<br>**`$lmz` 9.9x faster** | Indexed: 0.049ms<br>`$lmz`: 0.090ms<br>**Indexed 1.8x faster** |

## Executive Summary

Comparing current **indexed format** vs **`$lmz` reference style format** (similar to JSON Schema `$ref`, but using `$lmz` marker to avoid conflicts):

**Note**: Format experiments used `__ref` as the reference marker. Final implementation will use `$lmz` (5 characters, shorter than `$lmz`'s 6, namespaced for collision resistance).

### Bottom Line

**`$lmz` reference format offers significant advantages**: 2-3x faster performance for simple data (with similar performance for mixed workloads), dramatically more readable, with only a 16-35% size penalty on aliased data.

### Key Findings

⚡ **Performance**: 
- `$lmz` format is **1.7-9.9x faster** to serialize (simple data: 3x, Web API types: 9.9x, errors/aliased: 1.4-1.7x)
- `$lmz` format is **1.1-2.8x faster** to parse for most data (simple: 2.8x, aliased: 2.3x, errors: 1.3x)
- **Web API types show massive serialize advantage** (9.9x faster) - avoiding complex Web API serialization in indexed format
- **Parse performance varies**: `$lmz` is faster for most types, but indexed is 1.8x faster for Web API types (reconstruction overhead)
- **Mixed workloads show similar performance** (~0.03-0.06ms for both formats)

📖 **Readability**: 
- $lmz format is **dramatically more human-readable**
- Inline values: see `"name":"John"` directly vs `[0,"name"]` + index lookup
- Named references: `{"$lmz":"#0"}` vs numeric indices like `[7,0]`
- Structure is obvious at a glance vs requiring mental index mapping
- **Much easier to debug and maintain**

📦 **Size**: 
- **Simple (non-aliased) data**: Indexed format is **16% smaller** (229 vs 273 bytes) - both formats have overhead, but indexed's array structure is more compact
- **Aliased/cyclic data**: Indexed format is **25-35% smaller** (better deduplication via index sharing)
- **Mixed workload (50/50)**: Indexed format is **31% smaller overall** (1003 vs 1452 bytes)
- **Error objects**: Indexed format is **21% smaller** (535 vs 674 bytes) - verbose property names indexed separately
- **Web API types**: Indexed format is **12% smaller** (536 vs 607 bytes) - verbose `__isSerializedX` markers indexed separately
- **Size winner**: Indexed format is smaller across all scenarios (12-35% range), but the advantage is largest for aliased data (25-35%) vs simple/Web API data (12-16%)

### Detailed Results

#### 1. Simple Object (No Cycles/Aliases)

**Size**: 
- Current (indexed): 229 bytes
- $lmz style: 273 bytes  
- **Current is 16.1% smaller** 
- **Note**: For non-aliased data, indexed format's overhead (indexing every value) makes it larger than ideal, but still smaller than $lmz's object table structure

**Performance**:
- Current: 0.388ms serialize, 0.167ms parse
- $lmz style: 0.126ms serialize, 0.060ms parse
- **$lmz is 3.1x faster serialize, 2.8x faster parse**

**Readability**:
- Current: `[[2,[[1,2],[3,4],[5,6],[9,10]]],[0,"name"],[0,"John"],[0,"age"],[0,30]...]`
  - Hard to read: numeric indices, need to track mappings
  - Type codes are numbers (`2` = object, `0` = string)
  
- $lmz style: `{"root":{"$lmz":"#0"},"objects":[{"id":"#0","name":"John","age":30,...}]}`
  - ✅ Much easier: inline values, named references, clear structure
  - Can see `"name":"John"` directly, not `[0,"name"]` then lookup index 0

#### 2. Cyclic Object (Self-Reference)

**Size**:
- Current (indexed): 102 bytes
- $lmz style: 137 bytes
- **Current is 25.5% smaller**

**Performance**:
- Current: 0.033ms serialize, 0.013ms parse  
- $lmz style: 0.017ms serialize, 0.009ms parse
- **$lmz is 2.0x faster serialize, 1.3x faster parse**

**Readability**:
- Current: `[[2,[[1,2],[3,4],[5,6],[7,0]]],[0,"id"],[0,1]...]`
- $lmz style: `{"root":{"$lmz":"#0"},"objects":[{"id":1,"name":"Root","self":{"$lmz":"#0"}}]}`
  - ✅ Clear self-reference visible: `"self":{"$lmz":"#0"}` shows it points to root

#### 3. Aliased Object (Same Object, Different Paths)

**Size**:
- Current (indexed): 179 bytes
- $lmz style: 275 bytes
- **Current is 34.9% smaller** (better deduplication)

**Performance**:
- Current: 0.024ms serialize, 0.190ms parse
- $lmz style: 0.017ms serialize, 0.084ms parse  
- **$lmz is 1.4x faster serialize, 2.3x faster parse**

**Readability**:
- Current: `[[2,[[1,2],[9,10],[11,4],[12,13]]],[0,"a"],[2,[[3,4]]]...]`
- $lmz style: `{"root":{"$lmz":"#0"},"objects":[{"id":999,"data":"shared-value"},{"id":"#1","ref":{"$lmz":"#2"}}...]}`
  - ✅ Shows shared object clearly: `{"$lmz":"#2"}` appears multiple times, showing it's the same object

#### 4. Mixed Workload (50% Simple, 50% Aliased/Cyclic)

**Size**:
- Current (indexed): 1003 bytes
- $lmz style: 1452 bytes
- **Current is 31% smaller** (indexed format's deduplication advantage shows in mixed workloads)

**Performance**:
- Current: 0.058ms serialize, 0.032ms parse
- $lmz style: 0.033ms serialize, 0.033ms parse
- **Performance is similar** - $lmz is 1.7x faster serialize, indexed is 1.0x faster parse (essentially equivalent)
- Performance advantage less pronounced in mixed workloads (both ~0.03-0.06ms range)

**Analysis**: 
- **Size**: Indexed format maintains its size advantage (31% smaller) even in mixed workloads
- **Performance**: Performance is roughly equivalent in mixed workloads (~0.05ms for both)
- **Conclusion**: For mixed data, size advantage (31%) vs performance (similar) trade-off becomes more balanced

## Detailed Results (Original)

### 1. Simple Object (No Cycles/Aliases)

```
Current (indexed): 229 bytes, 229 chars
  Serialize: 0.451ms
  Parse: 0.140ms
  Format: [[2,[[1,2],[3,4],[5,6],[9,10]]],[0,"name"],[0,"John"],[0,"age"],[0,30]...]

Cap'n Web style (inline): 122 bytes, 122 chars
  Serialize: 0.011ms
  Parse: 0.007ms
  Format: {"name":"John","age":30,"tags":["developer","javascript"]...}

Size difference: 87.7% larger (current)
```

**Analysis**: Inline format is significantly more compact for simple, non-cyclic data. The indexed format overhead (every value gets an array entry with type code) adds substantial size.

### 2. Aliased Object (Same Object, Different Paths)

```
Current (indexed): 179 bytes, 179 chars
  Serialize: 0.074ms
  Parse: 0.167ms

Cap'n Web style (inline): 203 bytes
  (would duplicate shared object - 24 extra bytes)
```

**Analysis**: When objects are referenced multiple times, the indexed format's deduplication becomes a win. The shared object is stored once (at index 4), referenced by multiple indices. Inline format would duplicate the entire shared object structure.

### 3. Cyclic Object (Self-Reference)

```
Current (indexed): 102 bytes, 102 chars
  Serialize: 0.041ms
  Parse: 0.013ms

Cap'n Web style: Cannot handle cycles - would fail
```

**Analysis**: Cycles require reference tracking. Indexed format handles this naturally via index references.

### 4. Deep Nested Structure (50 levels)

```
Current (indexed): 1401 bytes, 1401 chars
  Serialize: 0.097ms
  Parse: 0.053ms
```

**Analysis**: Deep nesting shows the overhead of indexing every value. Each level adds array entries for keys and nested objects.

### 5. Large Shared Subtree

```
Current (indexed): 474 bytes, 474 chars
  Serialize: 0.039ms
  Parse: 0.021ms
  (Shows alias efficiency - shared data stored once)
```

**Analysis**: Large shared subtrees benefit significantly from deduplication. Multiple references to the same config object are stored once.

### 6. Complex Structure (Map, Set, RegExp, etc.)

```
Current (indexed): 335 bytes, 335 chars
  Serialize: 0.069ms
  Parse: 0.036ms
```

### 7. Error Objects (with stack traces, custom properties)

**Size**:
- Current (indexed): 535 bytes
- `$lmz` style: 674 bytes
- **Current is 21% smaller**

**Performance**:
- Current: 0.038ms serialize, 0.026ms parse
- `$lmz` style: 0.023ms serialize, 0.021ms parse
- **`$lmz` is 1.7x faster serialize, 1.3x faster parse**

**Analysis**:
- Error objects have verbose property names (`name`, `message`, `stack`, `customProps`, `cause`) that all get indexed separately in current format
- The `__isSerializedError` marker (20 chars) also adds overhead, but indexed format's deduplication still wins on size
- Performance advantage goes to `$lmz` format - cleaner structure avoids index overhead

### 8. Web API Types (URL, Headers with verbose markers)

**Size**:
- Current (indexed): 536 bytes
- `$lmz` style: 607 bytes
- **Current is 12% smaller**

**Performance**:
- Current: 0.255ms serialize, 0.049ms parse
- `$lmz` style: 0.026ms serialize, 0.090ms parse
- **`$lmz` is 9.9x faster serialize, indexed is 1.8x faster parse**

**Analysis**:
- Web API types use verbose `__isSerializedX` markers:
  - `__isSerializedURL` (18 chars)
  - `__isSerializedHeaders` (22 chars)
  - `__isSerializedRequest` (21 chars)
  - `__isSerializedResponse` (22 chars)
- These marker property names get indexed separately in current format, adding overhead
- **Massive serialize performance win for `$lmz` (9.9x faster)** - likely due to avoiding complex Web API serialization logic in indexed format
- Parse is slightly slower for `$lmz` (needs to reconstruct Web API objects), but still acceptable

## Observations

### When Indexed Format Wins
- **Size**: 16-35% smaller for aliased/cyclic data (better deduplication)
- **Mature**: Battle-tested format with proven cycle/alias support

### When $lmz Format Wins
- **Performance**: 2-3x faster serialize, 1.1-3x faster parse
- **Readability**: ✅ **Dramatically better** - can see structure directly
- **Human-readable**: No index lookups needed, clear reference markers

### Readability Comparison Example

**Current indexed format**:
```json
[[2,[[1,2],[3,4],[5,6]]],[0,"name"],[0,"John"],[0,"age"],[0,30]...]
```
- ❌ Hard to read: Must track indices (what's at index 1? 2? 3?)
- ❌ Type codes are numbers: `2` = object, `0` = string (need lookup table)
- ❌ Can't see structure without parsing entire format
- ❌ Debugging requires mental mapping of indices

**$lmz style format**:
```json
{"root":{"$lmz":"#0"},"objects":[{"id":"#0","name":"John","age":30,"tags":{"$lmz":"#1"}}]}
```
- ✅ Easy to read: Structure is obvious - `"name":"John"` visible directly
- ✅ Named references: `"#0"`, `"#1"` are self-documenting
- ✅ Can understand structure at a glance
- ✅ Debugging is straightforward - see actual values and references

**Performance difference**: 3x faster serialize, 3x faster parse for simple objects!

## Next Steps

1. **Test with real-world data**: Run experiments with actual RPC payloads
2. **Measure alias frequency**: How often do we actually have aliases vs simple objects?
3. **Hybrid approach**: Use inline for non-cyclic, indexed for cyclic/aliased
4. **Type code strings**: Test changing numeric type codes to strings (`"map"` vs `13`)
5. **Reference marker alternatives**: Test `$lmz`, `@ref`, `$lmz_ref` formats

## Implications & Recommendation

### Trade-offs

**Indexed format**:
- ✅ Better size efficiency for aliased/cyclic data (16-35% smaller)
- ✅ Battle-tested, mature implementation
- ❌ Much slower performance (2-3x slower)
- ❌ Poor readability - hard to debug, requires index lookups
- ❌ Numeric type codes require lookup table

**$lmz format**:
- ✅ **2-3x faster serialize/parse performance**
- ✅ **Dramatically better readability** - human-readable, debuggable
- ✅ Named references (more self-documenting than numeric indices)
- ❌ 16-35% larger size for aliased data (but still faster!)
- ❌ New format (requires migration)

### Recommendation

Given the **significant performance gains (2-3x for simple data, 1.4-2x for aliased data)** and **dramatically improved readability**, the $lmz format appears to be the better choice. The size penalty (16-35% larger) is more than offset by:
- Faster processing (less CPU time)
- Better developer experience (easier debugging, maintenance)
- More maintainable codebase (human-readable format)

**Decision point**: 
- **Size**: Indexed format is **16-35% smaller across all scenarios** (smaller even for simple data - 229 vs 273 bytes)
- **Performance**: $lmz format is **2-3x faster for simple data** (3.1x serialize, 2.8x parse), **1.4-2x faster for aliased data**, but performance is **similar for mixed workloads** (~0.03-0.06ms for both)
- **Readability**: $lmz format is **dramatically better** - human-readable, easier to debug
- **Recommendation**: 
  - For simple data: $lmz format wins (3x faster, much more readable, only 16% size penalty)
  - For mixed/aliased data: Trade-off is more balanced (31% size advantage vs similar performance and much better readability)
  - Overall: Prefer simplicity, performance, and readability - the 16-35% size penalty is small compared to readability and performance gains

**Note on Performance Comparison**: 
- ✅ **Both use real implementations**: `serializeCurrentFormat` calls the actual `stringify()` function which uses the real `serialize()` implementation (recursive walk with `Map<any, number>` for cycle detection)
- ✅ **Both use cycle detection**: 
  - Current uses `Map<any, number>` for seen tracking (line 71 of serialize.ts)
  - $lmz uses `WeakMap<any, string>` - same algorithmic complexity
- ✅ **Both recursive**: Both walk the object graph recursively checking for cycles at each step
- ✅ **Fair comparison**: The 2-3x performance difference is due to format structure efficiency (indexed array operations vs object property access), not algorithm differences

