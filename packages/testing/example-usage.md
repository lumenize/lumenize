# runWithWebSocketMock API Examples

The `runWithWebSocketMock` function now supports two usage patterns to reduce boilerplate code.

## New Simplified API (Recommended)

Auto-creates a Durable Object instance for you:

```typescript
// Before: 3 lines of boilerplate
const id = env.MY_DO.newUniqueId();
const stub = env.MY_DO.get(id);
await runWithWebSocketMock(stub, async (mock, instance, ctx) => {
  // test code here
});

// After: 1 clean line
await runWithWebSocketMock(async (mock, instance, ctx) => {
  // test code here
});
```

With optional timeout:

```typescript
await runWithWebSocketMock(async (mock, instance, ctx) => {
  // test code here
}, 5000); // 5 second timeout
```

## Traditional API (Still Supported)

When you need to control the Durable Object instance (e.g., for testing with specific state):

```typescript
const id = env.MY_DO.newUniqueId();
const stub = env.MY_DO.get(id);

// Set up some initial state
await runInDurableObject(stub, async (instance, ctx) => {
  await ctx.storage.put("initial-data", "test-value");
});

// Then test with that state
await runWithWebSocketMock(stub, async (mock, instance, ctx) => {
  const initialData = await ctx.storage.get("initial-data");
  expect(initialData).toBe("test-value");
  // rest of test...
});
```

## Migration Guide

Most tests can be simplified by removing the stub creation:

```diff
- const id = env.MY_DO.newUniqueId();
- const stub = env.MY_DO.get(id);
- await runWithWebSocketMock(stub, async (mock, instance, ctx) => {
+ await runWithWebSocketMock(async (mock, instance, ctx) => {
    // test code unchanged
  });
```

Only keep the explicit stub creation when you need to:
- Pre-populate Durable Object storage
- Test with multiple instances
- Share state between test calls
