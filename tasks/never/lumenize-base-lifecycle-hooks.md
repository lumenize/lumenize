# LumenizeBase Lifecycle Hooks

**Status**: In Progress
**Started**: 2025-11-23
**Branch**: `feature/lumenize-base-lifecycle-hooks`

## Objective

Add WebSocket lifecycle hooks to LumenizeBase, providing a clean pattern for DO-to-client communication with automatic message serialization, connection management, and DO name storage.

## Design Principles

1. **Hooks Pattern**: Users implement lifecycle hooks (onConnect, onMessage, onClose, onRequest), not override internal methods
2. **Runtime Enforcement**: Prevent accidental override of fetch/webSocketMessage/webSocketClose with clear error messages
3. **Transport Encapsulation**: stringify/parse handled internally - users work with plain objects
4. **Zero Boilerplate**: Default alarm() implementation delegates to @lumenize/alarms when present

## Context

We have proven WebSocket patterns from `@lumenize/rpc` but need to expose them at the LumenizeBase level for general-purpose DO-to-client communication. This is complementary to RPC:
- **RPC**: Transparent method call proxying with automatic batching
- **LumenizeBase hooks**: Structured session-based communication with explicit message routing

## Phase 1: Core Design & Storage Schema

**Goal**: Define lifecycle hooks API and implement DO name storage

**Success Criteria**:
- ✅ Storage key pattern defined (`_lmz:doInstanceName`)
- ✅ DO name extraction from headers on WebSocket upgrade
- ✅ Distinguish between name vs ID (64-char hex check)
- ✅ Store name only (ID already available via ctx.id)

**Implementation Notes**:
```typescript
// Storage key
const DO_INSTANCE_NAME_KEY = '_lmz:doInstanceName';

// On WebSocket upgrade
const nameOrId = request.headers.get('x-lumenize-do-instance-name-or-id');
if (nameOrId && !isHexId64(nameOrId)) {
  this.ctx.storage.kv.put(DO_INSTANCE_NAME_KEY, nameOrId);
}
```

## Phase 2: Message Envelope & Serialization

**Goal**: Implement slim internal message envelope with transparent serialization

**Success Criteria**:
- ✅ Envelope format defined (type, payload, id?)
- ✅ Envelope wrapping/unwrapping in LumenizeBase
- ✅ structured-clone integration for serialization
- ✅ Users never see envelope in their code

**Design**:
```typescript
// Internal only - users never see this
interface LumenizeEnvelope {
  type: '__lmz';     // Route to LumenizeClient handler
  payload: any;      // User data (any structured-clone type)
  id?: string;       // Optional: for request/response
}
```

## Phase 3: Lifecycle Hooks Implementation

**Goal**: Add lifecycle hooks pattern with runtime override prevention

**Success Criteria**:
- ✅ Four lifecycle hooks defined: onConnect, onMessage, onClose, onRequest
- ✅ Runtime check prevents override of fetch/webSocketMessage/webSocketClose
- ✅ Clear error messages guide users to hooks
- ✅ ClientId extraction from WebSocket protocols
- ✅ Connection tagging with clientId

**Hooks API**:
```typescript
async onConnect(ws: WebSocket, request: Request): Promise<void>
async onMessage(ws: WebSocket, message: any, id?: string): Promise<void>
async onClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void>
async onRequest(request: Request): Promise<Response>
```

**Runtime Check**:
- Constructor checks if subclass overrode forbidden methods
- Throws clear error directing to lifecycle hooks

## Phase 4: Helper Methods

**Goal**: Provide four helper methods for sending messages

**Success Criteria**:
- ✅ send(ws, data, id?) - Send to specific WebSocket
- ✅ sendDownstream(clientId, data, exclude?) - Send to client(s) by tag
- ✅ broadcastDownstream(data, exclude?) - Send to all clients
- ✅ All methods encapsulate stringify internally
- ✅ Exclude parameter works correctly

**Pattern Examples**:
```typescript
// Request/response
if (id) await this.send(ws, result, id);

// Notify sender, broadcast to others
await this.send(ws, { status: 'sent' });
await this.broadcastDownstream(update, senderClientId);

// Send to specific users
await this.sendDownstream(['admin-1', 'admin-2'], alert);
```

## Phase 5: Default alarm() Implementation

**Goal**: Eliminate boilerplate for @lumenize/alarms users

**Success Criteria**:
- ✅ Default alarm() method in LumenizeBase
- ✅ Check global registry for alarms service
- ✅ Delegate to this.svc.alarms.alarm() if present
- ✅ Silent no-op if alarms not imported
- ✅ Users can still override if needed

**Implementation**:
```typescript
async alarm(): Promise<void> {
  // Check if @lumenize/alarms is imported (via NADIS)
  if (this.svc.alarms) {
    await this.svc.alarms.alarm();
  }
  // Silent no-op otherwise - safe default
}
```

## Phase 6: Integration Testing

**Goal**: Prove lifecycle hooks work end-to-end

**Success Criteria**:
- ✅ Test DO name storage (name vs ID)
- ✅ Test clientId extraction and tagging
- ✅ Test all lifecycle hooks called correctly
- ✅ Test all four helper methods
- ✅ Test message serialization (complex types)
- ✅ Test runtime override prevention
- ✅ Test default alarm() delegation

**Test Structure**:
- Create test DO extending LumenizeBase
- Implement all lifecycle hooks
- Test bidirectional messaging
- Test error scenarios

## Phase 7: Documentation

**Goal**: Document lifecycle hooks pattern and helper methods

**Success Criteria**:
- ✅ Update website/docs/lumenize-base/ with lifecycle hooks section
- ✅ Document four helper methods with examples
- ✅ Document DO name storage pattern
- ✅ Show complete chat room example
- ✅ Explain differences from direct WebSocket usage
- ✅ Note on default alarm() implementation

## Design Decisions

### ClientId via Protocol Smuggling

Use WebSocket protocols array to smuggle clientId (consistent with RPC):

```typescript
// Protocol format
['lmz', `lmz.client-id.${clientId}`, 'lmz-token']

// Server extracts and uses as tag
const clientId = extractClientId(protocols);
this.ctx.acceptWebSocket(server, [clientId]);
```

**Rationale**: More secure than URL params, consistent with RPC, browser WebSocket API doesn't allow headers

### Four Helper Methods

Clear, distinct purposes - no overloading:
1. `send(ws, data, id?)` - Specific connection
2. `sendDownstream(clientId, data, exclude?)` - By clientId/tag
3. `broadcastDownstream(data, exclude?)` - All clients
4. `onRequest(request)` - HTTP requests

**Rationale**: Covers all use cases, clear semantics, exclude parameter useful

### Transport Layer Encapsulation

All stringify/parse happens in LumenizeBase internals:
- LumenizeBase wraps outgoing in envelope + stringify
- LumenizeBase unwraps incoming from envelope + parse
- User hooks receive plain objects
- User methods accept plain objects

**Rationale**: Clean API, less error-prone, consistent with "objects in, objects out"

### Runtime Override Prevention

Constructor checks if subclass overrode forbidden methods:
```typescript
// In constructor
if (this.fetch !== LumenizeBase.prototype.fetch) {
  throw new Error('Do not override fetch() - use onRequest() instead');
}
```

**Rationale**: Prevents subtle bugs, clear error messages, guides users to hooks

## Success Criteria

### Must Have
- ✅ DO name stored on WebSocket connect (`_lmz:doInstanceName`)
- ✅ ClientId extracted from protocols and used as tag
- ✅ Runtime check prevents method overrides
- ✅ Four helper methods work correctly
- ✅ All lifecycle hooks called at correct times
- ✅ Message serialization transparent to users
- ✅ Default alarm() implementation works
- ✅ Integration tests pass
- ✅ Documentation complete

### Nice to Have
- Testing utilities in @lumenize/testing
- Performance benchmarks
- Connection state debugging tools

## Notes

### Storage Keys Pattern

All LumenizeBase internal keys use `_lmz:` prefix:
- `_lmz:doInstanceName` - DO name (not ID)
- Future: `_lmz:debug` for per-DO debug overrides (blocked on auth)

### Relationship to RPC

Lifecycle hooks are complementary to RPC:
- **RPC**: Method call abstraction (feels like local calls)
- **Hooks**: Explicit messaging (like WebSocket API)

Some applications will use both - RPC for CRUD, hooks for real-time notifications.

### Future: LumenizeClient

This work is prerequisite for `@lumenize/lumenize-client` (browser/Node.js client). Once lifecycle hooks are complete, we'll build the client side that connects to these hooks.

## References

- `packages/rpc/src/websocket-rpc-transport.ts` - WebSocket patterns
- `packages/utils/src/route-do-request.ts` - DO routing, headers
- [RPC Downstream Messaging](https://lumenize.com/docs/rpc/downstream-messaging)

