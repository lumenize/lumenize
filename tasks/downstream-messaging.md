# Downstream Messaging for @lumenize/rpc

**Status**: Planning
**Started**: 2025-10-30

## Goal

Add lightweight bidirectional communication to the RPC system, allowing the server (DurableObject) to send unsolicited messages to the client, while maintaining clean architectural separation between transport and application layers.

## Current Architecture Analysis

### Clean Separation Today

**Transport Layer** (`WebSocketRpcTransport`, `HttpPostRpcTransport`):
- Handles connection management
- Serializes/deserializes messages
- Manages timeouts and reconnection
- Protocol-agnostic (just sends/receives `RpcBatchRequest`/`RpcBatchResponse`)

**Application Layer** (`RpcClient`, `lumenizeRpcDO`):
- Builds OCAN (Operation Chaining And Nesting) structures
- Manages proxy creation
- Executes operation chains
- Preprocesses/postprocesses results

**Current Flow**:
```
Client.method() → OCAN builder → Transport.execute() → [wire]
→ DO.handleRpcMessage() → dispatchCall() → result → [wire]
→ Transport response → Client postprocess → Proxy
```

### Key Observations

1. **WebSocket already established**: `WebSocketRpcTransport` maintains persistent connection
2. **Message envelope system**: Uses `{ type: '__rpc', batch: [...] }` structure
3. **Message routing**: `handleRpcMessage()` checks `type` field and returns `false` for non-RPC messages
4. **Lazy connection**: WebSocket connects on first `execute()` call
5. **No persistent connection**: Connection dropped when idle (no activity keeps it alive)

## Proposed Solution

### High-Level Design

Add a **parallel messaging channel** that coexists with RPC over the same WebSocket, using the message envelope's `type` field as discriminator:

- **RPC messages**: `{ type: '__rpc', batch: [...] }` (existing)
- **Downstream messages**: `{ type: '__downstream', payload: any }` (new)

This maintains clean separation because:
- Transport still only sends/receives messages (doesn't know about downstream semantics)
- Application layer adds downstream-specific behavior
- Message routing happens at application layer (like it does for RPC today)

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                         │
├─────────────────────────────────────────────────────────────┤
│  RpcClient (with downstream capability)                      │
│  - onMessage?: (payload: any) => void                        │
│  - keepConnectionAlive: boolean (when onMessage registered)  │
│  - handleIncomingMessage(data: string): boolean              │
│    - Check if RPC response → handle via existing logic       │
│    - Check if downstream message → call onMessage            │
│    - Return false if neither                                 │
├─────────────────────────────────────────────────────────────┤
│  lumenizeRpcDO (with downstream capability)                  │
│  - sendDownstream(ws: WebSocket, payload: any): void         │
│  - Uses message envelope: { type: '__downstream', payload }  │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                     Transport Layer                          │
├─────────────────────────────────────────────────────────────┤
│  WebSocketRpcTransport                                       │
│  - execute(batch): Promise<response>  (existing)             │
│  - setMessageHandler(handler): void   (NEW)                  │
│    - Allows application layer to intercept messages          │
│  - setKeepAlive(enabled): void        (NEW)                  │
│    - Enables auto-reconnect when connection drops            │
└─────────────────────────────────────────────────────────────┘
```

### Key Changes

#### 1. Transport Layer: Minimal Additions

**`WebSocketRpcTransport`** adds two methods:

```typescript
/**
 * Register a message handler to intercept incoming messages.
 * Handler returns true if message was handled, false to use default logic.
 * This allows application layer to handle non-RPC messages.
 */
setMessageHandler(handler: (data: string) => boolean): void;

/**
 * Enable/disable auto-reconnect mode.
 * When enabled:
 * - Uses setWebSocketAutoResponse for heartbeat (ping/pong)
 * - Automatically reconnects when connection drops
 * - Can reconnect hours/days later (browser tab sleep/wake)
 * - Delivers queued downstream messages on reconnect
 * When disabled, connection uses lazy reconnect (on next RPC call).
 */
setKeepAlive(enabled: boolean): void;
```

**Why these additions maintain clean separation**:
- Transport doesn't know what the messages mean
- Transport provides generic hooks for application layer
- Application layer decides message semantics
- Similar to how `handleRpcMessage()` already checks `type` field

#### 2. Application Layer: RpcClient Changes

```typescript
interface RpcClientConfig {
  transport: RpcTransport;
  
  /**
   * Optional handler for downstream messages from server.
   * When registered:
   * - WebSocket stays connected (auto-reconnect mode)
   * - Non-RPC messages routed to this handler
   * - RPC messages handled normally
   * - clientId MUST be provided in transport config (throws at runtime if missing)
   */
  onDownstream?: (payload: any) => void;
  
  /**
   * Optional handler called when WebSocket closes.
   * Use for catchup logic, auth refresh, or custom reconnect control.
   * 
   * @param code - WebSocket close code (1000=normal, 1006=abnormal, 4xxx=custom)
   * @param reason - Human-readable close reason
   * @returns false to cancel auto-reconnect, true/undefined to continue
   * 
   * Common codes:
   * - 1000: Normal closure
   * - 1006: Abnormal closure (network issue) 
   * - 4401: Authentication expired (custom)
   * - 4403: Authorization failed (custom)
   */
  onClose?: (code: number, reason: string) => boolean | void | Promise<boolean | void>;
}

class RpcClient {
  // Existing methods...
  
  /**
   * Internal handler registered with transport.
   * Checks incoming messages:
   * 1. Is it RPC response? → existing logic
   * 2. Is it downstream object? → call onDownstream
   * 3. Neither? → return false
   */
  #handleIncomingMessage(data: string): boolean {
    try {
      const message = parse(data);
      
      // Check if RPC response (existing logic)
      if (message.type === this.#messageType && message.batch) {
        // Handle as RPC response (existing code)
        return true;
      }
      
      // Check if downstream object
      if (message.type === '__downstream' && this.#config.onDownstream) {
        this.#config.onDownstream(message.payload);
        return true;
      }
      
      return false; // Not handled
    } catch {
      return false;
    }
  }
}
```

#### 3. Application Layer: Server-Side Changes

```typescript
/**
 * Send arbitrary data downstream to one or more clients.
 * Data is preprocessed (special types → markers) then serialized.
 * 
 * @param clientIds - Single client ID or array of client IDs
 * @param doInstance - The DurableObject instance (pass `this`)
 * @param payload - Any RPC-compatible data (Errors, Web API objects, etc.)
 */
export async function sendDownstream(
  clientIds: string | string[], 
  doInstance: DurableObject,
  payload: any
): Promise<void> {
  // Normalize to array
  const ids = Array.isArray(clientIds) ? clientIds : [clientIds];
  
  // Preprocess payload once (convert special types to markers)
  // Same as RPC outgoing: Error → serialized, Web API → serialized, etc.
  const processedPayload = await preprocessResult(payload, []);
  
  const message = {
    type: '__downstream',
    payload: processedPayload
  };
  const messageString = stringify(message);
  
  // Send to all specified clients
  for (const clientId of ids) {
    const sockets = doInstance.ctx.getWebSockets(`rpc:${clientId}`);
    if (sockets.length === 0) {
      console.warn(`No WebSocket found for client: ${clientId}`);
      continue;
    }
    
    // Send to first matching socket (typically only one per client)
    sockets[0].send(messageString);
  }
}

// NO method added to LumenizedDO class to avoid name collisions
// Users import and call sendDownstream() directly
```

### Usage Examples

#### Client-Side: Register Handler with Catchup

```typescript
import { createRpcClient, createWebSocketTransport } from '@lumenize/rpc';

// Get clientId from auth token (recommended)
const userId = parseJWT(authToken).sub; // e.g., 'user-123'

// Track last seen message for catchup
let lastMessageId = localStorage.getItem(`lastMessageId:${userId}`);

const client = createRpcClient<typeof ChatRoom>({
  transport: createWebSocketTransport('CHAT_ROOM', 'room-123', {
    // Client ID REQUIRED when onDownstream provided (throws at runtime if missing)
    // Sent in X-Client-Id header, used as WebSocket tag: 'rpc:user-123'
    clientId: userId
  }),
  
  onDownstream: (payload) => {
    console.log('Received downstream object:', payload);
    // Payload already postprocessed (markers → live objects)
    // Works with Errors, Dates, Maps, Web API objects, etc.
    
    if (payload.type === 'chat') {
      lastMessageId = payload.messageId;
      localStorage.setItem(`lastMessageId:${userId}`, lastMessageId);
      addMessageToUI(payload);
    }
  },
  
  onClose: async (code, reason) => {
    console.log(`WebSocket closed: ${code} - ${reason}`);
    
    // Auth expired - refresh token and reconnect
    if (code === 4401) {
      try {
        const newToken = await refreshAuthToken();
        // Recreate client with new token (see auth example below)
        return false; // Cancel auto-reconnect on old client
      } catch {
        window.location.href = '/login';
        return false;
      }
    }
    
    // Network issue - catchup on reconnect
    if (code === 1006) {
      const missed = await client.getMessagesSince(lastMessageId);
      for (const msg of missed) {
        addMessageToUI(msg);
        lastMessageId = msg.messageId;
      }
      localStorage.setItem(`lastMessageId:${userId}`, lastMessageId);
      return true; // Continue auto-reconnect
    }
    
    return true; // Default: continue auto-reconnect
  }
});

// Connection stays alive while onDownstream is registered
await client.postMessage('Hello!'); // RPC still works normally
```

#### Server-Side: High-Level RPC Method Pattern with Catchup

```typescript
import { lumenizeRpcDO, sendDownstream } from '@lumenize/rpc';

class _ChatRoom extends DurableObject {
  // Room state managed in storage
  #getRoomParticipants(roomId: string): string[] {
    return this.ctx.storage.kv.get(`room:${roomId}:participants`) || [];
  }
  
  /**
   * RPC method called by client to post message to room.
   * Client calls: await client.postMessage('Hello!')
   */
  async postMessage(text: string, clientId: string) {
    // Store message in SQL for catchup
    const messageId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      'INSERT INTO messages (id, client_id, text, timestamp) VALUES (?, ?, ?, ?)',
      messageId, clientId, text, Date.now()
    );
    
    // Get all participants in this room
    const participantIds = this.#getRoomParticipants();
    
    // Send downstream to all participants (fire-and-forget)
    // If client disconnected, they'll catchup via getMessagesSince()
    await sendDownstream(participantIds, this, {
      type: 'chat',
      messageId,
      from: clientId,
      text,
      timestamp: Date.now()
    });
    
    return { success: true, messageId };
  }
  
  /**
   * RPC method for catchup after reconnect.
   * Client calls: await client.getMessagesSince(lastMessageId)
   */
  getMessagesSince(lastMessageId: string) {
    return this.ctx.storage.sql.exec(
      'SELECT * FROM messages WHERE id > ? ORDER BY timestamp',
      lastMessageId
    ).toArray();
  }
  
  /**
   * Send notification to single client
   */
  async notifyUser(userId: string, notification: any) {
    await sendDownstream(userId, this, {
      type: 'notification',
      ...notification
    });
  }
}

export const ChatRoom = lumenizeRpcDO(_ChatRoom);
```

## Architectural Concerns Addressed

### ✅ Separation of Concerns

**Transport Layer**: 
- Still only knows about sending/receiving messages
- `setMessageHandler()` is generic hook (like event listener)
- `setKeepAlive()` is connection management (transport concern)

**Application Layer**:
- Decides message semantics (RPC vs downstream)
- Routes messages based on `type` field
- Handles downstream message payload

**Analogy**: Similar to how HTTP server provides hooks for middleware, but middleware decides what to do with requests.

### ✅ No Protocol Mixing

- RPC and downstream use same wire protocol (message envelope)
- Different `type` discriminators keep them separate
- Already done today: `handleRpcMessage()` returns `false` for non-RPC

### ✅ Backward Compatibility

- Existing code works unchanged
- `onMessage` is optional (default: undefined)
- Without `onMessage`, behavior identical to today
- Keep-alive only enabled when `onMessage` registered

### ✅ Clean API

Client:
```typescript
// RPC (existing)
await client.doSomething();

// Downstream (new)
// Just register handler, then receive messages passively
```

Server:
```typescript
// RPC (existing - automatic via lumenizeRpcDO)
// Client calls methods, RPC handles it

// Downstream (new)
import { sendDownstream } from '@lumenize/rpc';

// Single client
await sendDownstream(clientId, this, payload);

// Multiple clients
await sendDownstream([client1, client2, client3], this, payload);
```

## Design Decisions

### 1. Client Identification: WebSocket Tags

**Problem**: Server needs to identify which WebSocket to send downstream messages to.

**Solution**: Use Cloudflare's WebSocket tags feature:
- Client sends `X-Client-Id` header in WebSocket upgrade
- Server extracts ID and tags WebSocket: `ctx.acceptWebSocket(server, ['rpc:${clientId}'])`
- Server calls `sendDownstream(clientIds, doInstance, payload)` 
- Function finds socket(s) via `ctx.getWebSockets('rpc:${clientId}')`

**Why tags over instance variables**:
- Persist through DO hibernation
- No storage operations needed
- Cloudflare's recommended pattern
- Can query all sockets with a tag

**Client ID requirement**:
- User MUST provide clientId in transport config when using `onDownstream`
- May come from auth token (JWT sub claim) or session ID. Later, it may be the return address id when we implement multi-hop.
- Throws helpful error at runtime if `onDownstream` provided but clientId missing
- No auto-generation (explicit is better than implicit for security)

### 2. Avoiding Name Collisions: Standalone Function

**Problem**: Adding `sendDownstream()` method to DO class could collide with user's methods.

**Solution**: Export `sendDownstream()` as standalone function, NOT as DO method:

```typescript
// ✅ GOOD: Standalone import
import { sendDownstream } from '@lumenize/rpc';

class MyDO extends DurableObject {
  async myMethod() {
    await sendDownstream(clientId, this.ctx, payload);
  }
}
```

```typescript
// ❌ BAD: What if user already has sendDownstream()?
class MyDO extends DurableObject {
  sendDownstream() { /* user's method */ }
}
// lumenizeRpcDO would overwrite it!
```

**Alternatives considered**:
- Symbol (like `Symbol.dispose`) - obscure, harder to discover
- Prefix with `__` - still possible collision, looks internal
- Namespace (like `this.__lumenize.sendDownstream()`) - verbose, awkward

**Decision**: Standalone function is cleanest and most explicit.

### 3. Full Type Serialization: Reuse Existing Infrastructure

**Problem**: Need to support all RPC types (Errors, Web API objects, etc.) in downstream messages.

**Solution**: Reuse existing serialization pipeline:

**Server-side (outgoing - same direction as RPC responses)**:
1. Call `preprocessResult(payload, [])` - converts special types to markers
2. Call `stringify()` from `@ungap/structured-clone/json`
3. Send over WebSocket

**Client-side (incoming)**:
1. Receive and `parse()` message
2. Call `postprocessResult(payload, [])` - converts markers back to objects
3. Pass to `onDownstream` handler

**Why this works**:
- Same direction as RPC responses (server→client)
- Already handles Errors, Web API objects, special numbers, circular refs
- Already tested and proven
- Minimizes package size

**Implementation strategy** (per Larry's guidance):
- **Attempt 1**: Extract and reuse existing `preprocessResult()` and `postprocessResult()`
- **If extraction proves too risky**: Copy the server→client code and adapt it
  - The "on the way back" code is less tricky than "on the way up"
  - Safer to copy than break existing RPC functionality
  - Document why duplication was necessary
  
**⚠️ Complexity warning**: The pre/post processing code is sophisticated:
- Multiple object crawls with cycle detection
- Handles aliases and circular references
- Took several days to get right originally
- Must be handled carefully during extraction/copying

**Code locations**:
- `preprocessResult()` - in `lumenize-rpc-do.ts` (may need to export)
- `postprocessResult()` - in `client.ts` (already exists on RpcClient)
- Both use `@ungap/structured-clone/json` for final serialization

### 4. Application-Layer Catchup Pattern (Fire-and-Forget)

**Problem**: Client may be disconnected when server sends downstream message. Reconnection could be hours/days later (browser tab sleep/wake).

**Solution**: Fire-and-forget transport + application-layer catchup logic.

**Why NOT transport-layer queuing?**
- **Abandoned clients**: Never return → infinite storage growth
- **One-size-fits-all**: Can't handle different business logic (chat vs notifications vs game state)
- **No validation**: Client can't verify queue is complete or has gaps
- **Complexity**: Adds storage, deduplication, TTL logic to transport
- **SSE precedent**: SSE's `Last-Event-ID` seems convenient but apps compensate anyway

**Why application-layer catchup is better:**
- **Flexible**: Each app decides catchup semantics
- **Client validates**: Can detect gaps, reorder, verify state
- **Business logic**: `getMessagesSince(lastId)` uses app's own storage/indexing
- **Simpler transport**: Fire-and-forget stays clean and fast
- **Better UX**: App can show "Loading missed messages..." vs silent queue
- **Works after server restart**: DO migrations, server issues handled by app logic

**Catchup pattern example** (see Phase 4 for full documentation):
```typescript
// Client tracks last seen message ID
let lastMessageId = localStorage.getItem('lastMessageId');

const client = createRpcClient({
  transport: createWebSocketTransport('CHAT', 'room-123', { clientId }),
  
  onClose: async (code, reason) => {
    // On reconnect, catchup
    if (code === 1006) { // Network issue
      const missed = await client.getMessagesSince(lastMessageId);
      for (const msg of missed) {
        renderMessage(msg);
      }
      return true; // Continue auto-reconnect
    }
  },
  
  onDownstream: (payload) => {
    lastMessageId = payload.messageId;
    localStorage.setItem('lastMessageId', lastMessageId);
    renderMessage(payload);
  }
});
```

**Server-side RPC method for catchup**:
```typescript
class _ChatRoom extends DurableObject {
  getMessagesSince(lastMessageId: string) {
    // Query messages from storage/SQL
    return this.ctx.storage.sql.exec(
      'SELECT * FROM messages WHERE id > ? ORDER BY id',
      lastMessageId
    ).toArray();
  }
}
```

## Client Identification via WebSocket Tags

### How It Works

**Client-side**:
1. User provides `clientId` in transport config (REQUIRED if using `onDownstream`)
2. Transport includes `X-Client-Id` header in WebSocket upgrade request
3. Throws helpful error if `onDownstream` provided but no `clientId`

**Server-side** (`lumenizeRpcDO`):
1. WebSocket upgrade handler extracts `X-Client-Id` from headers
2. Calls `ctx.acceptWebSocket(server, ['rpc:${clientId}'])`
3. Tag persists even after DO hibernates

**Sending downstream**:
1. Call `sendDownstream(clientIds, doInstance, payload)` 
2. Function calls `ctx.getWebSockets('rpc:${clientId}')` for each ID
3. Finds matching socket(s) and sends message to all

**Why tags?**:
- Survive DO hibernation (instance variables don't)
- No storage operations needed (fast)
- Cloudflare's recommended pattern for WebSocket identification

### Client ID Sources

Users must provide client ID when using `onDownstream`. Common sources:

```typescript
// 1. From auth token (recommended for security)
const userId = parseJWT(authToken).sub; // e.g., 'user-123'
const client = createRpcClient({
  transport: createWebSocketTransport('MY_DO', 'instance', { 
    clientId: userId 
  }),
  onDownstream: (payload) => { /* handle downstream */ }
});

// 2. From session storage
const sessionId = sessionStorage.getItem('sessionId');
const client = createRpcClient({
  transport: createWebSocketTransport('MY_DO', 'instance', { 
    clientId: sessionId
  }),
  onDownstream: (payload) => { /* handle downstream */ }
});

// 3. WITHOUT onDownstream - clientId optional
const client = createRpcClient({
  transport: createWebSocketTransport('MY_DO', 'instance')
  // No clientId needed if not using downstream messaging
});
```

### Transport Interface Updates

To support downstream messaging, the `RpcTransport` interface gets two additions:

```typescript
export interface RpcTransport {
  /**
   * Execute a batch of operation chains (existing).
   */
  execute(batch: RpcBatchRequest): Promise<RpcBatchResponse>;
  
  // Optional lifecycle methods for stateful transports (existing)
  connect?(): Promise<void>;
  disconnect?(): void;
  isConnected?(): boolean;
  
  /**
   * Register a message handler to intercept incoming messages (NEW).
   * Handler returns true if message was handled, false for default logic.
   * Optional - HTTP transport doesn't implement this.
   */
  setMessageHandler?(handler: (data: string) => boolean): void;
  
  /**
   * Enable/disable auto-reconnect mode (NEW).
   * When enabled:
   * - Uses setWebSocketAutoResponse for heartbeat
   * - Automatically reconnects on disconnect
   * - Delivers queued messages on reconnect
   * Required in interface but no-op for HTTP transport.
   */
  setKeepAlive(enabled: boolean): void;
}
```

**Why these are in the interface**:
- `setMessageHandler` - Optional (HTTP doesn't need it, only WebSocket)
- `setKeepAlive` - Required (HTTP can no-op, WebSocket implements it)
- Both are transport-layer concerns (connection management)

## Implementation Phases

### Phase 1: Transport Layer Enhancements

**Goal**: Add hooks and client ID support to `WebSocketRpcTransport` without breaking existing behavior.

**Changes**:
- [ ] Update `RpcTransport` interface in `types.ts`
  - Add `setMessageHandler?(handler): void` - optional
  - Add `setKeepAlive(enabled): void` - required
- [ ] Add `clientId` to `WebSocketRpcTransport` config
  - Optional in `createWebSocketTransport()` config
  - If provided, include in WebSocket upgrade request as `X-Client-Id` header
  - Store internally for potential future use
- [ ] Add `setMessageHandler()` method to `WebSocketRpcTransport`
  - Stores handler function
  - Calls handler in `#handleMessage()` BEFORE default logic
  - If handler returns `true`, skip default RPC handling
  - If handler returns `false`, proceed with default RPC handling
- [ ] Add `setKeepAlive()` method to `WebSocketRpcTransport`
  - Enables/disables auto-reconnect mode
  - Uses Cloudflare's `setWebSocketAutoResponse` for heartbeat:
    - Set on WebSocket in connect: `ws.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))`
    - Cloudflare handles ping/pong automatically (no manual interval needed)
    - Keeps connection alive without application-level messages
  - When enabled, stores flag for reconnect behavior
  - When disabled, clears auto-reconnect flag
- [ ] Add auto-reconnect on close when keep-alive enabled
  - Listen for WebSocket close event
  - If keep-alive enabled, automatically reconnect
  - Exponential backoff for failed reconnects (1s, 2s, 4s, 8s, max 30s)
  - Continue reconnect attempts even hours/days later (browser tab wake)
  - Reset backoff on successful connection
- [ ] Add no-op `setKeepAlive()` to `HttpPostRpcTransport`
  - Method exists but does nothing (satisfies interface)

**Testing**:
- [ ] Test client ID included in upgrade headers when provided
- [ ] Test message handler intercepts messages before RPC
- [ ] Test message handler can pass through to RPC (return false)
- [ ] Test setWebSocketAutoResponse configured correctly on connect
- [ ] Test auto-reconnect triggers on connection close
- [ ] Test exponential backoff (1s, 2s, 4s, 8s, 30s max)
- [ ] Test backoff resets on successful reconnect
- [ ] Test reconnection works after long delay (simulated tab wake)
- [ ] Test HTTP transport has no-op setKeepAlive
- [ ] Test existing RPC behavior unchanged

### Phase 2: Application Layer - Client Side

**Goal**: Add `onDownstream` and `onClose` configuration with routing logic to `RpcClient`.

**Changes**:
- [ ] Add `onDownstream` to `RpcClientConfig` interface
- [ ] Add `onClose` to `RpcClientConfig` interface
  - Signature: `(code: number, reason: string) => boolean | void | Promise<boolean | void>`
  - Returns false to cancel auto-reconnect, true/undefined to continue
- [ ] Add runtime validation in RpcClient constructor
  - If `onDownstream` provided, check transport has `clientId`
  - Throw helpful error if missing: "clientId required in transport config when using onDownstream"
- [ ] Register message handler with transport when `onDownstream` present
  - Only if transport has `setMessageHandler` (WebSocket does, HTTP doesn't)
- [ ] Implement `#handleIncomingMessage()` routing logic
  - Check for RPC response (existing logic)
  - Check for downstream object:
    - Parse message
    - Call `postprocessResult()` on payload (markers → live objects)
    - Pass processed payload to `onDownstream` handler
  - Return false if neither
- [ ] Enable keep-alive when `onDownstream` registered
  - Call `transport.setKeepAlive(true)`
- [ ] Disable keep-alive when client disposed
  - Call `transport.setKeepAlive(false)` in `Symbol.dispose`
- [ ] Wrap `onDownstream` calls in try-catch (log errors, don't propagate)
- [ ] Implement onClose handling in transport close event
  - Call `onClose(code, reason)` when WebSocket closes
  - If returns false, disable auto-reconnect
  - If returns true/undefined, continue auto-reconnect

**Testing**:
- [ ] Test runtime error when onDownstream but no clientId
- [ ] Test downstream objects routed to handler
- [ ] Test postprocessing works (Errors, Dates, Web API objects, Maps, Sets)
- [ ] Test RPC messages still handled normally
- [ ] Test keep-alive enabled when handler registered
- [ ] Test connection stays alive
- [ ] Test handler errors are caught and logged
- [ ] Test client disposal disables keep-alive
- [ ] Test HTTP transport works without setMessageHandler
- [ ] Test onClose called with correct code and reason
- [ ] Test onClose returning false cancels auto-reconnect
- [ ] Test onClose returning true continues auto-reconnect
- [ ] Test catchup pattern in onClose (simulated)

### Phase 3: Application Layer - Server Side

**Goal**: Add `sendDownstream()` fire-and-forget helper and WebSocket tag support.

**Changes**:
- [ ] Update `lumenizeRpcDO` WebSocket upgrade handler
  - Extract `X-Client-Id` from request headers
  - Use as tag when calling `ctx.acceptWebSocket(server, ['rpc:${clientId}'])`
  - If header missing, continue without tag (client not using downstream)
- [ ] Add server-side close with custom codes
  - Document custom close code range: 4401 (auth expired), 4403 (auth failed), 4429 (rate limited)
  - Example: `ws.close(4401, 'Authentication expired')` for token validation failures
- [ ] Add `sendDownstream()` standalone export function (fire-and-forget)
  - Signature: `(clientIds: string | string[], doInstance: DurableObject, payload: any)`
  - Normalize clientIds to array
  - Calls `preprocessResult()` on payload once (special types → markers)
  - Uses `stringify()` from `@ungap/structured-clone/json`
  - Loops through client IDs:
    - Find WebSocket via `doInstance.ctx.getWebSockets('rpc:${clientId}')`
    - If socket found: send immediately
    - If socket NOT found: silently skip (fire-and-forget, client will catchup)
  - Message format: `{ type: '__downstream', payload: processedPayload }`
  - Log send attempts for monitoring (success/client-not-found)
- [ ] Attempt to extract/reuse existing `preprocessResult()`
  - If extraction too risky, copy server→client code
  - Document which approach was taken and why
- [ ] NO method added to `LumenizedDO` class (avoid name collisions)
- [ ] Export `sendDownstream` from package index

**Testing**:
- [ ] Test WebSocket tags set from `X-Client-Id` header
- [ ] Test WebSocket accepted without tag when no header (backward compat)
- [ ] Test `sendDownstream()` with single client ID
- [ ] Test `sendDownstream()` with array of client IDs
- [ ] Test downstream objects reach connected client immediately
- [ ] Test silently skips when client disconnected (fire-and-forget)
- [ ] Test preprocessing works (Errors, Web API objects, Dates, Maps, etc.)
- [ ] Test multiple clients receive independently
- [ ] Test server can close with custom code (4401)
- [ ] Test errors handled gracefully

### Phase 4: Documentation and Examples

**Goal**: Document the feature with working examples focusing on catchup and auth patterns.

**Changes**:
- [ ] Update RPC introduction docs
  - Mention downstream messaging capability
  - Link to downstream guide
- [ ] Add downstream messaging guide (new mdx)
  - Overview of fire-and-forget approach
  - onClose handler for control
  - Why no transport-layer queue
- [ ] Create chat room example with catchup (doc-tested)
  - Track lastMessageId in localStorage
  - onClose handler with getMessagesSince() catchup
  - Fire-and-forget sendDownstream() in server
  - SQL storage for message history
  - Shows FIFO message ordering
- [ ] Create auth refresh example (doc-tested)
  - onClose detects 4401 code
  - Refresh token and recreate client
  - Cancel auto-reconnect on old client
  - Redirect to login on refresh failure
- [ ] Create notification example (doc-tested)
  - Simple fire-and-forget notifications
  - No catchup needed (ephemeral)
- [ ] Add API docs for new methods
  - sendDownstream() function
  - onDownstream config option
  - onClose config option
  - Custom WebSocket close codes
- [ ] Update quick-start with downstream example
  - Simple notification pattern
  - Link to full examples

### Phase 5: Migrate Existing RPC to @lumenize/structured-clone

**Goal**: Replace existing RPC pre/post processing with new @lumenize/structured-clone package.

**Prerequisites**: 
- Phase 0 (structured-clone fork) must be complete
- @lumenize/structured-clone published to npm or available via workspace
- All tests passing for new package

**Changes**:
- [ ] Update `lumenize-rpc-do.ts`
  - Replace local `preprocessResult()` with `import { preprocess } from '@lumenize/structured-clone'`
  - Replace `stringify()` from @ungap with new package's `stringify()`
  - Verify all special type handling preserved (Errors, Web API objects, etc.)
- [ ] Update `client.ts`
  - Replace local `postprocessResult()` with `import { postprocess } from '@lumenize/structured-clone'`
  - Replace `parse()` from @ungap with new package's `parse()`
  - Verify all special type restoration works (Errors, Web API objects, etc.)
- [ ] Update `websocket-rpc-transport.ts`
  - Use new package's `stringify()`/`parse()` if directly called
- [ ] Update package.json
  - Remove `@ungap/structured-clone` dependency
  - Add `@lumenize/structured-clone` dependency (version `"*"` for workspace)
- [ ] Remove old preprocessing code if fully replaced
  - Only if extraction successful and tests pass
  - Keep commented backup initially for safety

**Testing**:
- [ ] Run full RPC test suite - all existing tests must pass
- [ ] Test all special types (Errors, Dates, Maps, Sets, Web API objects)
- [ ] Test circular references and aliases
- [ ] Test OCAN (operation chaining and nesting)
- [ ] Test performance - no significant regression
- [ ] Test downstream messaging still works (uses same preprocess/postprocess)
- [ ] Coverage remains >80% branch, >90% statement

**Rollback Plan**:
- If any test fails or coverage drops, revert to old code
- Keep old implementation available in git history
- Can temporarily run both implementations side-by-side for comparison

**Success Criteria**:
- ✅ All existing RPC tests pass unchanged
- ✅ All special type handling preserved
- ✅ Performance impact <5%
- ✅ Code coverage maintained
- ✅ Package size reduced (single dependency vs duplicated code)

## Alternative Approaches Considered

### Alternative 1: Full Bidirectional RPC (from BIDIRECTIONAL_RPC_PLAN.md)

**Approach**: Both sides run RPC client and server, sharing WebSocket.

**Pros**:
- Full type-safe RPC in both directions
- Uses existing OCAN infrastructure
- Very powerful

**Cons**:
- Complex: requires extracting `createRpcHandler`, `ServerWebSocketTransport`
- Mixing client/server concerns on both sides
- Overkill for simple notifications
- More to maintain and test

**Decision**: Save this for later if needed. Current use case is simpler.

### Alternative 2: Separate WebSocket for Downstream

**Approach**: Second WebSocket connection for downstream only.

**Pros**:
- Complete separation
- No message type discrimination

**Cons**:
- Double the connections
- More resource usage
- Client has to manage two connections
- Worse DX

**Decision**: Not worth the overhead. Message envelopes already solve routing.

### Alternative 3: Make Downstream Messages Special RPC

**Approach**: Downstream messages are RPC calls to client methods.

**Pros**:
- Reuses RPC infrastructure entirely
- Type-safe

**Cons**:
- Client would need to register "methods" as DO class
- Confusing mental model (client as DO?)
- Much more complex than simple callback

**Decision**: Over-engineering. Simple callback is clearer.

## Open Questions

### Q1: Heartbeat interval and strategy

**Question**: What's the right heartbeat interval? Should it be configurable?

**Options**:
- Fixed 30s (Cloudflare WebSocket timeout is typically 100s)
- User-configurable in transport config
- Adaptive based on actual connection drops

**Recommendation**: Start with fixed 30s, make configurable if needed.

### Q2: Message size limits

**Question**: Should we limit downstream message payload size?

**Considerations**:
- Large messages could cause connection issues
- Structured-clone serialization isn't size-limited
- DoS risk if server sends huge payloads

**Recommendation**: Document best practices (keep messages small), add optional size limit in config if needed.

### Q3: Downstream message queue

**Question**: Should we queue downstream messages if connection is temporarily down?

**Options**:
- No queue: messages lost if connection down (simple)
- Client-side queue: buffer during reconnect (complex)
- Server-side queue: buffer in DO storage (very complex)

**Recommendation**: Start with no queue (messages lost). Document as "fire-and-forget". Add client-side buffering later if needed.

### Q4: Client-side message handler errors

**Question**: What happens if `onMessage` handler throws?

**Options**:
- Catch and log (silent failure)
- Catch and emit event (observable)
- Let it propagate (crashes connection handling)

**Recommendation**: Catch and log. Document that handlers should not throw.

### Q5: TypeScript typing for downstream payloads

**Question**: How do we type downstream message payloads?

**Options**:
- `any` (simple, no type safety)
- Generic on `RpcClientConfig<TDownstream>` (type-safe)
- Schema validation (runtime safety)

**Recommendation**: Start with `any`, add generic typing in Phase 2 if users want it.

## Success Criteria

### Functional
- ✅ Client can register `onMessage` handler
- ✅ Server can call `sendDownstream()` to send arbitrary data
- ✅ Messages reach handler correctly
- ✅ RPC continues to work normally alongside downstream
- ✅ Connection stays alive when handler registered
- ✅ Auto-reconnect works when connection drops
- ✅ Clean disposal (no connection leaks)

### Architectural
- ✅ Transport layer remains protocol-agnostic
- ✅ Application layer handles message semantics
- ✅ Clean separation maintained
- ✅ Backward compatible (no breaking changes)
- ✅ Simple API (1-2 methods per side)

### Quality
- ✅ All new code has >80% branch coverage
- ✅ Doc-tested examples work
- ✅ No linter errors
- ✅ Performance impact <5% for RPC operations

## Next Steps

Ready to start implementation?

1. **Phase 1**: Transport layer enhancements
   - Add hooks to `WebSocketRpcTransport`
   - Test thoroughly before moving to application layer
   
2. Ask for code review before Phase 2

Ready to proceed with Phase 1?

