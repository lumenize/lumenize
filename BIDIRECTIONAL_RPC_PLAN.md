# Bidirectional RPC over WebSocket - Implementation Plan

## Overview

Enable symmetric bidirectional communication over WebSocket where both DO and Browser can:
- Call methods on the other side
- Receive responses
- Use the same WebSocket connection for both directions

## Key Architecture Principles

### Symmetry
Both sides run BOTH:
- A client (for making calls to the other side)
- A server (for receiving calls from the other side)  
- Share the same WebSocket transport

### No Instance Variables in DOs
Critical DO pattern: **Everything needed must be fetched from storage on each request/message**

- DOs can hibernate and leave memory at any time
- Constructor is called again when DO wakes up
- Instance variables are lost during hibernation
- Use `ctx.storage.kv.*` or `ctx.storage.sql.*` for persistence
- Use WebSocket tags for client identification: `ctx.acceptWebSocket(ws, ['rpc:client-id-123'])`
- Retrieve WebSockets by tag: `ctx.getWebSockets('rpc:client-id-123')`

### WebSocket Tag Strategy
When browser connects (webSocketOpen):
- Extract/generate client ID (from auth token, query param, or generate)
- Accept WebSocket with tag: `ctx.acceptWebSocket(ws, ['rpc:${clientId}'])`
- Store client metadata in DO storage: `ctx.storage.kv.put('client:${clientId}', { ... })`

When message arrives (webSocketMessage):
- WebSocket is passed in with tags intact
- Extract client ID from tags: `ctx.getTags(ws).find(t => t.startsWith('rpc:'))?.slice(4)`
- Load client metadata from storage as needed
- No need to maintain Map of WebSocket → client data

When browser disconnects (webSocketClose):
- Clean up client metadata in storage (or mark inactive)

### Hibernating WebSocket Benefits
- WebSocket connections persist even after DO hibernates
- DO leaves memory after idle period (typically ~10 seconds)
- When new message arrives, DO wakes up, constructor runs again
- WebSocket is still connected, message is delivered
- This is why we can't rely on instance variables!

## Phase 1: Core Architecture Design

### Message Routing Strategy

**Option A: Batch ID Prefixes**
- Upstream calls: `"up-1"`, `"up-2"`, etc.
- Downstream calls: `"down-1"`, `"down-2"`, etc.
- Simple to implement and debug

**Option B: Track Originating Batch IDs** ⚠️ Storage implications
- Each side tracks which batch IDs it originated
- But where to store on DO side? (Can't use instance variables)
- Would need to store in DO storage - adds overhead

**Option C: Direction Field**
- Add `direction: 'upstream' | 'downstream'` to message envelope
- Explicit and clear
- Easier to debug/inspect messages

**Decision needed:** Which approach? Leaning toward **Option A (prefixes)** for simplicity.

### Message Flow Examples

**Browser → DO (Upstream):**
```typescript
// Browser sends
{ type: '__rpc', batch: [{ id: 'up-1', operations: [...] }] }

// DO receives, routes to RPC handler
// DO responds  
{ type: '__rpc', batch: [{ id: 'up-1', success: true, result: ... }] }
```

**DO → Browser (Downstream):**
```typescript
// DO sends
{ type: '__rpc', batch: [{ id: 'down-1', operations: [...] }] }

// Browser receives, routes to RPC handler
// Browser responds
{ type: '__rpc', batch: [{ id: 'down-1', success: true, result: ... }] }
```

### Storage Strategy for DO Side

**What needs to persist across hibernation?**
- ✅ Client metadata (user ID, permissions, connected timestamp)
- ✅ Client subscriptions (which rooms/topics/channels)
- ❌ Pending downstream calls (let them timeout/retry - simpler)
- ❌ WebSocket references (use tags instead - `ctx.getWebSockets()`)

**Storage choices:**
- KV for simple key-value (client metadata, subscriptions)
- SQL for complex queries (find all clients in a room)

**Example storage patterns:**
```typescript
// Client metadata
ctx.storage.kv.put('client:${clientId}', {
  userId: 'user-123',
  connectedAt: Date.now(),
  permissions: ['read', 'write']
});

// Room subscriptions (SQL might be better for this)
ctx.storage.kv.put('room:${roomId}:clients', ['client-1', 'client-2']);

// Or with SQL:
ctx.storage.sql.exec(
  'INSERT INTO room_clients (room_id, client_id) VALUES (?, ?)',
  roomId, clientId
);
```

## Phase 2: Extract Reusable Components

### 1. Create `rpc-handler.ts`

Extract reusable RPC handler logic from `lumenizeRpcDO`:

```typescript
export interface RpcHandler {
  handleBatchRequest(batch: RpcBatchRequest): Promise<RpcBatchResponse>;
  handleMessage(ws: WebSocket, message: string): Promise<boolean>;
  handleRequest(request: Request): Promise<Response | undefined>;
}

export function createRpcHandler<T>(
  instance: T, 
  config: RpcConfig = {}
): RpcHandler;
```

**Reuses existing functions:**
- `dispatchCall()` - validates, executes operation chains, processes results
- `executeOperationChain()` - walks operations and executes them
- `processIncomingOperations()` - deserializes arguments
- `preprocessResult()` - serializes results and replaces functions with markers
- `validateOperationChain()` - validates operation depth/args

These already take `instance: any` - no DO dependencies!

### 2. Refactor `lumenizeRpcDO`

Make it use `createRpcHandler` internally:

```typescript
export function lumenizeRpcDO<T extends new (...args: any[]) => any>(
  DOClass: T, 
  config: RpcConfig = {}
): T {
  class LumenizedDO extends (DOClass as T) {
    async fetch(request: Request): Promise<Response> {
      const handler = createRpcHandler(this, config);
      
      // WebSocket upgrade (DO-specific)
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        // ... DO-specific logic
      }
      
      // HTTP RPC with optional blockConcurrency
      const rpcResponse = config.blockConcurrency
        ? await this.ctx.blockConcurrencyWhile(() => handler.handleRequest(request))
        : await handler.handleRequest(request);
        
      return rpcResponse || super.fetch(request);
    }
    
    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
      const handler = createRpcHandler(this, config);
      
      const handleIt = () => handler.handleMessage(ws, message);
      const wasHandled = config.blockConcurrency
        ? await this.ctx.blockConcurrencyWhile(handleIt)
        : await handleIt();
        
      if (!wasHandled && super.webSocketMessage) {
        return super.webSocketMessage(ws, message);
      }
    }
  }
  
  return LumenizedDO as T;
}
```

### 3. Create `server-websocket-transport.ts`

Transport adapter for existing WebSocket connections (DO-side):

```typescript
export class ServerWebSocketTransport implements RpcTransport {
  #ws: WebSocket;
  #messageType: string;
  #pendingBatches: Map<string, PendingBatch> = new Map();
  #timeout: number;
  
  constructor(ws: WebSocket, config?: { prefix?: string; timeout?: number });
  
  // Execute downstream calls (DO → Browser)
  async execute(batch: RpcBatchRequest): Promise<RpcBatchResponse>;
  
  // Handle incoming messages - returns true if it was a response to our call
  handleIncomingMessage(data: string): boolean;
  
  isConnected(): boolean;
}
```

**Key method: `handleIncomingMessage()`**
- Checks if message is a response to a pending downstream call
- Returns `true` if handled (was a response)
- Returns `false` if not handled (must be an incoming upstream request)

## Phase 3: Usage Patterns

### DO-Side Pattern

```typescript
class ChatRoomDO extends LumenizeBase {
  async webSocketOpen(ws: WebSocket) {
    // Get/generate client ID
    const clientId = await this.#getClientId(ws);
    
    // Accept with tag
    this.ctx.acceptWebSocket(ws, [`rpc:${clientId}`]);
    
    // Store client metadata (persists across hibernation)
    this.ctx.storage.kv.put(`client:${clientId}`, {
      connectedAt: Date.now(),
      userId: this.#parseUserId(clientId),
      subscriptions: []
    });
  }
  
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;
    
    // Get client ID from tags
    const tags = this.ctx.getTags(ws);
    const clientId = tags.find(t => t.startsWith('rpc:'))?.slice(4);
    if (!clientId) return;
    
    // Create transport for this WebSocket
    const transport = new ServerWebSocketTransport(ws);
    
    // Try to handle as downstream response first
    if (transport.handleIncomingMessage(message)) {
      return; // Was a response to our call
    }
    
    // Not a response, handle as incoming upstream request
    const handler = createRpcHandler(this);
    await handler.handleMessage(ws, message);
  }
  
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    // Get client ID from tags
    const tags = this.ctx.getTags(ws);
    const clientId = tags.find(t => t.startsWith('rpc:'))?.slice(4);
    
    if (clientId) {
      // Clean up storage
      this.ctx.storage.kv.delete(`client:${clientId}`);
    }
    
    if (super.webSocketClose) {
      return super.webSocketClose(ws, code, reason, wasClean);
    }
  }
  
  // Business logic: Call specific client
  async notifyClient(clientId: string, notification: string) {
    // Get WebSocket(s) by tag (survives hibernation!)
    const sockets = this.ctx.getWebSockets(`rpc:${clientId}`);
    if (sockets.length === 0) return;
    
    const ws = sockets[0];
    const transport = new ServerWebSocketTransport(ws);
    const browserClient = createRpcClient<BrowserApi>(transport);
    
    await browserClient.showNotification(notification);
  }
  
  // Business logic: Broadcast to room
  async broadcastToRoom(roomId: string, message: ChatMessage) {
    // Get client IDs from storage (persisted across hibernation)
    const clientIds = this.ctx.storage.kv.get(`room:${roomId}:clients`) || [];
    
    for (const clientId of clientIds) {
      await this.notifyClient(clientId, `New message: ${message.text}`);
    }
  }
}
```

### Browser-Side Pattern

```typescript
// Browser API implementation
class BrowserApiImpl {
  showNotification(msg: string) { 
    toast.show(msg); 
  }
  
  async confirmAction(msg: string): Promise<boolean> { 
    return confirm(msg); 
  }
}

// Setup WebSocket
const ws = new WebSocket('wss://...');

// Create transport (browser-side uses WebSocketRpcTransport)
const wsTransport = new WebSocketRpcTransport({
  baseUrl: 'wss://...',
  prefix: '/__rpc',
  doBindingName: 'CHAT_ROOM',
  doInstanceNameOrId: 'room-123',
  timeout: 30000
});

// Upstream client (browser → DO)
const doClient = createRpcClient<DOApi>(wsTransport);

// Downstream handler (DO → browser)
const browserHandler = createRpcHandler(new BrowserApiImpl());

// Message router
ws.addEventListener('message', async (event) => {
  // Try upstream response first (response to browser's call)
  if (wsTransport.handleIncomingMessage(event.data)) {
    return; // Was handled
  }
  
  // Must be incoming call from DO
  await browserHandler.handleMessage(ws, event.data);
});

// Usage
await doClient.sendMessage({ text: 'Hello!' }); // Browser → DO
// Meanwhile DO can call: await browserClient.showNotification(...)
```

## Open Questions

### 1. Batch ID Collision Prevention
**Question:** How do we ensure browser and DO don't generate same batch IDs?

**Options:**
- Prefix: `"up-1"` (browser), `"down-1"` (DO)
- UUID: Always unique, but longer
- Counter with namespace: `"browser-1"`, `"do-1"`

**Recommendation:** Prefixes (`up-`/`down-`) - simple, debuggable, efficient

### 2. Transport Instance Management on DO
**Question:** Create `ServerWebSocketTransport` on every message, or cache somehow?

**Problem with caching:**
- Can't use instance variables (lost on hibernation)
- WeakMap doesn't survive hibernation
- Would need to store in DO storage (seems overkill)

**Recommendation:** Create fresh on each message - lightweight, no state to manage

### 3. Client ID Source
**Question:** Where does client ID come from initially?

**Options:**
- Auth token (JWT sub claim)
- Query parameter on WebSocket URL
- Generated by DO on first connect
- Sent in first message after connect

**Recommendation:** Multiple strategies, user-configurable. Default: query param or generated.

### 4. Error Propagation
**Question:** What happens if browser handler throws while processing DO's call?

**Expected behavior:**
- Error serialized and sent back to DO
- DO's Promise rejects with the error
- Same error handling as upstream calls

**Implementation:** Already handled by `dispatchCall()` error handling

### 5. Timeout Handling
**Question:** What happens if DO times out waiting but browser responds later?

**Options:**
- Discard late response (simplest)
- Log warning about late response
- Allow configurable "grace period"

**Recommendation:** Discard late response, log warning for debugging

### 6. Security & Authorization
**Question:** Should RPC handler validate permissions on incoming calls?

**Considerations:**
- Browser calling DO: Yes, validate (existing auth patterns apply)
- DO calling browser: Less critical (DO is trusted), but browser can validate
- Client ID should be tied to authenticated user

**Recommendation:** 
- Existing auth/OCAN patterns apply to upstream calls
- Downstream calls: browser can reject if needed
- Document security patterns in advanced docs

## Success Criteria

### Functional
- ✅ Browser can call DO methods (existing)
- ✅ DO can call browser methods (new)
- ✅ Both directions work over same WebSocket
- ✅ Errors propagate correctly in both directions
- ✅ Timeouts work correctly in both directions
- ✅ No instance variable anti-patterns in DO code
- ✅ WebSocket tags work correctly for client tracking
- ✅ Hibernation doesn't break functionality

### Performance
- ✅ Minimal overhead for message routing (<1ms)
- ✅ No memory leaks from pending calls
- ✅ Clean shutdown/cleanup on disconnect

### Developer Experience
- ✅ Simple API - just add downstream handler to existing code
- ✅ Type-safe on both sides
- ✅ Clear examples for common patterns (notifications, broadcasts)
- ✅ Good error messages
- ✅ Comprehensive documentation

## Next Steps

1. **Answer open questions** - Decide on batch ID strategy, client ID source, etc.
2. **Start Phase 2** - Extract `createRpcHandler()` from `lumenizeRpcDO`
3. **Implement `ServerWebSocketTransport`** - Adapter for existing WebSocket
4. **Write tests** - Bidirectional scenarios, hibernation, error cases
5. **Document patterns** - Chat room example, notification example
6. **Iterate** - Learn from real usage, refine APIs

## Implementation Notes

### Why This Works

The key insight is that **RPC is symmetric**:
- Both sides send operation chains
- Both sides execute methods and return results
- Both sides serialize/deserialize the same way
- Transport is just a message bus - direction doesn't matter

The only asymmetry:
- DO has special lifecycle (hibernation, WebSocket tags)
- Browser has different authentication model
- But RPC protocol itself is identical!

### What Makes It Clean

- **No duplication** - Same `dispatchCall()` logic for both directions
- **No special cases** - Handler doesn't care if it's in DO or browser
- **Simple routing** - Batch ID prefixes separate upstream/downstream
- **Standard patterns** - Uses existing WebSocket, storage, and auth patterns
- **Testable** - Can test with mock transports, no real WebSockets needed
