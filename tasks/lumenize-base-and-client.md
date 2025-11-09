# LumenizeBase & LumenizeClient - Bidirectional WebSocket Communication

**Status**: Planning - Ready for Review
**Started**: 2025-11-03
**Design Finalized**: 2025-11-03

## Goal

Build a bidirectional WebSocket communication system between LumenizeBase (Durable Objects) and LumenizeClient (browser/Node.js), providing a more structured alternative to Lumenize RPC for real-time, session-based applications.

This document covers enhancements to both LumenizeBase (server-side DO base class) and LumenizeClient (client-side connection class).

**Key Design Principle**: Transport layer encapsulation - users work with plain objects in/out, never touching stringify/parse. The transport layer (structured-clone) handles all serialization transparently.

## Context

We have a working RPC system (`@lumenize/rpc`) that uses WebSockets for method call proxying. LumenizeClient is complementary but distinct:

- **RPC**: Transparent method call proxying with automatic batching and operation chaining
- **LumenizeClient**: Structured session-based communication with explicit message routing and state management

### What We're Building On

**Existing Infrastructure**:
- `WebSocketRpcTransport` - Proven WebSocket transport with lazy connection, auto-reconnect, downstream messaging
- `routeDORequest` - DO routing with authentication hooks, CORS support, and header injection
- `LumenizeBase` - DO base class with NADIS service auto-injection
- Old `lumenize-monolith` LumenizeClient - Reference implementation with PartySocket

**Key Patterns to Reuse**:
1. **WebSocket Transport Pattern** - Connection management, message envelopes, serialization
2. **routeDORequest Pattern** - Puts `doInstanceNameOrId` into `x-lumenize-do-instance-name-or-id` header during WebSocket upgrade
3. **Storage Pattern** - Store DO name/id in storage kv (similar to Actors package name storage)
4. **Downstream Messaging** - Server-initiated messages to clients (already in RPC)

### Key Differences from Old Implementation

**Old LumenizeClient** (lumenize-monolith):
- Used PartySocket (third-party WebSocket library)
- MCP protocol baked in
- Galaxy/star terminology (DO namespace/instance)
- SubscriberId in URL params
- Cookie-based authentication

**New LumenizeClient** (this task):
- Use our proven WebSocket transport from RPC
- Protocol-agnostic (MCP later, generic now)
- Standard Cloudflare terminology (DO binding name/instance)
- ClientId smuggled via WebSocket protocols array (like RPC)
- Flexible authentication via routeDORequest hooks
- Consistent with Lumenize architecture patterns

## Packages Structure

### Package: `@lumenize/lumenize-base` (Enhanced, Not New)

**Purpose**: Both server-side (LumenizeBase) and client-side (LumenizeClient) in ONE package

**Why Same Package**:
- Tightly coupled - both sides of the same connection
- Shared types and constants
- Simpler dependency management
- Clear that they work together

**New Exports**:
- `LumenizeBase` class - Server-side DO base class (already exists, enhanced)
- `LumenizeClient` class - Client-side connection class (NEW)
- `createLumenizeClient()` factory - Recommended client API (NEW)
- Shared types and constants

**Dependencies**:
- `@lumenize/structured-clone` - Serialization (already exists)
- `@lumenize/utils` - For transport classes (moved from RPC)

### Changes to Other Packages

**`@lumenize/utils`**: Add transport classes (moved from RPC)
- `websocket-transport.ts` - Move from `@lumenize/rpc`
- `http-post-transport.ts` - Move from `@lumenize/rpc`
- `transport-types.ts` - Move from `@lumenize/rpc`
- Reason: Avoid circular dependencies, both RPC and LumenizeClient need transports

**`@lumenize/rpc`**: Update imports
- Import transports from `@lumenize/utils` instead of local files
- No functionality changes, just dependency updates

## Architecture

### Connection Flow

```
Browser/Node                Worker                    Durable Object
    │                         │                            │
    │ 1. new LumenizeClient   │                            │
    │    (lazy, no connection)│                            │
    │                         │                            │
    │ 2. connect() or         │                            │
    │    first message        │                            │
    ├────WebSocket Upgrade────>                            │
    │    protocols: [         │                            │
    │      'lumenize.client', │                            │
    │      'lumenize.client.  │                            │
    │        clientId.xxx'    │                            │
    │    ]                    │                            │
    │                         │                            │
    │                    routeDORequest()                  │
    │                    adds headers:                     │
    │                    x-lumenize-do-instance-name-or-id │
    │                    x-lumenize-do-binding-name        │
    │                         │                            │
    │                         ├─────WebSocket Upgrade──────>
    │                         │                            │
    │                         │         webSocketMessage() │
    │                         │         - Read headers     │
    │                         │         - Extract clientId │
    │                         │         - Store DO name    │
    │                         │         - Store clientId   │
    │                         │                            │
    │<────────────WebSocket Accepted──────────────────────┤
    │                         │                            │
    │ 3. Bidirectional        │                            │
    │    messaging over       │                            │
    │    WebSocket            │                            │
    │<─────────────────────────────────────────────────────>
```

### Message Envelope Format

**Slim envelope** - just enough for routing and request/response:

```typescript
// Transport envelope (internal to LumenizeBase - users never see this)
interface LumenizeEnvelope {
  type: '__lmz';         // Route to LumenizeClient handler (not RPC)
  payload: any;          // The actual data (any structured-clone type)
  id?: string;           // Optional: for request/response pattern
}

// Users work with plain data - envelope is transparent!
// Client sends:
await client.send({ action: 'subscribe', channel: 'updates' });

// Server receives in onMessage:
async onMessage(ws: WebSocket, message: any, id?: string) {
  // message = { action: 'subscribe', channel: 'updates' }
  // No envelope unwrapping needed!
}

// Server sends:
await this.send(ws, { status: 'subscribed' });

// Client receives:
onDownstream(data: any) {
  // data = { status: 'subscribed' }
  // No envelope unwrapping needed!
}
```

**Key Point**: Transport layer (LumenizeBase internals) handles envelope wrapping/unwrapping. User code is completely clean - objects in, objects out.

### Storage Schema

When a WebSocket connection is established, store:

```typescript
// Storage key: '__lumenize_client:do_name'
// Storage value: string (DO name, not ID)
const doName = 'my-do-instance';

// On WebSocket connect (in LumenizeBase or subclass):
onWebSocketConnect() {
  const doInstanceNameOrId = headers.get('x-lumenize-do-instance-name-or-id');
  
  // Only store if it's a name (not a 64-char hex ID)
  if (!isHexId(doInstanceNameOrId)) {
    ctx.storage.kv.put('__lumenize_client:do_name', doInstanceNameOrId);
  }
  // If it's an ID, we already have it via ctx.id
}
```

### Client API Design

**Factory Pattern** (primary API):

```typescript
import { createLumenizeClient } from '@lumenize/lumenize-base';

// Browser usage - clean URLs (no prefix)
using client = createLumenizeClient({
  baseUrl: 'wss://lumenize.com',
  doBinding: 'lumenize',              // Lowercase! Becomes /lumenize in URL
  instance: 'universe.galaxy.star',   // Future: hierarchical naming
  
  // Optional
  clientId: crypto.randomUUID(),      // Auto-generated if omitted
  onDownstream: (data) => {
    // data is already deserialized - any structured-clone type!
    console.log('Received:', data);
  },
  onClose: (code, reason) => {
    console.log('Disconnected:', code, reason);
  }
});

// Send anything structured-clone supports
await client.send({ action: 'subscribe' });
await client.send(new Map([['key', 'value']]));
await client.send(new Date());

// Request/response pattern
const response = await client.request({ action: 'getState' });

// Cleanup automatic with 'using'
```

**Class API** (advanced usage):

```typescript
import { LumenizeClient } from '@lumenize/lumenize-base';

const client = new LumenizeClient({
  baseUrl: 'wss://lumenize.com',
  doBinding: 'lumenize',
  instance: 'user-123'
});

// Manual lifecycle
await client.connect();
await client.send(message);
client.disconnect();
```

### Server API Design (LumenizeBase Enhancement)

**Lifecycle Hooks Pattern** (inspired by agents package, but cleaner):

```typescript
import { LumenizeBase } from '@lumenize/lumenize-base';

class MyDO extends LumenizeBase<Env> {
  // DO NOT override: fetch, webSocketMessage, webSocketClose
  // LumenizeBase implements these as final methods (runtime check enforced)
  
  // Override these hooks instead:
  
  /**
   * Called when WebSocket connection established
   */
  async onConnect(ws: WebSocket, request: Request): Promise<void> {
    const clientId = this.ctx.getTags(ws)[0];
    console.log('Client connected:', clientId);
    
    // Send welcome - transport handles serialization
    await this.send(ws, { message: 'Welcome!' });
  }
  
  /**
   * Called when message received
   * @param message - Already deserialized (any structured-clone type)
   * @param id - Optional request ID for request/response
   */
  async onMessage(ws: WebSocket, message: any, id?: string): Promise<void> {
    // message is already deserialized - just use it!
    if (message.action === 'getState') {
      const state = await this.getState();
      
      // Respond with matching ID (if this was a request)
      if (id) {
        await this.send(ws, state, id);
      }
    }
  }
  
  /**
   * Called when WebSocket closes
   */
  async onClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    console.log('Client disconnected:', code, reason);
    // Cleanup
  }
  
  /**
   * Called for HTTP requests
   */
  async onRequest(request: Request): Promise<Response> {
    return Response.json({ status: 'ok' });
  }
}
```

**Four Helper Methods** (provided by LumenizeBase):

```typescript
// 1. Send to specific WebSocket connection
await this.send(ws, data, id?);

// 2. Send to specific client(s) by clientId (tag)
await this.sendDownstream(clientId, data, exclude?);
await this.sendDownstream(['user-1', 'user-2'], data, 'user-3');

// 3. Broadcast to ALL clients
await this.broadcastDownstream(data, exclude?);

// 4. (Standard) HTTP response
return await this.onRequest(request);
```

**Complete Example**:

```typescript
export class ChatRoom extends LumenizeBase<Env> {
  async onConnect(ws: WebSocket, request: Request): Promise<void> {
    const clientId = this.ctx.getTags(ws)[0];
    
    // Welcome new user
    await this.send(ws, { message: 'Welcome to the chat!' });
    
    // Notify others (exclude sender)
    await this.broadcastDownstream(
      { type: 'userJoined', userId: clientId },
      clientId
    );
  }
  
  async onMessage(ws: WebSocket, message: any, id?: string): Promise<void> {
    const clientId = this.ctx.getTags(ws)[0];
    
    if (message.action === 'sendMessage') {
      // Respond to sender (request/response)
      if (id) {
        await this.send(ws, { status: 'sent', messageId: '...' }, id);
      }
      
      // Broadcast to everyone else
      await this.broadcastDownstream(
        { type: 'newMessage', text: message.text, from: clientId },
        clientId  // Exclude sender (no echo)
      );
    }
    
    if (message.action === 'whisper') {
      // Send to specific user
      await this.sendDownstream(
        message.targetUserId,
        { type: 'whisper', text: message.text, from: clientId }
      );
      
      if (id) {
        await this.send(ws, { status: 'whispered' }, id);
      }
    }
  }
  
  async onClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const clientId = this.ctx.getTags(ws)[0];
    await this.broadcastDownstream({ type: 'userLeft', userId: clientId });
  }
}
```

## Phases

### Phase 1: Core Transport Infrastructure ✅ (Mostly Done - Reuse from RPC)

The WebSocket transport infrastructure is already battle-tested in `@lumenize/rpc`:

**What we can reuse directly**:
- WebSocket connection management (lazy connect, reconnect)
- Message serialization (@lumenize/structured-clone)
- Downstream messaging pattern
- Timeout handling
- Connection state tracking

**What needs adaptation**:
- Extract generic WebSocket client separate from RPC-specific logic
- Support generic message routing (not just RPC batch responses)
- Protocol pattern (use 'lumenize.client' instead of 'lumenize.rpc')

**Tasks**:
- [ ] Review WebSocketRpcTransport implementation
- [ ] Design generic WebSocketTransport base (or adapter)
- [ ] Implement LumenizeClientTransport extending/wrapping base
- [ ] Add clientId protocol smuggling (like RPC)
- [ ] Test connection lifecycle (connect, disconnect, reconnect)

### Phase 2: LumenizeClient Implementation

Add client implementation to existing `@lumenize/lumenize-base` package.

**Tasks**:
- [ ] Create src/lumenize-client.ts in packages/lumenize-base
- [ ] Update package.json exports to include client
- [ ] Implement LumenizeClient class
  - [ ] Constructor with config validation
  - [ ] connect() / disconnect() methods
  - [ ] send(message) - fire and forget
  - [ ] request(message) - request/response with timeout
  - [ ] Event handlers (onMessage, onConnect, onDisconnect, onError)
  - [ ] Symbol.dispose for 'using' support
- [ ] Implement createLumenizeClient() factory
- [ ] Write TypeScript types
  - [ ] LumenizeClientConfig
  - [ ] ClientMessage / ServerMessage
  - [ ] Event handler types
- [ ] Unit tests (Node.js environment)
  - [ ] Configuration validation
  - [ ] Message queuing when disconnected
  - [ ] Request/response ID matching
  - [ ] Error handling

### Phase 3: LumenizeBase WebSocket Enhancements

Add WebSocket support and lifecycle hooks to LumenizeBase.

**Tasks**:
- [ ] Implement final methods (with runtime override check)
  - [ ] fetch() - Handle HTTP and WebSocket upgrade
  - [ ] webSocketMessage() - Parse envelope, call onMessage hook
  - [ ] webSocketClose() - Call onClose hook
- [ ] Implement constructor override detection
  - [ ] Check if subclass overrode fetch/webSocketMessage/webSocketClose
  - [ ] Throw clear error if detected
- [ ] Add DO name storage on WebSocket connect
  - [ ] Read x-lumenize-do-instance-name-or-id header
  - [ ] Detect if name vs ID (64-char hex check: `/^[0-9a-f]{64}$/i`)
  - [ ] Store in kv: `_lmz:doInstanceName`
- [ ] Add clientId extraction from WebSocket protocols
  - [ ] Parse 'lmz.client-id.${clientId}' protocol
  - [ ] Use as tag: `ctx.acceptWebSocket(ws, [clientId])`
- [ ] Implement lifecycle hook methods
  - [ ] onConnect(ws, request) - Called on WebSocket upgrade
  - [ ] onMessage(ws, message, id?) - Called on message received
  - [ ] onClose(ws, code, reason, wasClean) - Called on close
  - [ ] onRequest(request) - Called for HTTP requests
- [ ] Implement four helper methods
  - [ ] send(ws, data, id?) - Send to specific connection
  - [ ] sendDownstream(clientId, data, exclude?) - Send to client(s) by tag
  - [ ] broadcastDownstream(data, exclude?) - Send to all clients
  - [ ] All methods encapsulate stringify (transport layer)
- [ ] Add constants file
  - [ ] Storage keys: `_lmz:doInstanceName`
  - [ ] Protocol names: `lmz`, `lmz.client-id.${id}`, `lmz-token`

### Phase 4: Integration Testing

Test client-server communication end-to-end.

**Tasks**:
- [ ] Create test/integration directory
- [ ] Set up test DO extending LumenizeBase
- [ ] Test basic messaging
  - [ ] Client → Server messages
  - [ ] Server → Client messages (downstream)
  - [ ] Bidirectional ping-pong
- [ ] Test connection lifecycle
  - [ ] Lazy connection
  - [ ] Auto-reconnect
  - [ ] Manual disconnect
- [ ] Test request/response pattern
  - [ ] Request with response
  - [ ] Request timeout
  - [ ] Multiple concurrent requests
- [ ] Test DO name storage
  - [ ] Named instance stores name
  - [ ] ID-based instance doesn't overwrite ctx.id
- [ ] Test clientId extraction
  - [ ] Protocol smuggling
  - [ ] Connection tagging
- [ ] Test error scenarios
  - [ ] Network disconnection
  - [ ] Server errors
  - [ ] Invalid messages

### Phase 5: Documentation

Document the client-server communication system.

**Tasks**:
- [ ] Create website/docs/lumenize-client/index.mdx
  - [ ] Overview and use cases
  - [ ] Quick start guide
  - [ ] Comparison with RPC
- [ ] Create website/docs/lumenize-client/client-api.mdx
  - [ ] LumenizeClient configuration
  - [ ] Sending messages
  - [ ] Request/response pattern
  - [ ] Event handlers
  - [ ] Lifecycle management
- [ ] Create website/docs/lumenize-client/server-api.mdx
  - [ ] LumenizeBase WebSocket hooks
  - [ ] DO name storage
  - [ ] Message routing patterns
  - [ ] Broadcasting to clients
- [ ] Create doc-test examples
  - [ ] Basic client-server messaging
  - [ ] Request/response pattern
  - [ ] Real-time notifications
- [ ] Update packages/lumenize-client/README.md
  - [ ] Minimal README with link to docs
  - [ ] Key features bullet list
  - [ ] Installation instructions

### Phase 6: TypeDoc API Documentation

Generate API reference documentation.

**Tasks**:
- [ ] Add TypeDoc plugin to website/docusaurus.config.ts
  - [ ] Configure entry point
  - [ ] Set output directory
  - [ ] Configure sidebar generation
- [ ] Add sidebar loader to website/sidebars.ts
  - [ ] Import TypeDoc sidebar
  - [ ] Wrap in API Reference section
- [ ] Review and enhance JSDoc comments
  - [ ] Class documentation
  - [ ] Method documentation
  - [ ] Parameter documentation
  - [ ] Example usage in JSDoc
- [ ] Export only public API from index.ts
  - [ ] LumenizeClient class
  - [ ] createLumenizeClient factory
  - [ ] Public types/interfaces
  - [ ] Hide internal implementation details

### Phase 7: Testing Utilities (Optional)

Consider adding testing helpers similar to @lumenize/testing.

**Tasks**:
- [ ] Evaluate need for testing utilities
  - [ ] Mock WebSocket for unit tests?
  - [ ] Test helpers for message patterns?
  - [ ] Assertion helpers?
- [ ] If valuable, add to @lumenize/testing package
  - [ ] Mock LumenizeClient
  - [ ] Message capture/assertion
  - [ ] Connection state mocking

## Design Decisions

### 1. Clean URLs (No Prefix)

**Decision**: Use clean URLs with DO binding name as first segment, no prefix

**Example URLs**:
```
wss://lumenize.com/lumenize/user-123
wss://lumenize.com/lumenize/universe.galaxy.star
https://lumenize.com/lumenize/user-123/status
```

**Rationale**:
- Clean, simple URLs
- DO binding name "lumenize" (lowercase!) is the first segment
- Instance name/id is the second segment
- Future: universe.galaxy.star hierarchical naming (dots in instance name)

**Implementation**:
```typescript
// Worker - no prefix in routeDORequest
return await routeDORequest(request, env) || new Response('Not Found', { status: 404 });
```

### 2. WebSocket Transport Reuse Strategy

**Decision**: Move transports from RPC to utils, reuse for both RPC and LumenizeClient

**Rationale**:
- Battle-tested connection management
- Proven reconnection logic
- Avoid code duplication
- Consistent patterns across packages
- Both RPC and LumenizeClient need transports

**Implementation**:
- Move `websocket-transport.ts` from `@lumenize/rpc` to `@lumenize/utils`
- Move `http-post-transport.ts` from `@lumenize/rpc` to `@lumenize/utils`
- Both packages import from utils
- Transport changes tested against both RPC and LumenizeClient

### 3. Same Package for Client and Server

**Decision**: LumenizeClient lives in `@lumenize/lumenize-base` package, not separate

**Rationale**:
- Tightly coupled - two sides of same connection
- Shared types and constants
- Simpler dependency management
- Clear that they work together
- Consistent with pattern of related functionality in one package

**Package Structure**:
```
packages/lumenize-base/
  src/
    lumenize-base.ts      # Server side
    lumenize-client.ts    # Client side (NEW)
    constants.ts          # Shared
    types.ts             # Shared
    index.ts             # Exports both
```

### 4. DO Name Storage

**Decision**: Store DO name in storage kv with key `_lmz:doInstanceName`

**Rationale**:
- Consistent with Actors package pattern (uses `__actors:agent_name`)
- Allows DO to know its name even after eviction
- Useful for logging, debugging, and application logic
- Only store name (not ID) since `ctx.id` always available
- Prefix `_lmz:` for all LumenizeBase internal keys
- Lowercase prefix (not `__` which is more common for truly private)

**Implementation**:
```typescript
// In constants.ts
export const DO_INSTANCE_NAME_KEY = '_lmz:doInstanceName';

// On WebSocket upgrade in LumenizeBase.fetch()
const nameOrId = request.headers.get('x-lumenize-do-instance-name-or-id');
if (nameOrId && !isHexId64(nameOrId)) {
  this.ctx.storage.kv.put(DO_INSTANCE_NAME_KEY, nameOrId);
}

// Helper to check if 64-char hex (ID vs name)
function isHexId64(str: string): boolean {
  return /^[0-9a-f]{64}$/i.test(str);
}
```

### 5. ClientId via Protocol Smuggling

**Decision**: Use WebSocket protocols array to smuggle clientId (not URL params)

**Protocol Format**:
```typescript
[
  'lmz',                              // Base protocol
  `lmz.client-id.${clientId}`,        // ClientId smuggling
  'lmz-token'                         // Future: auth token (not implemented yet)
]
```

**Rationale**:
- Consistent with RPC pattern
- More secure than URL params (not logged)
- Browser WebSocket API doesn't allow setting headers
- routeDORequest adds headers before forwarding to DO
- Server extracts clientId from protocols for connection tagging

**Implementation**:
```typescript
// Client creates WebSocket
const ws = new WebSocket(url, [
  'lmz',
  `lmz.client-id.${crypto.randomUUID()}`,
  'lmz-token'  // Placeholder for future auth
]);

// Server extracts clientId from Sec-WebSocket-Protocol header
const protocols = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(p => p.trim());
const clientId = extractClientId(protocols);  // Parse 'lmz.client-id.xxx'

// Server uses clientId as tag
this.ctx.acceptWebSocket(server, [clientId]);
```

**Old vs New**:
```typescript
// OLD (lumenize-monolith) - SubscriberId in URL
const url = `wss://example.com/universe/galaxy/star?subscriberId=${uuid}`;

// NEW - ClientId in protocols
new WebSocket(url, ['lmz', `lmz.client-id.${uuid}`]);
```

### 6. Slim Message Envelope (Internal Only)

**Decision**: Minimal envelope for protocol routing, transparent to users

**Structure**:
```typescript
// Internal envelope (users never see this)
interface LumenizeEnvelope {
  type: '__lmz';     // Route to LumenizeClient handler (discriminate from __rpc, __downstream)
  payload: any;      // The actual user data (any structured-clone type)
  id?: string;       // Optional: for request/response pattern
}
```

**Rationale**:
- Slim envelope - just enough for routing
- Type `__lmz` discriminates from RPC (`__rpc`) and downstream (`__downstream`)
- Payload is opaque - transport layer doesn't interpret it
- Optional id enables request/response pattern
- **Users never see envelope** - completely encapsulated in LumenizeBase

**User Experience** (no envelope in user code):
```typescript
// Client sends plain data
await client.send({ action: 'subscribe' });

// Server receives plain data (envelope already unwrapped)
async onMessage(ws: WebSocket, message: any, id?: string) {
  // message = { action: 'subscribe' } - NO envelope!
}

// Server sends plain data
await this.send(ws, { status: 'ok' });

// Client receives plain data (envelope already unwrapped)
onDownstream(data: any) {
  // data = { status: 'ok' } - NO envelope!
}
```

**Transport Layer Encapsulation**:
- LumenizeBase wraps outgoing messages in envelope
- LumenizeBase unwraps incoming messages from envelope
- Calls structured-clone stringify/parse internally
- User code only works with plain objects

### 7. Lifecycle Hooks Pattern (Inspired by Agents)

**Decision**: Add lifecycle hooks (onConnect, onMessage, onClose) and prevent override of internal methods

**Hooks Pattern**:
```typescript
// Subclasses implement these:
async onConnect(ws: WebSocket, request: Request): Promise<void>
async onMessage(ws: WebSocket, message: any, id?: string): Promise<void>
async onClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void>
async onRequest(request: Request): Promise<Response>

// Subclasses DO NOT override these (runtime check):
async fetch(request: Request): Promise<Response>  // FINAL
async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>  // FINAL
async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void>  // FINAL
```

**Rationale**:
- Inspired by agents/PartyKit pattern (familiar to users)
- Cleaner than agents: just `request` parameter, not redundant `ctx`
- Runtime check prevents accidental override of internal methods
- Lifecycle hooks get deserialized data (envelope already unwrapped)
- Simple, clear contract

**Differences from Agents**:
- ✅ No ConnectionContext - just `request` (no `ctx.ctx` silliness)
- ✅ Message already deserialized - not `string | ArrayBuffer`
- ✅ Added `id` parameter for request/response pattern
- ✅ Added `onConnect` hook (agents has this)
- ✅ Runtime enforcement with clear error messages

**What LumenizeBase Does Automatically**:
- ✅ Store DO name on WebSocket connect
- ✅ Extract clientId from protocols and tag connection
- ✅ Parse/stringify messages (transport layer)
- ✅ Unwrap envelope and call user hooks
- ✅ Provide four helper methods (send, sendDownstream, broadcastDownstream)

**What Subclasses Do**:
- ✅ Implement lifecycle hooks
- ✅ Use helper methods to send messages
- ✅ Handle application-specific logic

### 8. Four Helper Methods (Clear API)

**Decision**: Provide four helper methods with clear, distinct purposes

**Methods**:
```typescript
// 1. Send to specific WebSocket connection
async send(ws: WebSocket, data: any, id?: string): Promise<void>

// 2. Send to client(s) by clientId (tag) - singular or array
async sendDownstream(clientId: string | string[], data: any, exclude?: string): Promise<void>

// 3. Broadcast to ALL connected clients
async broadcastDownstream(data: any, exclude?: string): Promise<void>

// 4. (Lifecycle hook) Handle HTTP requests
async onRequest(request: Request): Promise<Response>
```

**Rationale**:
- Four methods cover all use cases
- Clear semantic meaning (no overloading)
- `broadcastDownstream` (not just `broadcast`) - reserves name for future "upstream"
- Consistent with RPC patterns (return void)
- All methods encapsulate stringify (transport layer)
- Exclude parameter super useful (don't echo back to sender)

**Common Patterns**:
```typescript
// Pattern 1: Request/response
if (id) {
  await this.send(ws, result, id);
}

// Pattern 2: Notify sender, broadcast to others
await this.send(ws, { status: 'sent' });
await this.broadcastDownstream(update, senderClientId);

// Pattern 3: Send to specific users
await this.sendDownstream(['admin-1', 'admin-2'], alert);

// Pattern 4: Send to group except one
await this.sendDownstream(groupMemberIds, notification, excludeUserId);
```

### 9. Transport Layer Encapsulation

**Decision**: All stringify/parse happens in LumenizeBase internals, never in user code

**Rationale**:
- Users work with plain objects - clean, simple API
- Transport complexity completely hidden
- Consistent with "objects in, objects out" philosophy
- structured-clone handles all serialization complexity
- Less error-prone (can't forget to stringify/parse)

**Implementation**:
- LumenizeBase methods call `stringify()` before `ws.send()`
- LumenizeBase receives `string | ArrayBuffer`, calls `parse()`
- User hooks receive plain objects (any structured-clone type)
- User methods accept plain objects
- Zero serialization code in user-facing API

### 10. Comparison with RPC

**When to use LumenizeClient vs RPC**:

| Aspect | RPC | LumenizeClient |
|--------|-----|----------------|
| **Use Case** | Transparent method calls | Structured messaging, sessions |
| **Communication** | Request-response only | Bidirectional (request + events) |
| **Abstraction** | High (feels like local calls) | Low (explicit messages) |
| **State** | Stateless (per-request) | Stateful (persistent connection) |
| **Batching** | Automatic | Manual |
| **Complexity** | More complex (OCAN, proxies) | Simpler (send/receive) |
| **Best For** | APIs, method proxying | Real-time apps, notifications |

**RPC Example**:
```typescript
// Transparent method calls
const result = await client.setValue('key', 'value');
const upper = await client.getUppercaseValue('key');
```

**LumenizeClient Example**:
```typescript
// Explicit messaging
await client.send({ type: 'setValue', payload: { key, value } });
const result = await client.request({ type: 'getValue', payload: { key } });
client.onMessage = (msg) => {
  if (msg.type === 'valueChanged') {
    console.log('Server notified value changed:', msg.payload);
  }
};
```

**Use Both**:
```typescript
// RPC for API calls
using api = createRpcClient({ transport: createWebSocketTransport(...) });
await api.updateUser({ id: '123', name: 'Alice' });

// LumenizeClient for real-time events
using events = createLumenizeClient({ ... });
events.onMessage = (msg) => {
  if (msg.type === 'userUpdated') {
    updateUI(msg.payload);
  }
};
```

### 11. Authentication Strategy

**Decision**: Delegate authentication to routeDORequest hooks

**Rationale**:
- Consistent with Lumenize patterns
- Flexible (cookies, tokens, custom headers)
- Separation of concerns (auth is routing concern)
- Already proven pattern from RPC

**Example**:
```typescript
// In Worker
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await routeDORequest(request, env, {
      prefix: '/client',
      onBeforeConnect: async (request) => {
        // Validate authentication before WebSocket upgrade
        const token = request.headers.get('Authorization');
        if (!token || !await validateToken(token)) {
          return new Response('Unauthorized', { status: 401 });
        }
        
        // Optionally add user context to headers
        const userId = await getUserId(token);
        const enhanced = new Request(request);
        enhanced.headers.set('X-User-ID', userId);
        return enhanced;
      }
    }) || new Response('Not Found', { status: 404 });
  }
};
```

## Future Enhancements

These are features planned for after the initial release, blocked by dependencies or scoped out for v2:

### Per-DO Debug Logging Override

**Problem**: In production, users may need to enable debug logging for a specific problematic DO instance without:
- Redeploying the entire Worker (slow)
- Enabling debug for all instances (too noisy)

**Solution**: Allow per-DO debug configuration via storage override `_lmz:debug`

**Decisions needed**: 
- Do we cache the override status in an instance variable or do we put it in NADIS with something like `this.svc.debug.DEBUG`?
- What should the API from the client be?

**Design Decisions**:
- **Complete override** (not merge): Storage DEBUG replaces env.DEBUG entirely - clearer semantics
- **Storage key**: `_lmz:debug` (consistent with other LumenizeBase internal keys)
- **Admin-only**: Requires authentication via LumenizeClient admin API
- **Security**: Must be behind auth system (don't implement until auth is ready)
- **Private**: All admin functions must be JavaScript private "#..." methods in LumenizeBase so they can't be reached by RPC. Test to confirm.

**Benefits**:
- ✅ Runtime debugging without deployment
- ✅ Per-instance granularity (debug one problematic DO)
- ✅ Can be set/cleared via API

**Blockers**:
- 🚫 **Requires auth system** - This is an admin operation, must be secured
- 🚫 **Requires LumenizeClient admin API** - Need admin API structure first

**Priority**: Post-v1 (after auth system is implemented)

**Related**:
- See "Authentication Strategy" decision below
- See Phase 3 for LumenizeBase lifecycle hooks where admin endpoints would live

## Design Decisions - Resolved ✅

All open questions have been resolved through our design conversation:

1. ✅ **HTTP Fallback**: Not for now (YAGNI - WebSocket-only)
2. ✅ **MessageRouter**: Not for now (document patterns, stay minimal)
3. ✅ **Connection Tagging**: Use clientId as tag via `ctx.acceptWebSocket(ws, [clientId])`
4. ✅ **Browser vs Node.js**: Inject WebSocket class (consistent with RPC)
5. ✅ **Transport Location**: Move to `@lumenize/utils` (avoid new package)
6. ✅ **Package Structure**: LumenizeClient in same package as LumenizeBase
7. ✅ **URL Pattern**: Clean URLs, no prefix (DO binding name is first segment)
8. ✅ **Lifecycle Hooks**: Match agents pattern but simplified (no redundant ctx)
9. ✅ **Method Override**: Runtime check with clear error messages
10. ✅ **Helper Methods**: Four methods (send, sendDownstream, broadcastDownstream, onRequest)
11. ✅ **Respond Pattern**: No closure, use `id` parameter + helper methods
12. ✅ **Broadcast Naming**: `broadcastDownstream` (reserves `broadcast` for future upstream)
13. ✅ **Return Values**: All helpers return `void` (match RPC pattern)
14. ✅ **Transport Encapsulation**: stringify/parse only in LumenizeBase internals

## Success Criteria

### Must Have
- [ ] LumenizeClient can connect to LumenizeBase DO over WebSocket
- [ ] Client can send messages to server (any structured-clone type)
- [ ] Server can send messages to client (downstream, any structured-clone type)
- [ ] Request/response pattern works with timeout handling
- [ ] Auto-reconnect works after connection drop
- [ ] DO name stored in storage when WebSocket connects (`_lmz:doInstanceName`)
- [ ] ClientId extracted from WebSocket protocols and used as tag
- [ ] Runtime check prevents override of fetch/webSocketMessage/webSocketClose
- [ ] Four helper methods work: send(), sendDownstream(), broadcastDownstream(), onRequest()
- [ ] Lifecycle hooks work: onConnect(), onMessage(), onClose()
- [ ] Transport layer encapsulation (users never call stringify/parse)
- [ ] Unit tests with >80% branch coverage
- [ ] Integration tests covering all major scenarios
- [ ] Documentation following "Testing LumenizeBase with LumenizeClient" pattern
- [ ] TypeDoc API reference generated

### Nice to Have
- [ ] MessageRouter helper class (if users request it)
- [ ] Testing utilities in @lumenize/testing
- [ ] HTTP fallback transport (if users request it)
- [ ] Connection state debugging tools
- [ ] Performance benchmarks vs old implementation

### Won't Have (Yet)
- ❌ MCP protocol support (future: Lumenize package, not LumenizeBase)
- ❌ Entity/resource subscription (future: Lumenize package)
- ❌ Multi-room connection pooling (YAGNI)
- ❌ Binary message support (structured-clone handles everything we need)
- ❌ Upstream messaging (future enhancement)
- ❌ Auth token in protocols (placeholder 'lmz-token' for future)

## Notes

### Implementation Order

The phases are designed to build incrementally:

1. **Phase 1**: Reuse RPC transport (quick win)
2. **Phase 2**: Client package (core functionality)
3. **Phase 3**: Server hooks (complete the loop)
4. **Phase 4**: Integration tests (prove it works)
5. **Phase 5-6**: Documentation (make it usable)
6. **Phase 7**: Testing utilities (polish)

### Migration Path from Old LumenizeClient

For users of the old lumenize-monolith LumenizeClient:

**Old** (lumenize-monolith):
```typescript
import { LumenizeClient } from 'lumenize-monolith';

const client = new LumenizeClient({
  host: 'example.com',
  galaxy: 'milky-way',      // DO namespace (now doBinding)
  star: 'user-123',         // DO instance (now instance)
  route: 'mcp',             // Message route
  onEntityUpdate: (msg) => { ... }
});

await client.callMethod('initialize', { ... });
const result = await client.callTool('toolName', { ... });
```

**New** (@lumenize/lumenize-base):
```typescript
import { createLumenizeClient } from '@lumenize/lumenize-base';

using client = createLumenizeClient({
  baseUrl: 'wss://example.com',
  doBinding: 'lumenize',      // Was 'galaxy' (now lowercase!)
  instance: 'user-123',       // Was 'star'
  clientId: crypto.randomUUID(),
  onDownstream: (data) => {
    // Data is already deserialized - any structured-clone type!
    // No message type checking needed
    console.log('Received:', data);
  }
});

// Send anything structured-clone supports
await client.send({ action: 'initialize', params: { ... } });

// Request/response with timeout
const result = await client.request({ action: 'callTool', name: 'toolName' });
```

**Key Differences**:
- Galaxy/star → doBinding/instance (standard Cloudflare terminology)
- SubscriberId in URL → clientId in protocols (more secure)
- MCP protocol built-in → protocol-agnostic (MCP later in Lumenize package)
- PartySocket → Native WebSocket (no third-party dependency)
- onEntityUpdate → onDownstream (generic downstream messages)
- Complex values supported (Maps, Dates, Errors, circular refs, etc.)

### Relationship to RPC

LumenizeClient and RPC are **complementary**, not competing:

- **RPC**: Method call abstraction (like calling local functions)
- **LumenizeClient**: Explicit messaging (like WebSocket API)

Some applications will use both:
- RPC for CRUD operations
- LumenizeClient for real-time notifications

They share infrastructure (WebSocket transport, serialization) but serve different use cases.

## References

### Existing Code to Study

- `packages/rpc/src/websocket-rpc-transport.ts` - WebSocket transport pattern
- `packages/rpc/src/client.ts` - Client lifecycle, downstream messaging
- `packages/utils/src/route-do-request.ts` - DO routing, header injection
- `lumenize-monolith/src/lumenize-client.ts` - Old client (reference only)
- `lumenize-monolith/src/lumenize-server.ts` - Old server (reference only)

### Related Documentation

- [RPC Quick Start](https://lumenize.com/docs/rpc/quick-start)
- [Downstream Messaging](https://lumenize.com/docs/rpc/downstream-messaging)  
- [Request Routing](https://lumenize.com/docs/utils/route-do-request)
- [NADIS System](tasks/nadis-system.md)

---

**Next Steps**: Review and discuss this plan, then start with Phase 1 when ready.

