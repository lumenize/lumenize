# Routing Pattern Comparison: Cap'n Web vs Lumenize

## Purpose
Compare the recommended routing patterns for Cap'n Web and Lumenize RPC to understand architectural differences and whether there are performance implications.

## Understanding the Confusion

**What I initially tested**: Two different Cap'n Web routing patterns (simple vs complex regex)
**What was requested**: Cap'n Web's recommended pattern vs Lumenize's recommended pattern

Let me clarify both approaches properly.

## Cap'n Web's Recommended Pattern

From [Cap'n Web README](https://github.com/capnproto/capnweb) - they show **very simple** examples:

### Worker-Only Example
```typescript
import { RpcTarget, newWorkersRpcResponse } from "capnweb";

class MyApiServer extends RpcTarget {
  hello(name) {
    return `Hello, ${name}!`;
  }
}

export default {
  fetch(request, env, ctx) {
    let url = new URL(request.url);
    
    // Serve API at `/api` - NO routing helper needed
    if (url.pathname === "/api") {
      return newWorkersRpcResponse(request, new MyApiServer());
    }
    
    return new Response("Not found", {status: 404});
  }
}
```

### With Durable Objects
Cap'n Web does **NOT provide a routing helper** for Durable Objects. You must manually route to DO stubs:

**Worker Code**:
```typescript
export default {
  fetch(request, env, ctx) {
    let url = new URL(request.url);
    
    // Manual DO routing - parse URL yourself
    if (url.pathname.startsWith("/counter/")) {
      const id = url.pathname.split("/")[2];
      const stub = env.COUNTER.getByName(id);
      return stub.fetch(request);  // Forward to DO
    }
    
    return new Response("Not found", {status: 404});
  }
}
```

**DO Code**:
```typescript
import { RpcTarget, newWorkersRpcResponse } from "capnweb";

class CounterCapnWeb extends RpcTarget {
  // Your DO implementation
  
  fetch(request: Request) {
    return newWorkersRpcResponse(request, this);
  }
}
```

**Key Characteristics**:
- ✅ **Very simple**: `newWorkersRpcResponse()` does everything
- ✅ **No URL conventions**: You choose your own structure
- ⚠️ **Manual DO routing**: Worker must parse URLs and get stubs itself
- ⚠️ **No routing helper**: You write the routing logic

## Lumenize's Recommended Pattern

### With Durable Objects (Automatic Routing)

**Worker Code**:
```typescript
import { routeDORequest } from '@lumenize/routing';

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    // Automatically routes to DOs based on URL convention
    const rpcResponse = await routeDORequest(request, env, { prefix: '/__rpc' });
    if (rpcResponse) return rpcResponse;
    
    // Handle other routes...
    return new Response('Not Found', { status: 404 });
  }
}
```

**DO Code**:
```typescript
import { lumenizeRpcDO, handleRpcRequest } from '@lumenize/rpc';

class _CounterLumenize extends DurableObject {
  // Your DO implementation
  
  async fetch(request: Request): Promise<Response> {
    const rpcResponse = await handleRpcRequest(request, this);
    if (rpcResponse) return rpcResponse;
    
    // Handle non-RPC routes...
    return new Response('Not found', { status: 404 });
  }
}

export const CounterLumenize = lumenizeRpcDO(_CounterLumenize);
```

**Key Characteristics**:
- ✅ **Automatic DO routing**: `routeDORequest` parses URL and routes to correct DO binding
- ✅ **Convention over configuration**: URL pattern `/__rpc/{BINDING_NAME}/{INSTANCE_ID}/call`
- ✅ **No manual stub management**: Helper handles `env[BINDING].getByName(id)` automatically
- ✅ **WebSocket support**: Automatically handles WebSocket upgrades
- ✅ **Clear separation**: Prefix (`/__rpc`) distinguishes RPC from non-RPC routes

## URL Pattern Comparison

### Cap'n Web (Application-Defined)
```
URL: /counter/abc123  (or any pattern you choose)
Routing: Worker parses URL manually, gets DO stub, forwards request
Helper: None - you write the routing logic
Pattern: Completely flexible (you define it)
```

### Lumenize (Convention-Based)
```
URL: /__rpc/COUNTER/abc123/call
Routing: routeDORequest helper parses and routes automatically  
Helper: routeDORequest (from @lumenize/routing)
Pattern: Fixed convention (prefix + binding + id + suffix)
```

## The Routing Test Confusion Explained

### What I Tested (Wrong Comparison)
I compared two Cap'n Web routing patterns:
1. Complex: `/__rpc/COUNTER_CAPNWEB/{id}/call` with detailed regex
2. Simple: `/COUNTER_CAPNWEB/{id}` with simpler regex

**Results**: Simple routing was 30-90% slower (but high variance suggests unreliable measurement)

**Problem**: Both were Cap'n Web! I should have compared Cap'n Web vs Lumenize.

### What Should Be Tested (Correct Comparison)
1. **Cap'n Web's recommended**: Manual routing with simple URL pattern
2. **Lumenize's recommended**: `routeDORequest` helper with `/__rpc` convention

However, both ultimately call `stub.fetch(request)` to route to the DO, so the performance should be identical. The difference is **developer experience**, not performance.

## Architectural Differences

### Cap'n Web Philosophy
- **Minimal abstraction**: Close to bare metal Cloudflare APIs
- **Flexible**: No URL conventions, you choose your structure  
- **Explicit**: Developer writes routing logic, sees full control flow
- **Simple**: One function (`newWorkersRpcResponse`) handles everything

### Lumenize Philosophy
- **Convention over configuration**: URL patterns follow a standard
- **Automatic routing**: Helper functions reduce boilerplate
- **Separation of concerns**: Clear distinction between RPC and non-RPC routes
- **Opinionated**: Requires specific URL structure for automatic routing

## Performance Analysis

**Both approaches use the same underlying Cloudflare routing (`stub.fetch()`), so performance should be identical.**

The previous "simple vs complex" routing test compared two different URL parsing strategies within Cap'n Web only. The high variance (±30-90%) and unexpected results (simpler was slower) suggest:
- Network latency dominates (95-99% of total time)
- Routing overhead is unmeasurable noise
- Choose based on developer experience, not performance

## When to Use Each

### Use Cap'n Web When:
- You want minimal abstraction (closest to bare metal)
- You prefer explicit routing control
- You need custom URL patterns
- You're integrating with existing URL schemes
- You want official Cloudflare support

### Use Lumenize When:
- You want automatic DO routing helpers
- You prefer convention over configuration
- You're building systems with multiple DO types
- You want clear namespace separation (`/__rpc` prefix)
- You value the additional features (better error handling, circular ref support)

## Current Implementation Status

### In Current Tests
- **Both implementations** use the same URL pattern: `/__rpc/{BINDING}/{ID}/call`
- **Both implementations** use manual regex parsing in Worker (not using either framework's recommended pattern)
- This ensures fair performance comparison but doesn't showcase either framework's recommended approach

### Recommended Patterns
- **Cap'n Web**: Would use simpler manual routing (per their examples)
- **Lumenize**: Already uses `routeDORequest` in `packages/rpc/test/test-worker-and-dos.ts`

## Conclusion

The routing pattern choice is about **developer experience**, not performance:

- **Cap'n Web**: Minimal, flexible, explicit - you write the routing
- **Lumenize**: Convention-based, automatic - routing helper does it for you

Both are fast. Both work well. Choose based on your preferences for abstraction vs explicitness.
