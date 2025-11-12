# LumenizeClient - Browser Contexts as First-Class Actors via Gateway Pattern

**Status**: Design
**Priority**: Ship with LumenizeBase v1 if docs finish quickly, otherwise v2

## What & Why

**LumenizeClient** makes browser contexts **first-class actors** in the Lumenize ecosystem, addressable just like Durable Objects. A lightweight **LmzGateway DO** acts as a transparent routing layer between browser contexts and DOs.

**Key Capabilities**:
- ✅ **Uniform addressing** - Browser contexts addressable via gateway DO ID
- ✅ **`ctn()`** - Create continuations with closures for context
- ✅ **`call()`** - Same API as DO-to-DO calls
- ✅ **Zero storage cost** - Gateway has no storage, only routes messages
- ✅ **Type safety** - Same OCAN type safety across all boundaries

**Universal Call Syntax** (works for DO→DO, DO→Browser, Browser→DO):
```typescript
await call(origin, targetStub, method, args, origin.ctn().handler(context));
```

**Key Insight**: Gateway injects its own ID as the "return address" (originId) when forwarding calls. Target DOs see a uniform interface - they don't know (or care) if they're talking to another DO or a browser via gateway.

## Gateway Pattern Architecture

### How It Works

```
Browser Context           LmzGateway DO              Target DO
     │                         │                         │
     │  Connect (WS)           │                         │
     ├─────────────────────────>                         │
     │                         │  this.ctx.id =          │
     │                         │  'gateway-abc123'       │
     │                         │                         │
     │  call(TARGET, method)   │                         │
     ├─────OCAN────────────────>  Inject originId:       │
     │                         │  'gateway-abc123'       │
     │                         │                         │
     │                         │  Forward via Workers    │
     │                         │  RPC────────────────────>
     │                         │                         │
     │                         │                         │  Sees originId:
     │                         │                         │  'gateway-abc123'
     │                         │                         │
     │                         │<────Result──────────────┤
     │<────Result──────────────┤                         │
     │                         │                         │
     │                         │  call(origin, callback) │
     │                         │<────OCAN────────────────┤
     │<────OCAN────────────────┤                         │
     │  Execute locally        │                         │
```

### LmzGateway Implementation

**Minimal DO** - No storage, no LumenizeBase inheritance, just routing:

```typescript
class LmzGateway implements DurableObject {
  #ws: WebSocket | null = null;
  
  constructor(private ctx: DurableObjectState, private env: Env) {}
  
  async fetch(request: Request): Promise<Response> {
    // WebSocket upgrade only
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      
      this.ctx.acceptWebSocket(server);
      this.#ws = server;
      
      return new Response(null, { status: 101, webSocket: client });
    }
    
    return new Response('Not found', { status: 404 });
  }
  
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const envelope = parse(message);
    
    if (envelope.type === '__ocan_to_do') {
      // Inject gateway's own ID as originId
      const enrichedEnvelope = {
        ...envelope,
        originBinding: 'LMZ_GATEWAY',
        originId: this.ctx.id.toString()  // Gateway IS the return address!
      };
      
      // Forward to target DO via Workers RPC
      const doBinding = this.env[enrichedEnvelope.targetBinding];
      const target = this.#resolveDOStub(
        doBinding,
        enrichedEnvelope.doInstanceNameOrId
      );
      
      await target[enrichedEnvelope.method](...enrichedEnvelope.args);
    }
  }
  
  // Helper: Resolve DO stub from name or ID
  #resolveDOStub(binding: DurableObjectNamespace, nameOrId: string) {
    // 64-byte hex = ID, otherwise name
    if (/^[0-9a-f]{64}$/i.test(nameOrId)) {
      return binding.get(binding.idFromString(nameOrId));
    } else {
      return binding.get(binding.idFromName(nameOrId));
    }
  }
  
  // Called by other DOs (thinks it's calling another DO!)
  async receiveCall(method: string, args: any[], continuation?: OperationChain) {
    if (!this.#ws) {
      throw new Error('Browser not connected');
    }
    
    // Forward to browser
    this.#ws.send(stringify({
      type: '__execute_chain',
      method,
      args,
      continuation
    }));
  }
}
```

### Key Design Properties

1. **Gateway injects its own ID** - Browser never needs to know/send gateway ID
2. **Zero storage operations** - Gateway only routes messages, no persistence
3. **Implements receiver interface** - Target DOs call it like any other DO
4. **Single WebSocket per gateway** - One gateway = one browser context
5. **Reconnect creates new gateway** - Fresh ID, fresh connection, state sync on reconnect
6. **Naming convention**: `doInstanceNameOrId` - Explicit about two addressing modes:
   - **64-byte hex string** = ID → use `idFromString()` then `get()`
   - **Any other string** = name → use `idFromName()` then `get()`

## Real-World Example: Chat Room with Browser Subscribers

```typescript
// ===== BROWSER (Tab running LumenizeClient) =====
const client = new LumenizeClient();

// Connect to server - gets assigned a gateway DO
await client.connect('wss://example.com/gateway');

// Subscribe to chat room (browser doesn't know about gateway)
await client.call(
  'CHAT_ROOM',           // doBinding (UPPERCASE)
  'room-123',            // doInstanceNameOrId (name, not ID)
  'subscribe',
  [userId],
  client.ctn().onMessage()  // Handler for incoming messages
);

// Handler executes locally when DO sends messages
onMessage(message: ChatMessage) {
  // Update UI with new message
  appendToChat(message.text, message.from);
}

// Send a message
await client.call(
  'CHAT_ROOM',
  'room-123',            // Named instance
  'sendMessage',
  ['Hello everyone!']
  // No continuation - fire and forget
);

// ===== GATEWAY (Transparent routing layer) =====
class LmzGateway implements DurableObject {
  // Receives call from browser, injects originId, forwards to ChatRoom
  // Receives call from ChatRoom, forwards to browser
  // Zero storage, zero cost when idle
}

// ===== DURABLE OBJECT (Business logic) =====
class ChatRoom extends LumenizeBase<Env> {
  #subscribers = new Map<string, string>();  // userId -> gatewayId
  
  async subscribe(userId: string, gatewayId: string) {
    // Store gateway ID (extracted from originId by call infrastructure)
    this.#subscribers.set(userId, gatewayId);
    
    // Send recent messages
    const recent = this.ctx.storage.sql.exec`
      SELECT * FROM messages ORDER BY timestamp DESC LIMIT 50
    `.toArray();
    
    return { subscribed: true, recentMessages: recent };
  }
  
  async sendMessage(text: string, fromUserId: string) {
    // Store message
    this.ctx.storage.sql.exec`
      INSERT INTO messages (text, from_user, timestamp)
      VALUES (${text}, ${fromUserId}, ${Date.now()})
    `;
    
    // Broadcast to all subscribers
    for (const [userId, gatewayId] of this.#subscribers) {
      if (userId === fromUserId) continue;  // Skip sender
      
      const gateway = this.env.LMZ_GATEWAY.get(
        this.env.LMZ_GATEWAY.idFromString(gatewayId)
      );
      
      // Call looks like DO-to-DO call!
      await call(
        this,
        gateway,
        'onMessage',
        [{ text, from: fromUserId, timestamp: Date.now() }],
        this.ctn().onDelivered(userId)  // Optional: track delivery
      );
    }
    
    return { sent: true };
  }
  
  onDelivered(result: any, userId: string) {
    // Message delivered to browser
    console.log(`Message delivered to ${userId}`);
  }
}
```

## Reconnection and State Sync

Instead of queueing offline messages, use **state synchronization** on reconnect:

```typescript
// Browser reconnects (new gateway ID each time)
const client = new LumenizeClient();
await client.connect('wss://example.com/gateway');

// Tell each DO what version we have
await client.call(
  'CHAT_ROOM',           // doBinding
  'room-123',            // doInstanceNameOrId (name)
  'syncState',
  [{ lastMessageId: 'msg-42', version: 'v15' }],
  client.ctn().onStateSynced()
);

// In ChatRoom DO
async syncState(clientState: { lastMessageId: string, version: string }) {
  const currentVersion = this.ctx.storage.kv.get('__lmz_state_version');
  
  if (clientState.version === currentVersion) {
    return { upToDate: true };
  }
  
  // Compute delta (messages since lastMessageId)
  const newMessages = this.ctx.storage.sql.exec`
    SELECT * FROM messages 
    WHERE id > ${clientState.lastMessageId}
    ORDER BY timestamp ASC
  `.toArray();
  
  return {
    version: currentVersion,
    delta: newMessages
  };
}

// Browser applies delta
onStateSynced(result: SyncResult) {
  if (result.upToDate) return;
  
  // Apply delta to local state
  for (const msg of result.delta) {
    appendToChat(msg.text, msg.from);
  }
}
```

## What This Enables

1. **Uniform addressing** - Browsers addressable just like DOs, via gateway DO ID
2. **Zero cost gateways** - Million idle connections = zero cost (no storage operations)
3. **Application-level state management** - DOs decide what "version" and "delta" mean
4. **Transparent routing** - Target DOs don't know if calling gateway or DO
5. **Simple reconnection** - New gateway each time, state sync on connect
6. **Type safety across boundaries** - OCAN ensures type safety for all calls
7. **~10ms latency overhead** - Acceptable for the elegance and uniformity

## Reuse Strategy

**Already Built** (from RPC + recent work):
- ✅ WebSocket transport (lazy connect, auto-reconnect, downstream messaging)
- ✅ Message serialization (structured-clone)
- ✅ OCAN infrastructure (ctn(), executeOperationChain)
- ✅ Generic queue infrastructure in LumenizeBase
- ✅ routeDORequest (header injection, auth hooks)

**What's New**:
- Lifecycle hooks in LumenizeBase (onConnect, onMessage, onClose, onRequest)
- Helper methods (send, sendDownstream, broadcastDownstream)
- Message envelope for routing (separate from RPC)
- Client factory (createLumenizeClient)

## Architecture

### Message Flow

```
Client                    Worker                   Durable Object
  │                         │                            │
  │  WebSocket Upgrade      │                            │
  ├────protocols: [         │                            │
  │    'lumenize.client',   │                            │
  │    'lumenize.client.    │                            │
  │      clientId.xxx'      │                            │
  │  ]──────────────────────>  routeDORequest()          │
  │                         │  adds headers ─────────────>
  │                         │                            │
  │<───────────────────────────────WebSocket Accepted────┤
  │                         │                            │
  │                         │              LumenizeBase: │
  │  { action: 'sub' }      │              - Parse envelope
  ├─────────────────────────┼────────────────────────────> onMessage(ws, data, id)
  │                         │                            │
  │<─────────────────────────────────{ status: 'ok' }────┤ send(ws, data)
```

### Message Envelope (Internal Only)

**Transport layer** handles envelope wrapping/unwrapping - **users never see it**:

```typescript
// Internal envelope (LumenizeBase internals)
interface LumenizeEnvelope {
  type: '__lmz';        // Route to LumenizeClient (not __rpc or __downstream)
  payload: any;         // User data (any structured-clone type)
  id?: string;          // Optional: request/response correlation
}

// User code works with plain objects:
await client.send({ action: 'subscribe' });          // Client side
async onMessage(ws, message, id) {                   // Server side
  // message = { action: 'subscribe' } - no envelope!
}
```

## API Design

### Client API

```typescript
import { createLumenizeClient } from '@lumenize/lumenize-base';

// Factory pattern (recommended)
using client = createLumenizeClient({
  baseUrl: 'wss://lumenize.com',
  doBinding: 'my-do',              // Lowercase! Becomes /my-do in URL
  instance: 'user-123',
  
  // Optional
  clientId: crypto.randomUUID(),   // Auto-generated if omitted
  onDownstream: (data) => {        // Server-initiated messages
    console.log('Received:', data); // Already deserialized!
  }
});

// Send anything structured-clone supports
await client.send({ action: 'subscribe' });
await client.send(new Map([['key', 'value']]));

// Request/response with timeout
const response = await client.request({ action: 'getState' });

// Cleanup automatic with 'using'
```

### Server API (LumenizeBase Enhancements)

```typescript
import { LumenizeBase } from '@lumenize/lumenize-base';

class ChatRoom extends LumenizeBase<Env> {
  // Override lifecycle hooks (DO NOT override fetch/webSocketMessage/webSocketClose)
  
  async onConnect(ws: WebSocket, request: Request) {
    const clientId = this.ctx.getTags(ws)[0];
    await this.send(ws, { message: 'Welcome!' });
    await this.broadcastDownstream({ type: 'userJoined', clientId }, clientId);
  }
  
  async onMessage(ws: WebSocket, message: any, id?: string) {
    // message already deserialized - any structured-clone type
    const clientId = this.ctx.getTags(ws)[0];
    
    if (message.action === 'chat') {
      // Respond to sender
      if (id) await this.send(ws, { status: 'sent' }, id);
      
      // Broadcast to others
      await this.broadcastDownstream(
        { type: 'newMessage', text: message.text, from: clientId },
        clientId  // Exclude sender
      );
    }
  }
  
  async onClose(ws: WebSocket, code: number, reason: string) {
    const clientId = this.ctx.getTags(ws)[0];
    await this.broadcastDownstream({ type: 'userLeft', clientId });
  }
  
  async onRequest(request: Request): Promise<Response> {
    // Handle HTTP requests (non-WebSocket)
    return Response.json({ status: 'ok' });
  }
}
```

**Four Helper Methods** (provided by LumenizeBase):
```typescript
await this.send(ws, data, id?)              // To specific WebSocket
await this.sendDownstream(clientId, data)   // To client(s) by tag
await this.broadcastDownstream(data, exclude?) // To all clients
await this.onRequest(request)               // HTTP handler hook
```

## Key Design Decisions

### 1. Storage Key Convention: `__lmz_` Prefix

All LumenizeBase internal keys use `__lmz_` prefix (two underscores):
- `__lmz_doInstanceName` - DO name (not ID, since `ctx.id` always available)
- `__lmz_debug` - Per-DO debug override (future)
- `__lmz_call_pending:*` - Call continuation storage
- `__lmz_proxyfetch_pending:*` - Proxy-fetch continuation storage

**Rationale**: Double underscore signals "internal, do not touch." Consistent with our generic queue keys.

### 2. Protocol Convention: clientId Smuggling

WebSocket protocols array smuggles clientId (browser can't set headers):
```typescript
['lumenize.client', `lumenize.client.clientId.${crypto.randomUUID()}`]
```

Server extracts clientId from protocols, uses as tag:
```typescript
this.ctx.acceptWebSocket(server, [clientId]);
```

**Rationale**: Consistent with RPC pattern, more secure than URL params.

### 3. Lifecycle Hooks Pattern

**Users implement these** (similar to Cloudflare Agents but cleaner):
```typescript
async onConnect(ws: WebSocket, request: Request)
async onMessage(ws: WebSocket, message: any, id?: string)
async onClose(ws: WebSocket, code: number, reason: string, wasClean: boolean)
async onRequest(request: Request): Promise<Response>
```

**Users DO NOT override these** (LumenizeBase implements them):
```typescript
async fetch(request: Request)  // Routes to onRequest or WebSocket upgrade
async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer)  // Parses envelope, calls onMessage
async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean)  // Calls onClose
```

**Message Flow in webSocketMessage**:
1. Check for system messages (`__rpc`, `__downstream`, `__lmz_result`)
2. If system message, handle via existing infrastructure
3. Parse LumenizeClient envelope (`__lmz` type)
4. Deserialize payload (structured-clone)
5. Call `onMessage(ws, payload, id)` with plain data

**Rationale**: 
- Clear separation: LumenizeBase handles transport, users handle logic
- Runtime check prevents accidental override (throw helpful error)
- Consistent with continuation infrastructure already in place
- Agents-inspired but cleaner (no redundant `ctx` parameter)

### 4. Transport Layer Encapsulation

**Critical**: Users work with plain objects - **never** call stringify/parse.

```typescript
// ✅ User code (clean)
await this.send(ws, { status: 'ok' });
await client.send({ action: 'subscribe' });

// ❌ NEVER in user code
await ws.send(stringify({ ... }));  // LumenizeBase does this internally
```

**Rationale**: Consistent with "objects in, objects out" philosophy. Less error-prone.

### 5. Same Package for Client and Server

LumenizeClient lives in `@lumenize/lumenize-base`, not separate package.

**Rationale**:
- Tightly coupled (two sides of same connection)
- Shared types and constants
- Simpler dependency management
- Clear that they work together

**Package Structure**:
```
packages/lumenize-base/
  src/
    lumenize-base.ts       # Server side
    lumenize-client.ts     # Client side (NEW)
    constants.ts           # Shared (storage keys, protocols)
    types.ts               # Shared
    index.ts               # Exports both
```

### 6. Comparison with RPC and Call

| Aspect | RPC | Call | LumenizeClient |
|--------|-----|------|----------------|
| **Use Case** | Transparent method calls | Actor-to-actor messaging | Browser contexts as actors |
| **Communication** | Request-response | Bidirectional with continuations | All of the above |
| **Abstraction** | High (feels local) | Medium (explicit call) | Medium (explicit call) |
| **State** | Stateless | Stateful (queued in storage) | Stateful (context-appropriate storage) |
| **Transports** | Workers RPC | Workers RPC + WebSocket | MessagePort + BroadcastChannel + WebSocket |
| **Best For** | DO-to-DO APIs | DO-to-DO with context | Browser context-to-context + DO communication |

**All three work together**:
- **RPC** for transparent DO-to-DO method calls
- **Call** for DO-to-DO with continuations carrying context
- **LumenizeClient** for browser contexts calling each other and DOs

### 7. Default alarm() Implementation

LumenizeBase provides default `alarm()` that auto-delegates to `@lumenize/alarms`:

```typescript
// In LumenizeBase
async alarm() {
  // Auto-delegate to alarms if present
  if ('svc' in this && this.svc && 'alarms' in this.svc) {
    await (this.svc as any).alarms.alarm();
  }
  // Silent no-op if @lumenize/alarms not imported
}
```

**Rationale**: Zero boilerplate for alarms users. Override only if custom behavior needed.

## What Needs Doing

### High-Level Tasks

1. **LmzGateway DO** (~0.5 day)
   - Minimal DO implementation (no storage, no LumenizeBase)
   - WebSocket upgrade and connection management
   - Inject originId when forwarding browser→DO calls
   - Implement receiver interface for DO→browser calls
   - Error handling for disconnected browsers

2. **LumenizeClient Class** (~1.5 days)
   - WebSocket connection to gateway
   - `ctn()` factory for creating continuations
   - `call()` method to invoke DO methods
   - Execute incoming OCAN chains locally
   - Serialize/deserialize with structured-clone

3. **Worker Integration** (~0.5 day)
   - Gateway creation endpoint (generates new gateway ID)
   - Route requests to gateway DOs
   - Example: `routeDORequest()` pattern for gateway

4. **Call Infrastructure Integration** (~0.5 day)
   - Ensure `@lumenize/call` works with gateway stubs
   - Extract gatewayId from originId in call envelope
   - Type safety for browser→DO and DO→browser calls

5. **Integration Testing** (~1 day)
   - Test browser→DO call with result
   - Test DO→browser callback via gateway
   - Test reconnection (new gateway ID each time)
   - Test state sync pattern
   - Test multiple browsers (different gateways)
   - Test error handling (disconnected browser)

6. **Documentation** (~1.5 days)
   - Gateway pattern explanation
   - Chat room example (browser subscribers)
   - State sync pattern documentation
   - API reference (LumenizeClient + LmzGateway)
   - Comparison with direct WebSocket (RPC pattern)
   - Migration guide from lumenize-monolith

**Total Estimate**: ~5.5 days (much simpler than actor model with multiple transports)

## Verification Checklist

**Must Have for v1**:

**LmzGateway DO**:
- [ ] Minimal DO (no storage, no LumenizeBase inheritance)
- [ ] WebSocket upgrade and connection management
- [ ] Inject originId when forwarding browser→DO calls
- [ ] Implement receiver interface for DO→browser callbacks
- [ ] Error handling for disconnected browsers
- [ ] Gateway ID generation via `env.LMZ_GATEWAY.newUniqueId()`
- [ ] Single WebSocket per gateway instance

**LumenizeClient**:
- [ ] WebSocket connection to gateway
- [ ] `ctn()` factory for creating continuations
- [ ] `call()` method to invoke DO methods (via gateway)
- [ ] Execute incoming OCAN chains locally
- [ ] Serialize/deserialize with structured-clone
- [ ] Handler methods execute with first parameter convention
- [ ] Type safety for DO method calls

**Call Infrastructure Integration**:
- [ ] `@lumenize/call` works with gateway stubs
- [ ] GatewayId extracted from originId in call envelope
- [ ] Target DOs can call gateway like any other DO
- [ ] Type safety across browser→DO and DO→browser boundaries

**Worker Integration**:
- [ ] Gateway creation endpoint (generates unique ID)
- [ ] Route gateway requests via `routeDORequest()` pattern
- [ ] Example worker implementation in docs

**Testing**:
- [ ] Browser→DO call with result
- [ ] DO→browser callback via gateway
- [ ] Reconnection (new gateway ID each time)
- [ ] State sync pattern works
- [ ] Multiple browsers with different gateways
- [ ] Error handling for disconnected browser
- [ ] Chat room example (broadcast to subscribers)
- [ ] Integration tests pass

**Documentation**:
- [ ] Gateway pattern explanation
- [ ] Why gateway model (uniform addressing, zero cost)
- [ ] Chat room example with browser subscribers
- [ ] State sync pattern (reconnection without queuing)
- [ ] API reference (LumenizeClient + LmzGateway)
- [ ] Comparison with RPC and Call
- [ ] Migration guide from lumenize-monolith
- [ ] Performance characteristics (~10ms overhead)

**Nice to Have**:
- [ ] Reconnection retry logic in LumenizeClient
- [ ] Heartbeat/ping-pong for connection health
- [ ] Testing utilities in @lumenize/testing
- [ ] Example state sync implementations (CRDT, event sourcing)

**Won't Have Yet**:
- ❌ MessagePort/BroadcastChannel transports (browser-to-browser direct)
- ❌ MCP protocol (future: separate package)
- ❌ HTTP fallback transport (YAGNI)
- ❌ Offline message queuing (use state sync instead)
- ❌ Gateway cleanup/TTL (let Cloudflare evict idle gateways)

## Migration from lumenize-monolith

**Old** (lumenize-monolith):
```typescript
const client = new LumenizeClient({
  host: 'example.com',
  galaxy: 'milky-way',       // DO namespace
  star: 'user-123',          // DO instance
  subscriberId: uuid,        // In URL
  onEntityUpdate: (msg) => { ... }
});
```

**New** (@lumenize/lumenize-base):
```typescript
using client = createLumenizeClient({
  baseUrl: 'wss://example.com',
  doBinding: 'lumenize',     // Lowercase!
  instance: 'user-123',
  clientId: crypto.randomUUID(),  // In protocols (not URL)
  onDownstream: (data) => { ... }  // Generic downstream
});
```

**Key Differences**:
- Galaxy/star → doBinding/instance (standard Cloudflare terminology)
- SubscriberId in URL → clientId in protocols (more secure)
- MCP removed (protocol-agnostic)
- PartySocket → Native WebSocket
- Structured-clone support (Maps, Dates, Errors, circular refs)

---

## Decision Point

**Ship with LumenizeBase v1 or v2?**

**Scope expanded** from simple WebSocket messaging to **full actor model** (browser contexts as first-class actors):
- Original estimate: ~3.5 days (WebSocket only)
- New estimate: ~7 days (actor model with all transports)

**Options**:
1. **Ship v1 with full actor model** (~7 days) - Complete vision, browser contexts as actors
2. **Ship v1 with WebSocket only** (~3.5 days) - Defer MessagePort/BroadcastChannel to v2
3. **Ship v1 without LumenizeClient** - Focus on LumenizeBase (ctn() + continuations + generic queue)

**Recommendation**: Option 2 (WebSocket only for v1) strikes best balance:
- Enables browser ↔ DO communication (highest value)
- Proves out generic queue infrastructure
- Validates `ctn()` works in browser contexts
- Leaves door open for MessagePort/BroadcastChannel in v2

**Alternative**: Option 3 if documentation for existing packages (alarms, call, proxy-fetch) takes longer than expected.

