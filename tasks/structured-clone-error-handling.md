# Error Handling in @lumenize/structured-clone

## Current Status

**36 RPC tests are failing** because Error objects are not being fully preserved by `@lumenize/structured-clone`.

## The Problem

Currently, when an Error object passes through structured-clone, it loses custom properties:

### What's Lost:
- **`name` property**: Custom error names (e.g., `'CustomError'`) revert to `'Error'`
- **Custom properties**: Any additional fields added to the Error object

### Example:
```typescript
const error = new CustomError('Something went wrong');
error.statusCode = 404;

// After structured-clone:
// - error.name === 'Error' (should be 'CustomError')  
// - error.statusCode === undefined (should be 404)
// - error.message === 'Something went wrong' ✅ (preserved)
// - error.stack === '...' ✅ (preserved)
```

## Why This Matters

Error objects need full-fidelity serialization across RPC boundaries. Applications rely on:
- **Error.name** for error type discrimination
- **Custom properties** (status codes, error codes, context data)

## What Was Changed in RPC

The RPC layer has been **cleaned up** to remove duplicate serialization:

### Removed:
- ❌ Custom Error serialization in `client.ts` (processOutgoingOperations)
- ❌ Custom Error deserialization in `client.ts` (postprocessResult)
- ❌ Custom Error deserialization in `lumenize-rpc-do.ts` (processIncomingOperations)
- ❌ Custom Error serialization in `lumenize-rpc-do.ts` (preprocessResult)

### Kept:
- ✅ `serializeError()` for RPC error **responses** (not data passing through)
  - Used in `lumenize-rpc-do.ts` lines 208, 274
  - This is for protocol-level error responses, not user data

### Updated:
- `isStructuredCloneNativeType()` now passes Error objects through
- Added TODO comments documenting the issue

## What Needs to Be Fixed in @lumenize/structured-clone

### Required:
1. **Preserve `name` property** on all Error subclasses
2. **Preserve custom properties** added to Error instances
3. **Maintain prototype chain** (Error → CustomError → instance)

### Test Coverage Needed:
```typescript
// Basic Error
const err1 = new Error('test');
// ✅ Should preserve: message, stack

// Named Error  
const err2 = new CustomError('test');
// ✅ Should preserve: message, stack, name='CustomError'

// Error with custom properties
const err3 = new Error('test');
err3.statusCode = 404;
err3.context = { userId: '123' };
// ✅ Should preserve: message, stack, statusCode, context

// Built-in Error subclasses
const err4 = new TypeError('test');
// ✅ Should preserve: message, stack, name='TypeError'
```

## Implementation Strategy

The current approach in `@lumenize/structured-clone` likely needs:

1. **Detect Error instances** early in the serialization pipeline
2. **Extract all enumerable + non-enumerable properties**:
   - `name` (non-enumerable on Error.prototype)
   - `message` (own property)
   - `stack` (own property)  
   - Any custom properties added by user
3. **Serialize with a marker**: e.g., `{ __type: 'Error', __name: 'CustomError', ... }`
4. **Reconstruct on deserialization**:
   - Create Error instance with `message`
   - Set `name` property
   - Restore `stack` if present
   - Restore all custom properties

## Testing

After fixing structured-clone, verify with:
```bash
cd packages/rpc
npm test
```

All 36 Error-related tests should pass, bringing the total back to **296 passing tests**.

## Related Files

- `/packages/rpc/src/structured-clone-utils.ts` - TODO comment at line 16
- `/packages/rpc/src/client.ts` - TODO comment about Error preservation  
- `/packages/rpc/src/lumenize-rpc-do.ts` - Error pass-through at line 421
- `/packages/rpc/src/error-serialization.ts` - Current custom serialization (reference implementation)

## References

- [MDN: Error](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error)
- [Structured Clone Algorithm (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm)

