# Test Coverage Documentation

**Format**: Tuple-based `$lmz` format (since v2.0.0)

## Implementation Files

The package now uses a clean tuple-based serialization format:

- **`serialize-tuple.ts`** - Main serialization logic, two-pass with cycle/alias support
- **`deserialize-tuple.ts`** - Main deserialization logic, two-pass reconstruction
- **`web-api-serialization.ts`** - Request/Response/Headers/URL utilities
- **`special-numbers.ts`** - NaN/Infinity/-Infinity handling

## Intentionally Uncovered Code

### Defensive/Unreachable Code Paths

These are defensive programming (safety checks) that should be unreachable in normal operation:

1. **`special-numbers.ts`**: Default cases in switch statements
   - **Rationale**: Should be unreachable - only called after type checking
   - **Context**: Defensive checks in serialize/deserialize functions
   - **Risk**: Low - type checking happens before these functions are called

### Hard-to-Test Error Handling

These paths handle error conditions that are difficult to simulate:

1. **`web-api-serialization.ts`**: Request/Response body reading error handling
   - **Rationale**: Would require mocking Request/Response streams that fail to read
   - **Context**: Try-catch around `request.text()` and `response.text()` calls
   - **Risk**: Low - defensive error handlers for edge cases

### Exported Utilities (Tested via Integration)

These are exported APIs for explicit control, tested via integration in other packages:

1. **`web-api-serialization.ts`** - Exported serialization utilities
   - **Functions**: `serializeRequest`, `serializeResponse`, `deserializeRequest`, `deserializeResponse`
   - **Usage**: For explicit control over Request/Response serialization (queue storage, custom pipelines)
   - **Testing**: Tested via integration in `@lumenize/proxy-fetch` and via main `stringify()`/`parse()` API
   - **Note**: These accept callbacks for headers serialization, enabling custom reference handling

## Test Philosophy

Our test suite prioritizes:
1. **Round-trip tests** - Verify correctness regardless of format (format-agnostic)
2. **Integration tests** - Test via main `stringify()`/`parse()` API
3. **Alias and cycle tests** - Comprehensive coverage of reference handling
4. **Public API contract tests** - Verify exported APIs work correctly

We do NOT prioritize:
- Testing defensive code that should be unreachable
- Testing internal implementation details
- Testing error paths that require complex mocking

