# Testing Patterns Reference

Quick reference for the test patterns established in the RPC test upgrade project.

## Matrix Testing Pattern

**Use when:** You want to test the same behavior across multiple configurations

**Example:**
```typescript
// 1. Define your matrix configurations
const MATRIX = [
  { name: 'WebSocket + Factory', transport: 'websocket', doBinding: 'my-do' },
  { name: 'HTTP + Factory', transport: 'http', doBinding: 'my-do' },
  { name: 'HTTP + Manual', transport: 'http', doBinding: 'manual-do' },
];

// 2. Create reusable test functions
async function testBasicOperation(testable: TestableClient<MyDO>) {
  const result = await testable.client.myMethod();
  expect(result).toBe(expected);
}

// 3. Run through all configurations
MATRIX.forEach((config) => {
  describe(`Matrix: ${config.name}`, () => {
    it('should work with basic operation', async () => {
      const client = createMatrixClient(config, instanceId);
      try {
        await testBasicOperation(client);
      } finally {
        if (client.cleanup) await client.cleanup();
      }
    });
  });
});
```

**Benefits:**
- Tests defined once, run everywhere
- Easy to add new configurations
- Ensures consistent behavior across all setups
- No code duplication

## Behavior Test Pattern

**Use when:** You want to share test logic across multiple test files

**Structure:**
```
test/
  shared/
    behavior-tests.ts    # Reusable test functions
    do-methods.ts        # Shared DO implementations
  matrix.test.ts         # Runs behaviors through matrix
  subclass.test.ts       # Runs behaviors with inheritance
  custom.test.ts         # Custom scenarios using behaviors
```

**Implementation:**
```typescript
// behavior-tests.ts
export interface TestableClient<T> {
  client: RpcAccessible<T>;
  cleanup?: () => Promise<void>;
}

export const behaviorTests = {
  async increment(testable: TestableClient<ExampleDO>) {
    const count = await testable.client.increment();
    expect(typeof count).toBe('number');
  },
  
  async add(testable: TestableClient<ExampleDO>) {
    const sum = await testable.client.add(2, 3);
    expect(sum).toBe(5);
  },
  // ... more tests
};

export const testCategories = {
  basic: ['increment', 'add'],
  errors: ['throwError'],
  // ... more categories
};
```

**Usage:**
```typescript
// Any test file
import { behaviorTests, type TestableClient } from './shared/behavior-tests';

it('should increment', async () => {
  const testable = createClient();
  await behaviorTests.increment(testable);
});
```

## Async Testing Pattern with vi.waitFor()

**Use when:** Testing async events like WebSocket messages, timers, or state changes

**❌ Old pattern (manual Promise):**
```typescript
// Don't do this - requires manual timeout management
const messagePromise = new Promise<string>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('timeout')), 1000);
  ws.addEventListener('message', (event) => {
    clearTimeout(timeout);
    resolve(event.data);
  });
});

const message = await messagePromise;
expect(message).toBe('expected');
```

**✅ New pattern (vi.waitFor):**
```typescript
import { vi } from 'vitest';

// Do this - cleaner and more readable
let receivedMessage = '';
ws.addEventListener('message', (event) => {
  receivedMessage = event.data;
});

ws.send('request');

await vi.waitFor(() => {
  expect(receivedMessage).toBe('expected');
});
```

**Benefits:**
- ✅ No manual timeout management
- ✅ No cleanup required (`clearTimeout`)
- ✅ Built-in retry logic with polling
- ✅ Better error messages (shows expected vs actual)
- ✅ More readable - clear intent

**Connection waiting example:**
```typescript
// Wait for WebSocket to connect
let wsConnected = false;
ws.addEventListener('open', () => { wsConnected = true; });
ws.addEventListener('error', (err) => { throw err; });

await vi.waitFor(() => {
  expect(wsConnected).toBe(true);
});
```

**Multiple messages example:**
```typescript
// Test multiple async events
let receivedPong = '';
ws.addEventListener('message', (event) => {
  if (event.data === 'PONG') {
    receivedPong = event.data;
  }
});

// First message
ws.send('PING');
await vi.waitFor(() => {
  expect(receivedPong).toBe('PONG');
});

// Reset and test again
receivedPong = '';
ws.send('PING');
await vi.waitFor(() => {
  expect(receivedPong).toBe('PONG');
});
```

**Configuration:**
```typescript
// Customize timeout and interval
await vi.waitFor(() => {
  expect(condition).toBe(true);
}, {
  timeout: 2000,  // Wait up to 2 seconds
  interval: 50,   // Check every 50ms
});
```

## Custom Handler Coexistence Pattern

**Use when:** Testing RPC alongside custom routes/messages

**HTTP Example:**
```typescript
class ManualRoutingDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Custom routes FIRST
    if (url.pathname.endsWith('/health')) {
      return new Response('OK');
    }
    
    // RPC handling
    const rpcResponse = await handleRpcRequest(request, this);
    if (rpcResponse) return rpcResponse;
    
    // Fallback
    return new Response('Not found', { status: 404 });
  }
}
```

**WebSocket Example:**
```typescript
class ManualRoutingDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    // Check for WebSocket upgrade
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (url.pathname.startsWith(this.#rpcConfig.prefix)) {
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);
        this.ctx.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client });
      }
    }
    // ... HTTP handling
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Custom messages FIRST
    if (typeof message === 'string' && message === 'PING') {
      ws.send('PONG');
      return;
    }
    
    // RPC handling
    await handleRpcMessage(ws, message, this, this.#rpcConfig);
  }
}
```

**Test Pattern:**
```typescript
it('should mix custom and RPC', async () => {
  // Test custom endpoint
  const healthResponse = await fetch('.../health');
  expect(await healthResponse.text()).toBe('OK');
  
  // Test RPC
  const client = createRpcClient(...);
  const count = await client.increment();
  expect(count).toBeGreaterThan(0);
  
  // Test custom again - verify no interference
  const counterResponse = await fetch('.../counter');
  expect(counterResponse.ok).toBe(true);
});
```

## Inheritance Testing Pattern

**Use when:** Testing RPC with class inheritance

**Setup:**
```typescript
class _BaseDO extends DurableObject {
  async increment(): Promise<number> {
    // base implementation
  }
}

class _SubclassDO extends _BaseDO {
  // New method
  multiply(a: number, b: number): number {
    return a * b;
  }
  
  // Override
  override async increment(): Promise<number> {
    const count = await super.increment();
    return count + 1000; // bonus
  }
}

export const SubclassDO = lumenizeRpcDo(_SubclassDO);
```

**Test Scenarios:**
```typescript
// 1. Inherited methods work
it('should call inherited methods', async () => {
  const result = await client.getArray(); // from base class
  expect(result).toEqual([1, 2, 3, 4, 5]);
});

// 2. Overridden methods use subclass behavior
it('should use overridden behavior', async () => {
  const count = await client.increment(); // subclass version
  expect(count).toBe(1001); // includes bonus
});

// 3. New methods work
it('should call new methods', async () => {
  const product = await client.multiply(6, 7); // only in subclass
  expect(product).toBe(42);
});

// 4. Introspection includes all methods
it('should show all methods in __asObject', async () => {
  const obj = await client.__asObject();
  expect(Object.keys(obj)).toContain('increment'); // base
  expect(Object.keys(obj)).toContain('multiply'); // subclass
});
```

## Transport-Agnostic Client Factory

**Use when:** Tests should work with both WebSocket and HTTP

**Pattern:**
```typescript
function createMatrixClient(
  config: { transport: 'websocket' | 'http', doBindingName: string },
  instanceId: string
): TestableClient<MyDO> {
  const baseConfig = {
    doBindingName: config.doBindingName,
    doInstanceNameOrId: instanceId,
    transport: config.transport,
    baseUrl: 'https://fake-host.com',
    prefix: '__rpc',
  };

  // Add transport-specific config
  if (config.transport === 'websocket') {
    (baseConfig as any).WebSocketClass = getWebSocketShim(SELF);
  } else {
    (baseConfig as any).fetch = SELF.fetch.bind(SELF);
  }

  const client = createRpcClient<MyDO>(baseConfig);

  return {
    client,
    cleanup: async () => {
      await client[Symbol.asyncDispose]();
    },
  };
}
```

**Usage:**
```typescript
const TRANSPORTS = ['websocket', 'http'] as const;

TRANSPORTS.forEach((transport) => {
  it(`should work with ${transport}`, async () => {
    const client = createMatrixClient({ transport, doBindingName: 'my-do' }, 'id-123');
    try {
      // Test logic - same for both transports
      const result = await client.client.myMethod();
      expect(result).toBe(expected);
    } finally {
      if (client.cleanup) await client.cleanup();
    }
  });
});
```

## Best Practices

### 1. Test Organization
- **Shared logic:** `test/shared/` directory
- **Behavior tests:** Reusable functions in `behavior-tests.ts`
- **Matrix tests:** `matrix.test.ts` for configuration combinations
- **Specific scenarios:** Dedicated test files (e.g., `subclass.test.ts`)

### 2. Test Isolation
- Each test uses unique instance ID: `${scenario}-${transport}-${Date.now()}`
- Cleanup in `finally` blocks
- No shared state between tests

### 3. Naming Conventions
- Matrix configs: Descriptive names like `'WebSocket + lumenizeRpcDo'`
- Test functions: Action-based like `testIncrement`, `testErrorHandling`
- Instance IDs: Include scenario and transport for debugging

### 4. Documentation
- Use JSDoc comments for complex patterns
- Include usage examples in comments
- Document why certain tests are organized as they are

### 5. Maintenance
- When adding new DO methods, add to `shared/do-methods.ts`
- When adding new behavior tests, add to `behaviorTests` object
- Update `testCategories` to organize new tests
- Matrix automatically picks up new behaviors

## Common Pitfalls to Avoid

❌ **Don't:** Duplicate test logic across transport types
✅ **Do:** Use matrix pattern to run same test through all transports

❌ **Don't:** Hard-code transport-specific logic in tests
✅ **Do:** Use factory functions to create transport-appropriate clients

❌ **Don't:** Share DO instances across tests
✅ **Do:** Use unique instance IDs for each test

❌ **Don't:** Forget cleanup in WebSocket tests
✅ **Do:** Always call `client[Symbol.asyncDispose]()` in `finally`

❌ **Don't:** Test redundant combinations (e.g., inheritance + manual routing)
✅ **Do:** Only test meaningful combinations that provide unique coverage

## Summary

These patterns enable:
- ✅ Zero test duplication
- ✅ Easy addition of new configurations
- ✅ Consistent testing across all scenarios
- ✅ Clear separation of concerns
- ✅ Maintainable test suite

The key insight: **Define behavior once, test everywhere.**
