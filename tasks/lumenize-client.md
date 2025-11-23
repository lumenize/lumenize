# LumenizeClient

**Status**: Planning - Blocked on LumenizeBase Lifecycle Hooks
**Created**: 2025-11-23

## Objective

Build a bidirectional WebSocket client (browser/Node.js) for connecting to LumenizeBase Durable Objects, providing structured session-based communication with automatic message serialization and reconnection.

## Prerequisite

✅ **Blocked on**: `lumenize-base-lifecycle-hooks.md` must be complete
- Requires server-side lifecycle hooks
- Requires message envelope format
- Requires DO name storage pattern

## Context

LumenizeClient is the client-side complement to LumenizeBase lifecycle hooks, providing:
- WebSocket connection management (lazy connect, auto-reconnect)
- Message serialization (structured-clone)
- Request/response pattern with timeouts
- Downstream message handling (server→client)

### Complementary to RPC

| Aspect | RPC | LumenizeClient |
|--------|-----|----------------|
| **Use Case** | Transparent method calls | Structured messaging, sessions |
| **Communication** | Request-response only | Bidirectional (request + events) |
| **Abstraction** | High (feels like local calls) | Low (explicit messages) |
| **State** | Stateless (per-request) | Stateful (persistent connection) |
| **Batching** | Automatic | Manual |
| **Best For** | APIs, method proxying | Real-time apps, notifications |

## Package Structure

**Decision**: LumenizeClient lives in `@lumenize/lumenize-base` (same package)

**Rationale**:
- Tightly coupled - two sides of same connection
- Shared types and constants
- Simpler dependency management
- Clear that they work together

**Package Layout**:
```
packages/lumenize-base/
  src/
    lumenize-base.ts      # Server side (exists)
    lumenize-client.ts    # Client side (NEW)
    lumenize-worker.ts    # Worker side (exists)
    constants.ts          # Shared
    types.ts             # Shared
    index.ts             # Exports all
```

## Phase 1: Transport Infrastructure

**Goal**: Move WebSocket transport from RPC to utils, make reusable

**Success Criteria**:
- ✅ Move transports from `@lumenize/rpc` to `@lumenize/utils`
  - websocket-transport.ts
  - http-post-transport.ts  
  - transport-types.ts
- ✅ Update `@lumenize/rpc` imports to use utils
- ✅ Test RPC still works after move
- ✅ Generic transport ready for LumenizeClient

**Rationale**: Avoid circular dependencies, both RPC and LumenizeClient need transports

## Phase 2: LumenizeClient Implementation

**Goal**: Implement client class in lumenize-base package

**Success Criteria**:
- ✅ LumenizeClient class created
- ✅ Constructor with config validation
- ✅ connect() / disconnect() methods
- ✅ send(message) - fire and forget
- ✅ request(message) - request/response with timeout
- ✅ Event handlers (onMessage, onConnect, onDisconnect, onError)
- ✅ Symbol.dispose for 'using' support
- ✅ Message queuing when disconnected
- ✅ Request/response ID matching

**API Design**:
```typescript
import { LumenizeClient } from '@lumenize/lumenize-base';

const client = new LumenizeClient({
  baseUrl: 'wss://lumenize.com',
  doBinding: 'lumenize',              // Lowercase!
  instance: 'user-123',
  clientId: crypto.randomUUID(),      // Auto-generated if omitted
  onDownstream: (data) => {
    // data is already deserialized
    console.log('Received:', data);
  },
  onClose: (code, reason) => {
    console.log('Disconnected:', code, reason);
  }
});

// Send anything structured-clone supports
await client.send({ action: 'subscribe' });
await client.send(new Map([['key', 'value']]));

// Request/response pattern
const response = await client.request({ action: 'getState' });

// Manual lifecycle
client.disconnect();
```

## Phase 3: Factory Function

**Goal**: Add createLumenizeClient() factory (primary API)

**Success Criteria**:
- ✅ Factory function with clean API
- ✅ Returns client with Symbol.dispose
- ✅ Automatic cleanup with 'using'
- ✅ Same config as constructor

**Factory Pattern**:
```typescript
import { createLumenizeClient } from '@lumenize/lumenize-base';

using client = createLumenizeClient({
  baseUrl: 'wss://lumenize.com',
  doBinding: 'lumenize',
  instance: 'user-123',
  onDownstream: (data) => { ... }
});

// Send messages
await client.send({ action: 'subscribe' });

// Cleanup automatic with 'using'
```

## Phase 4: Connection Management

**Goal**: Implement robust connection lifecycle

**Success Criteria**:
- ✅ Lazy connection (connect on first message)
- ✅ Auto-reconnect with exponential backoff
- ✅ Connection state tracking
- ✅ Message queue during reconnection
- ✅ Timeout handling
- ✅ Clean disconnection

**Connection States**:
- DISCONNECTED - Initial state, no connection
- CONNECTING - WebSocket upgrade in progress
- CONNECTED - Active connection
- RECONNECTING - Auto-reconnect in progress
- CLOSED - Permanently closed (manual disconnect)

## Phase 5: Integration Testing

**Goal**: Test client-server communication end-to-end

**Success Criteria**:
- ✅ Basic messaging (client→server, server→client)
- ✅ Request/response pattern
- ✅ Connection lifecycle (connect, disconnect, reconnect)
- ✅ Message serialization (complex types)
- ✅ Error scenarios (network drop, timeouts)
- ✅ Concurrent requests
- ✅ ClientId tagging

**Test Structure**:
- Use test DO from lifecycle hooks tests
- Test bidirectional ping-pong
- Test auto-reconnect
- Test request timeout

## Phase 6: Documentation

**Goal**: Document client API and usage patterns

**Success Criteria**:
- ✅ Create website/docs/lumenize-client/index.mdx
  - Overview and use cases
  - Quick start guide
  - Comparison with RPC
- ✅ Create website/docs/lumenize-client/client-api.mdx
  - Configuration options
  - Sending messages
  - Request/response pattern
  - Event handlers
- ✅ Create doc-test examples
  - Basic messaging
  - Request/response
  - Real-time notifications
- ✅ Update packages/lumenize-base/README.md

## Phase 7: TypeDoc API Documentation

**Goal**: Generate API reference

**Success Criteria**:
- ✅ Add TypeDoc plugin to website config
- ✅ Add sidebar loader
- ✅ Review/enhance JSDoc comments
- ✅ Export only public API from index.ts

## Design Decisions

### Clean URLs (No Prefix)

Use DO binding name as first segment:
```
wss://lumenize.com/lumenize/user-123
wss://lumenize.com/lumenize/universe.galaxy.star
```

**Implementation**:
```typescript
// Client builds URL
const url = `${baseUrl}/${doBinding}/${instance}`;

// Worker routes without prefix
return await routeDORequest(request, env);
```

### ClientId via Protocol Smuggling

Use WebSocket protocols array (consistent with RPC):
```typescript
const ws = new WebSocket(url, [
  'lmz',
  `lmz.client-id.${crypto.randomUUID()}`,
  'lmz-token'  // Placeholder for future auth
]);
```

**Rationale**: More secure than URL params, browser WebSocket API doesn't allow headers

### Message Envelope (Internal)

Slim envelope for routing, transparent to users:
```typescript
// Internal only
interface LumenizeEnvelope {
  type: '__lmz';
  payload: any;
  id?: string;
}
```

**User never sees envelope** - LumenizeClient wraps/unwraps automatically

### Same Package Decision

LumenizeClient in `@lumenize/lumenize-base` not separate package:
- Tightly coupled
- Shared types
- Simpler dependencies
- Clear relationship

### Transport Location

Move transports to `@lumenize/utils` (not new package):
- Avoid circular dependencies
- Reusable for RPC and LumenizeClient
- Battle-tested code

### Authentication Strategy

Delegate to routeDORequest hooks (consistent with RPC):
```typescript
// In Worker
await routeDORequest(request, env, {
  onBeforeConnect: async (request) => {
    const token = request.headers.get('Authorization');
    if (!token || !await validateToken(token)) {
      return new Response('Unauthorized', { status: 401 });
    }
    return request;
  }
});
```

## Success Criteria

### Must Have
- ✅ Client connects to LumenizeBase DO over WebSocket
- ✅ Client sends messages (any structured-clone type)
- ✅ Client receives downstream messages
- ✅ Request/response pattern with timeout
- ✅ Auto-reconnect after connection drop
- ✅ Message queuing during reconnection
- ✅ ClientId in protocols
- ✅ Symbol.dispose for 'using' support
- ✅ Unit tests >80% coverage
- ✅ Integration tests
- ✅ Documentation complete
- ✅ TypeDoc API reference

### Nice to Have
- Testing utilities in @lumenize/testing
- HTTP fallback transport
- Connection state debugging tools
- Performance benchmarks

### Won't Have (Yet)
- ❌ MCP protocol (future: Lumenize package)
- ❌ Entity/resource subscription (future)
- ❌ Multi-room pooling (YAGNI)
- ❌ Binary messages (structured-clone handles all)
- ❌ Upstream messaging (future)

## Migration from Old LumenizeClient

For users of lumenize-monolith:

**Old**:
```typescript
import { LumenizeClient } from 'lumenize-monolith';

const client = new LumenizeClient({
  host: 'example.com',
  galaxy: 'milky-way',      // DO namespace
  star: 'user-123',         // DO instance
  route: 'mcp',
  onEntityUpdate: (msg) => { ... }
});

await client.callMethod('initialize', { ... });
```

**New**:
```typescript
import { createLumenizeClient } from '@lumenize/lumenize-base';

using client = createLumenizeClient({
  baseUrl: 'wss://example.com',
  doBinding: 'lumenize',      // Was 'galaxy'
  instance: 'user-123',       // Was 'star'
  onDownstream: (data) => {
    // data already deserialized
    console.log('Received:', data);
  }
});

await client.send({ action: 'initialize', params: { ... } });
```

**Key Changes**:
- Galaxy/star → doBinding/instance (standard terminology)
- SubscriberId in URL → clientId in protocols
- MCP built-in → protocol-agnostic
- PartySocket → Native WebSocket
- onEntityUpdate → onDownstream
- Complex values supported (Maps, Dates, Errors, etc.)

## Future Enhancements

### Per-DO Debug Logging Override

**Problem**: Enable debug logging for specific DO instance without redeploying

**Solution**: Per-DO debug configuration via storage override `_lmz:debug`

**Blockers**:
- 🚫 Requires auth system (admin operation)
- 🚫 Requires LumenizeClient admin API

**Priority**: Post-v1 (after auth implemented)

## Notes

### Implementation Order

1. Phase 1: Transport infrastructure (reuse from RPC)
2. Phase 2-3: Client implementation and factory
3. Phase 4: Connection management (reconnection, queuing)
4. Phase 5: Integration testing
5. Phase 6-7: Documentation

### Further Splitting

This task file covers all of LumenizeClient. When we start implementation, we may want to split into:
- Core client implementation
- Connection management & reconnection
- Request/response pattern
- Testing & documentation

We'll evaluate when we begin work.

## References

- `packages/rpc/src/websocket-rpc-transport.ts` - Transport patterns
- `packages/rpc/src/client.ts` - Client lifecycle, downstream
- `lumenize-monolith/src/lumenize-client.ts` - Old client (reference)
- [RPC Quick Start](https://lumenize.com/docs/rpc/quick-start)
- [Downstream Messaging](https://lumenize.com/docs/rpc/downstream-messaging)

