# Test Coverage Documentation

**Current Coverage**: 78.31% statements, 68.88% branches, 80.95% functions, 78.15% lines

## Intentionally Uncovered Code

### Defensive/Unreachable Code Paths

These code paths are defensive programming (safety checks) that should be unreachable in normal operation:

1. **`serialize.ts` line 110**: `throw new Error(\`Unknown Web API type: ${webApiType}\`)`
   - **Rationale**: Should be unreachable if `getWebApiType()` works correctly
   - **Context**: Switch statement default case after type detection
   - **Risk**: Low - type detection is well-tested via integration

2. **`web-api-objects.ts` line 260**: `throw new Error('Unknown Web API marker type')`
   - **Rationale**: Should be unreachable if marker serialization works correctly
   - **Context**: Default case in `deserializeWebApiObject()` switch
   - **Risk**: Low - marker types are enum-like and all cases should be handled

3. **`special-numbers.ts` line 53**: `throw new Error(\`Not a special number: ${value}\`)`
   - **Rationale**: Should be unreachable - only called after `isSpecialNumber()` check
   - **Context**: Defensive check in `serializeSpecialNumber()`
   - **Risk**: Low - type checking happens before this function is called

4. **`special-numbers.ts` line 80**: `throw new Error('Unknown special number marker')`
   - **Rationale**: Should be unreachable if marker serialization works correctly
   - **Context**: Default case in `deserializeSpecialNumber()` switch
   - **Risk**: Low - marker types are enum-like (only 3 possible values)

### Hard-to-Test Error Handling

These paths handle error conditions that are difficult to simulate:

1. **`web-api-objects.ts` lines 98, 158**: Request/Response body reading error handling
   - **Rationale**: Would require mocking Request/Response streams that fail to read
   - **Context**: Try-catch around `request.text()` and `response.text()` calls
   - **Risk**: Low - these are defensive error handlers for edge cases

### Exported Utilities (Tested via Integration)

These are exported APIs for explicit control, tested via integration in other packages:

1. **`web-api-serialization.ts`** (0% coverage)
   - **Rationale**: Exported API for explicit control (queue storage, DO persistence)
   - **Usage**: Used by `@lumenize/proxy-fetch` package
   - **Testing**: Tested via integration in proxy-fetch package
   - **Markers**: Uses `__isSerialized*` format (different from main API's `__lmz_*` format)

2. **`error-serialization.ts` marker-based functions** (lines 158-249, partial coverage)
   - **Rationale**: Exported API for protocol-level errors
   - **Usage**: Used for RPC response.error fields
   - **Testing**: May be tested in RPC package or via integration
   - **Coverage**: 57.69% overall (indexed format functions are covered, marker-based are for explicit control)

## Coverage Targets

- **Current**: 78.31% statements, 68.88% branches
- **Target**: >90% statements, >80% branches
- **Gap**: ~12% statements, ~11% branches

**Analysis**: Most gap is intentional (defensive code, exported utilities). Remaining gap could be addressed by:
- Testing edge cases for body reading failures (complex mocking required)
- Adding explicit unit tests for exported marker-based utilities (currently tested via integration)

## Test Philosophy

Our test suite prioritizes:
1. **Round-trip tests** - Verify correctness regardless of format (format-agnostic)
2. **Integration tests** - Test via main `stringify()`/`parse()` API
3. **Public API contract tests** - Verify exported APIs work correctly

We do NOT prioritize:
- Testing defensive code that should be unreachable
- Testing internal implementation details
- Testing error paths that require complex mocking

