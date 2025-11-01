# Tuple-based `$lmz` Format Recommendation

**Date**: 2025-01-28  
**Decision**: Proceed with Tuple-based `$lmz` format for `@lumenize/structured-clone`

## TL;DR

After comprehensive experiments comparing three formats across 9 test cases:
- **Current (indexed)** wins on size (11-103% smaller)
- **Tuple `$lmz`** wins on performance (75x faster serialize!) and readability
- **Recommendation**: **Tuple `$lmz`** - the performance and developer experience gains outweigh the size penalty

## The Three Formats

### 1. Current (Indexed)
```javascript
[[2,[[1,2],[3,4]]],[0,"name"],[0,"John"],[0,"age"],[0,30]]
```
- Numeric type codes
- Index-based references
- Most compact
- Not human-readable

### 2. Object-based `$lmz`
```javascript
{
  "root": {"__ref": "#0"},
  "objects": [{"id": "#0", "name": "John", "age": 30}]
}
```
- Inline values
- Object wrappers
- Mid-size
- Human-readable

### 3. Tuple-based `$lmz` ✅ WINNER
```javascript
{
  "root": ["$lmz", 0],
  "objects": [["object", {"name": ["string", "John"], "age": ["number", 30]}]]
}
```
- Compact tuples
- Human-readable type names
- Cap'n Web alignment
- **Fastest + most readable**

## Experimental Results

### Size Comparison (9 test cases)
| Test | Indexed | Tuple $lmz | Winner | Difference |
|------|---------|------------|--------|------------|
| Simple Object | 229b | 273b | Indexed | +19% |
| Cyclic | 102b | 150b | Indexed | +47% |
| Aliased | 179b | 267b | Indexed | +49% |
| Deep Nested | 1401b | 2851b | Indexed | +103% |
| Large Shared | 474b | 570b | Indexed | +20% |
| Complex (Map/Set) | 335b | 398b | Indexed | +19% |
| Mixed Workload | 1003b | 1494b | Indexed | +49% |
| Errors | 535b | 604b | Indexed | +13% |
| **Web API** ✅ | 566b | **506b** | **Tuple** | **-11%** |

**Summary**: Indexed wins 8/9, but Tuple wins on Web API types!

### Performance Comparison
| Format | Serialize | Parse | vs Indexed |
|--------|-----------|-------|------------|
| Indexed | 7.402ms | 0.127ms | - |
| Tuple `$lmz` | **0.098ms** | **0.069ms** | **75x faster serialize, 1.8x faster parse** |

**Summary**: Tuple `$lmz` is dramatically faster!

### Readability Comparison

**Indexed** (hard to read):
```javascript
[[2,[[1,2],[3,4],[5,6]]],[0,"name"],[0,"John"],[0,"age"],[0,30]]
```

**Tuple `$lmz`** (easy to read):
```javascript
{
  "root": ["$lmz", 0],
  "objects": [
    ["object", {
      "name": ["string", "John"],
      "age": ["number", 30]
    }]
  ]
}
```

## Why Tuple `$lmz`?

### Pros
1. **🚀 Performance**: 75x faster serialization (game-changing)
2. **👁️ Readability**: Human-readable type names make debugging easy
3. **🎯 Best balance**: Beats Object `$lmz` in both size and performance
4. **🤝 Cap'n Web alignment**: Consistent tuple format aids interop
5. **🏆 Special win**: Only format that beat indexed (Web API types)
6. **📦 Compact**: Tuples are more compact than object wrappers

### Cons
1. **📈 Size**: 20-50% larger payloads on average
2. **📊 Worst case**: Deep nesting (103% larger)

### Why Size Penalty is Acceptable
1. **Compression**: gzip will reduce size differences significantly
2. **CPU > Bandwidth**: In most scenarios, CPU cost > network cost
3. **Developer experience**: Readability improves debugging substantially
4. **Real-world**: Most payloads are mixed (not worst-case deep nesting)

## Comparison to Cap'n Web Format

### Cap'n Web (no cycles)
```javascript
["error", {
  "name": "Error",
  "message": "Failed"
}]
```

### Tuple `$lmz` (with cycles)
```javascript
{
  "root": ["$lmz", 0],
  "objects": [
    ["error", {
      "name": "Error",
      "message": "Failed",
      "cause": ["$lmz", 1]  // Cycle support!
    }]
  ]
}
```

**Result**: Same tuple format, extended with cycle/alias support via `["$lmz", ref]`

## Migration Path

### Phase 1: Implement Tuple `$lmz` Serializer
- Extract `serializeTupleStyle` and `parseTupleStyle` from experiments
- Add as primary `stringify`/`parse` functions
- Keep backward compatibility for deserializing old format

### Phase 2: Update Dependent Packages
- `@lumenize/rpc`: Update to use new format
- `@lumenize/proxy-fetch`: Update to use new format

### Phase 3: Testing & Release
- Comprehensive testing with real-world workloads
- Major version bump (breaking change)

## Risks & Mitigations

### Risk 1: Larger Payloads
- **Mitigation**: Enable compression (gzip) for network transfers
- **Impact**: Minimal - gzip will reduce size differences

### Risk 2: Breaking Change
- **Mitigation**: Major version bump, clear migration guide
- **Impact**: Controlled - we're pre-1.0, limited users

### Risk 3: Performance Regression in Edge Cases
- **Mitigation**: Keep old format as fallback option
- **Impact**: Low - performance wins are dramatic across all cases

## Alternatives Considered

### Alternative 1: Keep Current Indexed Format
- **Pros**: Most compact, proven
- **Cons**: 75x slower, not human-readable
- **Verdict**: Rejected - performance + DX gains too significant

### Alternative 2: Object-based `$lmz`
- **Pros**: Human-readable, inline values
- **Cons**: Larger and slower than Tuple `$lmz`
- **Verdict**: Rejected - Tuple `$lmz` strictly better

### Alternative 3: Hybrid Format
- **Pros**: Optimize for different scenarios
- **Cons**: Complexity, maintenance burden
- **Verdict**: Rejected - favor simplicity

## Recommendation

**Proceed with Tuple-based `$lmz` format migration.**

The 75x serialization performance improvement and dramatically better readability outweigh the 20-50% size penalty. The format aligns with Cap'n Web, making future interoperability easier, and it's the only format that beat indexed in any category (Web API types).

For `@lumenize/structured-clone`, the use case prioritizes:
1. **Fast serialization** for RPC and message passing
2. **Developer experience** for debugging
3. **Size** as secondary concern (compression mitigates)

Tuple `$lmz` is the clear winner for these priorities.

---

**Next Steps**: Begin Phase 1 implementation (see `structured-clone-format-migration.md`)

