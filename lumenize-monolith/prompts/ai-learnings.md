# AI Learnings for Lumenize Development

This file documents key insights and learnings that can help improve future development tasks.

## MCP Protocol Specifications

### Official MCP Draft Specifications (2025-01-06)
**Location**: The unofficial Model Context Protocol draft specifications that we are designing to are located in the folder within this mcp workspace: 
- Specification: modelcontextprotocol/docs/specification/draft
- JSON Schema: modelcontextprotocol/schema/draft/schema.json
- TypeScript Schema: modelcontextprotocol/schema/draft/schema.ts

Note all of those are currently evolving and may not be perfectly in sync with each other. As of 2025-08-29, the mcpSessionId field is not listed as an optional field on anything but the initialize messages which does not align with the draft specifications.

## Testing Best Practices

### Test Determinism (2025-07-20)
**Issue**: Using conditional logic like `if (result.error)` in tests makes them non-deterministic.

**Problem**: A test that only checks conditions when an error exists could pass even if the validation logic is completely broken (e.g., if no error occurs when one should).

**Deeper Issue**: Overcomplicating tests with unnecessary defensive programming:
- Using complex helper functions with try/catch loops instead of simple `mock.getLastMessage()`  
- Adding conditional error checks when the test should have a clear expected outcome
- Testing edge cases that shouldn't even be possible (like regular subscriptions failing due to missing optional parameters)

**Example of problematic pattern**:
```typescript
// BAD: Non-deterministic test - only validates when error exists
if (result.error) {
  expect(result.error?.message).not.toContain('initialBaseline parameter is required');
}
// Problem: Test passes even if validation is broken and no error occurs when one should

// ALSO BAD: Defensive programming in tests that should have clear expected outcomes
if (result.error) {
  expect(result.error?.message).not.toContain('initialBaseline parameter is required');
} else {
  expect(result.result).toBeDefined();
}
// Problem: Prevents the test being read as documentation of the expected behavior
```

**Better Solution**: Keep tests simple and direct with clear expected outcomes:
```typescript
// BEST: Simple, direct test using mock.getLastMessage()
await instance.onMessage(mock.connection, subscribeMessage);
const response = mock.getLastMessage();
const result = JSON.parse(response);

// Test the specific expected outcome - either success OR error, not both
// For successful operations:
expect(result.result).toBeDefined();
expect(result.error).toBeUndefined();

// For operations that should fail:
expect(result.error).toBeDefined();
expect(result.error?.code).toBe(-32602);
```

**Rule**: Unless explicitly told otherwise, always make tests deterministic by ensuring all possible code paths are validated. When testing validation behavior, set up the test environment so the expected outcome is predictable.

## Error Handling

### JSON-RPC Error Codes (2025-07-20)
**Learning**: Parameter validation errors should return appropriate JSON-RPC error codes:
- `-32602` Invalid Params: For missing or invalid parameters (correct for missing `initialBaseline`)
- `-32603` Internal Error: For actual server-side errors, not parameter validation

**Fix Pattern**: In error handling catch blocks, specifically handle `ParameterValidationError` and map it to `ErrorCode.InvalidParams` rather than letting it fall through to generic internal error handling.

## Code Organization

### Test Structure for Complex Features (2025-07-20)
**Learning**: When implementing comprehensive features like patch subscriptions:

1. **Separate concerns**: 
   - Validation tests in one section
   - Comprehensive lifecycle tests in another
   - Error scenarios in a third section

2. **Remove duplication**: 
   - Consolidate related tests into a single comprehensive test file
   - Remove duplicate standalone test files after integration

3. **Clear ownership**: 
   - Each feature should have one primary test file that covers all scenarios
   - Lifecycle tests should focus on CRUD operations, not feature-specific details

**Example**: `integration-entity-patch-subscription.test.ts` became the single source of truth for all patch subscription testing, while `integration-entity-lifecycle.test.ts` focuses solely on entity CRUD and regular subscriptions.

## Test Design Principles

### Avoid Test Duplication (2025-07-20)
**Issue**: Creating multiple tests that validate the same functionality in different ways leads to maintenance overhead and unclear test ownership.

**Problem Examples**:
- Simple validation test: "should allow patch subscriptions with initialBaseline" - only checks subscription doesn't fail
- Comprehensive test: "complete patch subscription lifecycle with initialBaseline and consecutive patches" - tests full functionality including the same subscription

**Rule**: Before adding a new test, check if existing tests already cover the functionality:

1. **Comprehensive tests take precedence** - If a comprehensive test already validates the happy path, don't add a simple validation test for the same scenario
2. **One test per distinct scenario** - Each test should validate a unique behavior or error condition
3. **Validation tests for edge cases only** - Simple validation tests should focus on parameter validation, not functionality that's covered elsewhere

**Good test separation**:
```typescript
// GOOD: Tests distinct validation requirement
test('should require initialBaseline for patch subscriptions') // Tests missing parameter error

// GOOD: Tests comprehensive functionality (includes successful subscription)
test('complete patch subscription lifecycle with initialBaseline and consecutive patches')

// BAD: Redundant - comprehensive test already validates successful subscription
test('should allow patch subscriptions with initialBaseline') // ❌ Remove this
```

**Decision framework**:
- Does an existing comprehensive test already validate this scenario? → Don't add a simple test
- Is this testing a unique error condition? → Add focused error test  
- Is this testing a unique validation rule? → Add focused validation test
- Is this testing a complete workflow? → Add comprehensive test


## Test Code Quality

### Clean Test Output (2025-07-20)
**Rule**: Tests should not contain `console.log` statements in the final version.

**Why**: Console.log statements clutter test output and make it harder to focus on actual test results and failures.

**Exception**: Temporary console.log statements may be added during development to debug issues or understand test behavior.

**Requirement**: All debug console.log statements must be removed before considering a task complete.

**Example of cleanup needed**:
```typescript
// BAD: Debug statements left in final test
console.log('Entity created with timestamp:', timestamp);
console.log('Patch subscription established');
console.log('Validation completed successfully');

// GOOD: Clean test without debug output
// (no console.log statements)
```

**Process**: 
1. Add console.log during development for debugging if needed
2. Remove all console.log statements before task completion
3. Keep tests focused on assertions, not logging
