# Chat Example Doc-Test - Design & Plan

**Status**: Planning  
**Location**: `doc-test/rpc/chat-example/`  
**Purpose**: Comprehensive showcase of Lumenize RPC features through a real chat application

## Overview

This doc-test creates a working chat room application that demonstrates all key Lumenize RPC features:
- Full RPC capabilities (Operation Chaining and Nesting, type support, storage access)
- Downstream messaging (server-to-client push)
- Two-DO architecture (User → Room via Workers RPC)
- Authentication with token validation
- Permission-based access control
- Application-layer catchup pattern
- Connection lifecycle management
- Hiding DO internals (private members not accessible via RPC)

Unlike the Cap'n Web comparison docs, this is a **single implementation** focused on showcasing Lumenize RPC's capabilities in a realistic scenario.

## Architecture

**Two Durable Object Classes:**

1. **User DO** (per-user instance: `user-alice`, `user-bob`)
   - Client connects via Lumenize RPC with token as clientId
   - Acts as facade/gateway to Room DO
   - Receives downstream messages from Room, forwards to client
   - Stores user settings as `Map<string, any>` (name, theme, etc.)
   - Hides `#env` to prevent direct DO hopping via RPC

2. **Room DO** (shared instance: `room-general`)
   - Accessed by User DOs via Workers RPC
   - Manages participants, messages, permissions
   - Sends messages back to User DOs via Workers RPC stubs
   - Hides `#ctx` and `#env` by assigning to private members after `super()`
   - Only public methods accessible (demonstrates RPC boundary)

**Message Flow:**
```
Client --Lumenize RPC--> User DO --Workers RPC--> Room DO
Client <--sendDownstream-- User DO <--Workers RPC stub-- Room DO
```

**Simplifications:**
- `clientId` = `userId` = User DO's `doInstanceNameOrId` (e.g., `user-alice`)
- Room DO is always `room-general` (hard-coded)
- Permissions stored in Room, checked on every operation

## Project Structure

```
doc-test/rpc/chat-example/
├── src/
│   └── index.ts          # Worker + ChatRoom DO implementation
├── test/
│   ├── chat.test.ts      # Main doc-test file (literate programming)
│   ├── test-harness.ts   # Standard test setup
│   └── wrangler.jsonc    # Test configuration
├── package.json
├── tsconfig.json
└── vitest.config.js
```

## Features to Demonstrate

### 1. Authentication Flow
- **Login endpoint** (`/login`) - generates session token (becomes userId)
- **Token smuggling** via WebSocket protocols: `['lumenize.rpc', 'lumenize.rpc.token.${token}']`
- **`routeDORequest` with `onBeforeConnect`** - validates token, adds user info to headers
- **Initial auth failure** - return **401 Response** (connection never established)
- **Auth success** - allow connection to User DO to proceed
- **Later token expiration** - simulated via `await userClient.simulateTokenExpiration()`
  - Next RPC operation triggers **4401 Close** with reason "Token expired"
  - Demonstrates `onClose` handler receiving custom code

### 2. User DO Operations (Client's Primary Interface)

Client calls these on User DO, which internally calls Room DO via Workers RPC:

#### Room Interaction (Permission-Checked Facade)
- `joinRoom()` - User DO → Room.addParticipant(), checks permissions on every operation
- `postMessage(text: string)` - User DO → Room.postMessage(), Room calls back via Workers RPC stub
- `updateMessage(messageId: number, newText: string)` - Edit message (if allowed)
- `getMessages(fromId?: number)` - Get messages for catchup
- `leaveRoom()` - Leave the room gracefully

#### User Settings (Direct Access)
- `updateSettings(settings: Map<string, any>)` - Update user settings (name, theme, etc.)
- `getSettings()` - Get user settings Map
- Direct storage via RPC: `await client.ctx.storage.kv.get('userSettings')`

#### Downstream Handler (Internal, called by Room)
- `receiveDownstream(payload: any)` - Public method Room calls via Workers RPC stub
  - Forwards to client via `sendDownstream()`

### 3. Room DO Operations (Internal, accessed by User DO)

User DO calls these via Workers RPC (e.g., `this.#env.ROOM.getByName('general')`):

- `addParticipant(userId: string, username: string)` - Add user, returns room info
- `removeParticipant(userId: string)` - Remove user
- `postMessage(userId: string, text: string)` - Post message, calls back to User DOs
- `updateMessage(userId: string, messageId: number, newText: string)` - Edit message
- `getMessages(fromId?: number)` - Get messages
- `getUserPermissions(userId: string)` - Get permissions for permission checks

**Hidden from RPC:** Room's `#ctx` and `#env` are private, cannot be accessed externally

### 4. Downstream Messaging Flow

**Flow:** Room → User DO (via Workers RPC) → Client (via Lumenize RPC downstream)

1. **Room generates event** (e.g., new message posted)
2. **Room calls User DO's public method** via Workers RPC stub:
   ```typescript
   const userStub = this.#env.USER.getByName(userId);
   await userStub.receiveDownstream({ type: 'message', message });
   ```
3. **User DO forwards to client** via `sendDownstream`:
   ```typescript
   async receiveDownstream(payload: any): Promise<void> {
     await sendDownstream(this.#clientId, this, payload);
   }
   ```
4. **Client receives** via `onDownstream` handler

**Message Types:**
- `{ type: 'message', message: { id, userId, username, text, timestamp } }` - New message
- `{ type: 'message_updated', messageId, newText }` - Message edited
- `{ type: 'user_joined', userId, username }` - User joined
- `{ type: 'user_left', userId, username }` - User left

### 5. Application-Layer Catchup Pattern

When client reconnects:
1. `onClose` handler detects disconnection
2. Application stores last seen message ID
3. On reconnect, calls `getMessages(lastSeenMessageId)` to fetch missed messages
4. Merges new messages into local state

### 6. Authentication Expiration Simulation

Demonstrate `onClose` handler with custom close code:
1. Call `await aliceClient.simulateTokenExpiration()` (test helper, not real API)
2. Next RPC operation triggers WebSocket close with code **4401** and reason "Token expired"
3. Client's `onClose` handler receives code and reason
4. Application can decide to:
   - Refresh token and create new client
   - Show login UI
   - Or in our test, just verify the code/reason

### 7. Type Support Showcase

Messages and payloads include:
- **Dates** - `message.timestamp: Date`
- **Maps** - User settings as `Map<string, any>` (name, theme, notifications)
- **Complex objects** - nested data structures in messages
- **Errors** - proper Error serialization when operations fail

### 8. Multiple Connections (Alice & Bob)

Two separate User DOs and clients:
- **Alice** (`user-alice`) - joins room, posts messages, sees downstream updates
- **Bob** (`user-bob`) - joins later, sees Alice's messages via catchup, posts replies

Both connected to same Room DO (`room-general`), demonstrating multi-user collaboration.

### 9. Demonstrating RPC Boundaries

Show what works and what doesn't:
- ✅ **Works**: `await aliceClient.updateSettings(new Map([['name', 'Alice']]))`
- ✅ **Works**: `await aliceClient.ctx.storage.kv.get('userSettings')` (public member)
- ❌ **Fails**: `await aliceClient.#env.ROOM.getByName('general')` (private member)
- ❌ **Fails**: Trying to access Room's `#ctx` or `#env` from User DO's Workers RPC call

## Test Flow (Narrative Structure)

The doc-test will follow this narrative:

### Setup Section
```typescript
// Imports
// Version assertions
// Helper functions for creating clients
```

### Part 1: Authentication
```typescript
it('demonstrates authentication with token validation', async () => {
  // 1. Attempt connection without token - should fail with 401 Response
  // 2. Generate token via /login endpoint (token = 'user-alice')
  // 3. Create client to User DO with valid token - should succeed
});
```

### Part 2: Basic User Operations (Alice)
```typescript
it('demonstrates user settings and storage access', async () => {
  // Alice logs in, gets token (user-alice)
  // Alice creates RPC client to User DO with token in protocols
  // Alice updates settings: await aliceClient.updateSettings(new Map([['name', 'Alice']]))
  // Alice accesses storage: await aliceClient.ctx.storage.kv.get('userSettings')
  // Verify settings are a Map (type support)
});
```

### Part 3: Joining Room (Two-DO Architecture)
```typescript
it('demonstrates User → Room DO interaction', async () => {
  // Alice joins room: await aliceClient.joinRoom()
  // Behind scenes: User DO → Room DO via Workers RPC
  // Room adds Alice as participant, stores permissions
  // Alice gets welcome message with room info
});
```

### Part 4: Downstream Messaging (Alice & Bob)
```typescript
it('demonstrates downstream messaging with multiple users', async () => {
  // Bob connects to his User DO (user-bob)
  // Bob joins room: await bobClient.joinRoom()
  // Alice posts: await aliceClient.postMessage('Hello!')
  //   → Alice's User DO → Room DO → Room calls back via Workers RPC
  //   → Room → Alice's User DO → sendDownstream → Alice's client
  //   → Room → Bob's User DO → sendDownstream → Bob's client
  // Bob receives via downstream, verifies timestamp is Date
  // Bob replies: await bobClient.postMessage('Hi Alice!')
  // Both clients see all messages via downstream
});
```

### Part 5: Permission-Based Access
```typescript
it('demonstrates permission checks on every operation', async () => {
  // Alice posts message successfully (has permission)
  // Bob tries to update Alice's message (no permission)
  // Room checks permissions, denies Bob's request
  // Error propagates back through User DO to client
});
```

### Part 6: Message Updates with Downstream
```typescript
it('demonstrates message updates with downstream notifications', async () => {
  // Alice posts message
  // Alice edits: await aliceClient.updateMessage(messageId, 'Updated!')
  // Room broadcasts 'message_updated' via User DOs
  // Both clients receive downstream event
});
```

### Part 7: Catchup Pattern
```typescript
it('demonstrates application-layer catchup after disconnect', async () => {
  // Alice posts several messages
  // Bob disconnects (onClose fires with code 1000)
  // Alice posts more messages while Bob is offline
  // Bob reconnects to User DO (auto-reconnect)
  // Bob calls getMessages(lastSeenMessageId) to catch up
  // Bob sees all missed messages
});
```

### Part 8: Authentication Expiration
```typescript
it('demonstrates handling authentication expiration', async () => {
  // Alice connects normally
  // Simulate token expiration: await aliceClient.simulateTokenExpiration()
  // Next RPC call triggers User DO to close with code 4401
  // onClose handler receives code 4401 and reason "Token expired"
  // Verify application can handle this (e.g., refresh token)
});
```

### Part 9: RPC Boundaries
```typescript
it('demonstrates what is/isn\'t accessible via RPC', async () => {
  // ✅ Works: await aliceClient.ctx.storage.kv.get(...) (public member)
  // ❌ Fails: aliceClient.#env is undefined (private, hidden)
  // ❌ Fails: Cannot access Room's #ctx or #env from User DO
  // Show that private members are truly hidden
});
```

## Implementation Notes

### Worker (`src/index.ts`)

```typescript
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Login endpoint
    if (url.pathname === '/login') {
      const username = url.searchParams.get('username');
      const token = crypto.randomUUID();
      
      // In real app, store token in KV with expiration
      // For doc-test, we'll keep it simple
      
      return new Response(JSON.stringify({ token }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Route to User DO with authentication
    return await routeDORequest(request, env, {
      doNamespace: env.USER,  // Route to User DO
      doInstanceNameOrId: 'from-token',  // Extract from token below
      onBeforeConnect: async (request, { doNamespace, doInstanceNameOrId }) => {
        // Extract token from protocols
        const protocols = request.headers.get('Sec-WebSocket-Protocol');
        const token = protocols?.split(',')
          .find(p => p.trim().startsWith('lumenize.rpc.token.'))
          ?.substring('lumenize.rpc.token.'.length);
        
        if (!token) {
          return new Response('Unauthorized', { status: 401 });
        }
        
        // Validate token (simplified for doc-test)
        // In real app, check KV, verify expiration, etc.
        
        // Token IS the userId for simplicity (e.g., 'user-alice')
        // Update the DO instance name to use the token as userId
        return {
          doInstanceNameOrId: token,  // e.g., 'user-alice'
          request: request
        };
      }
    }) || new Response('Not Found', { status: 404 });
  }
};
```

### User DO (Gateway/Facade)

```typescript
interface Env {
  USER: DurableObjectNamespace;
  ROOM: DurableObjectNamespace;
}

class User extends DurableObject<Env> {
  #clientId: string | null = null;
  #env: Env;  // Hidden - cannot hop via RPC
  #tokenExpired: boolean = false;
  
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#env = env;  // Hide env from external access
  }
  
  // Called internally by lumenizeRpcDO when WebSocket connects
  __setClientId(clientId: string): void {
    this.#clientId = clientId;
  }
  
  // User settings (demonstrates Map type support)
  async updateSettings(settings: Map<string, any>): Promise<void> {
    await this.ctx.storage.kv.put('userSettings', settings);
  }
  
  async getSettings(): Promise<Map<string, any>> {
    return await this.ctx.storage.kv.get('userSettings') ?? new Map();
  }
  
  // Room interaction facade (permission-checked)
  async joinRoom(): Promise<{ messageCount: number; participants: string[] }> {
    const settings = await this.getSettings();
    const username = settings.get('name') ?? 'Anonymous';
    
    const room = this.#env.ROOM.get(this.#env.ROOM.idFromName('general'));
    return await room.addParticipant(this.#clientId!, username);
  }
  
  async postMessage(text: string): Promise<void> {
    this.#checkAuth();
    
    const room = this.#env.ROOM.get(this.#env.ROOM.idFromName('general'));
    const permissions = await room.getUserPermissions(this.#clientId!);
    
    if (!permissions.includes('post')) {
      throw new Error('No permission to post');
    }
    
    await room.postMessage(this.#clientId!, text);
  }
  
  async updateMessage(messageId: number, newText: string): Promise<void> {
    this.#checkAuth();
    
    const room = this.#env.ROOM.get(this.#env.ROOM.idFromName('general'));
    await room.updateMessage(this.#clientId!, messageId, newText);
  }
  
  async getMessages(fromId?: number): Promise<any[]> {
    const room = this.#env.ROOM.get(this.#env.ROOM.idFromName('general'));
    return await room.getMessages(fromId);
  }
  
  async leaveRoom(): Promise<void> {
    const room = this.#env.ROOM.get(this.#env.ROOM.idFromName('general'));
    await room.removeParticipant(this.#clientId!);
  }
  
  // Called by Room DO via Workers RPC to forward downstream
  async receiveDownstream(payload: any): Promise<void> {
    if (!this.#clientId) return;
    await sendDownstream(this.#clientId, this, payload);
  }
  
  // Test helper to simulate token expiration
  async simulateTokenExpiration(): Promise<void> {
    this.#tokenExpired = true;
  }
  
  #checkAuth(): void {
    if (this.#tokenExpired) {
      // Close WebSocket with custom code
      const sockets = this.ctx.getWebSockets();
      for (const socket of sockets) {
        socket.close(4401, 'Token expired');
      }
      throw new Error('Token expired');
    }
  }
}
```

### Room DO (Shared State)

```typescript
interface Message {
  id: number;
  userId: string;
  username: string;
  text: string;
  timestamp: Date;
}

interface Participant {
  userId: string;
  username: string;
  permissions: string[];  // ['post', 'update', 'moderate']
}

class Room extends DurableObject<Env> {
  #ctx: DurableObjectState;
  #env: Env;
  #participants: Map<string, Participant> = new Map();
  
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);  // Call super first
    this.#ctx = ctx;  // Then hide from external access
    this.#env = env;
  }
  
  async addParticipant(userId: string, username: string): Promise<{
    messageCount: number;
    participants: string[];
  }> {
    // Add with default permissions
    this.#participants.set(userId, {
      userId,
      username,
      permissions: ['post', 'update']  // Not 'moderate'
    });
    
    // Notify all other participants
    await this.#broadcastToOthers(userId, {
      type: 'user_joined',
      userId,
      username
    });
    
    const messageCount = await this.#ctx.storage.kv.get<number>('messageCount') ?? 0;
    return {
      messageCount,
      participants: Array.from(this.#participants.values()).map(p => p.username)
    };
  }
  
  async postMessage(userId: string, text: string): Promise<void> {
    const participant = this.#participants.get(userId);
    if (!participant) throw new Error('User not in room');
    
    // Get next message ID
    const messageCount = await this.#ctx.storage.kv.get<number>('messageCount') ?? 0;
    const messageId = messageCount + 1;
    await this.#ctx.storage.kv.put('messageCount', messageId);
    
    // Create message (demonstrates Date type support)
    const message: Message = {
      id: messageId,
      userId,
      username: participant.username,
      text,
      timestamp: new Date()
    };
    
    // Store message
    await this.#ctx.storage.kv.put(`message:${messageId}`, message);
    
    // Broadcast to all participants
    await this.#broadcastToAll({ type: 'message', message });
  }
  
  async updateMessage(userId: string, messageId: number, newText: string): Promise<void> {
    const participant = this.#participants.get(userId);
    if (!participant) throw new Error('User not in room');
    
    // Get existing message
    const message = await this.#ctx.storage.kv.get<Message>(`message:${messageId}`);
    if (!message) throw new Error('Message not found');
    
    // Check if user owns the message (permission check)
    if (message.userId !== userId && !participant.permissions.includes('moderate')) {
      throw new Error('No permission to update this message');
    }
    
    // Update message
    message.text = newText;
    await this.#ctx.storage.kv.put(`message:${messageId}`, message);
    
    // Broadcast update
    await this.#broadcastToAll({ type: 'message_updated', messageId, newText });
  }
  
  async getMessages(fromId?: number): Promise<Message[]> {
    const messageCount = await this.#ctx.storage.kv.get<number>('messageCount') ?? 0;
    const messages: Message[] = [];
    
    const startId = fromId ? fromId + 1 : 1;
    for (let i = startId; i <= messageCount; i++) {
      const message = await this.#ctx.storage.kv.get<Message>(`message:${i}`);
      if (message) messages.push(message);
    }
    
    return messages;
  }
  
  async removeParticipant(userId: string): Promise<void> {
    const participant = this.#participants.get(userId);
    if (!participant) return;
    
    this.#participants.delete(userId);
    
    await this.#broadcastToOthers(userId, {
      type: 'user_left',
      userId,
      username: participant.username
    });
  }
  
  async getUserPermissions(userId: string): Promise<string[]> {
    return this.#participants.get(userId)?.permissions ?? [];
  }
  
  // Broadcast to all participants via their User DOs
  async #broadcastToAll(payload: any): Promise<void> {
    const userIds = Array.from(this.#participants.keys());
    await Promise.all(
      userIds.map(async (userId) => {
        const userStub = this.#env.USER.get(this.#env.USER.idFromName(userId));
        await userStub.receiveDownstream(payload);
      })
    );
  }
  
  // Broadcast to all except one user
  async #broadcastToOthers(excludeUserId: string, payload: any): Promise<void> {
    const userIds = Array.from(this.#participants.keys()).filter(id => id !== excludeUserId);
    await Promise.all(
      userIds.map(async (userId) => {
        const userStub = this.#env.USER.get(this.#env.USER.idFromName(userId));
        await userStub.receiveDownstream(payload);
      })
    );
  }
}
```

### Wrangler Configuration

```jsonc
{
  "name": "chat-example-doctest",
  "main": "src/index.ts",
  "compatibility_date": "2024-01-01",
  "durable_objects": {
    "bindings": [
      { "name": "USER", "class_name": "User", "script_name": "chat-example-doctest" },
      { "name": "ROOM", "class_name": "Room", "script_name": "chat-example-doctest" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["User", "Room"] }
  ]
}
```

## Testing Setup

### test/test-harness.ts
Standard `instrumentDOProject` with both `User` and `Room` DO classes.

```typescript
import { instrumentDOProject } from '@lumenize/doc-testing/instrument-do';
import { User, Room } from '../src/user-do';  // Assuming both exported from one file

const instrumented = instrumentDOProject({ User, Room });

export { instrumented };
export default instrumented.worker;
```

### test/wrangler.jsonc
```jsonc
{
  "name": "chat-example-test",
  "main": "./test-harness.ts",
  "compatibility_date": "2025-09-12",
  "durable_objects": {
    "bindings": [
      { "name": "USER", "class_name": "User" },
      { "name": "ROOM", "class_name": "Room" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["User", "Room"] }
  ]
}
```

### vitest.config.js
Standard Workers pool config with `isolatedStorage: false` for WebSocket support.

## Success Criteria

- [ ] All tests pass
- [ ] Generated docs are clear and pedagogical
- [ ] Code blocks stay under 80 columns
- [ ] Examples are realistic and copy-paste ready
- [ ] All major RPC features are demonstrated:
  - [ ] Two-DO architecture (User → Room via Workers RPC)
  - [ ] Permission-based access control
  - [ ] Direct storage access (Map type support)
  - [ ] Downstream messaging (Room → User DOs → Clients)
  - [ ] Private member hiding (#env, #ctx)
- [ ] Authentication flow is secure and clear
  - [ ] Token smuggling via WebSocket protocols
  - [ ] 401 for initial auth failure
  - [ ] 4401 for token expiration
- [ ] Downstream messaging is intuitive
- [ ] Catchup pattern is obvious and practical
- [ ] Type support is visible (Dates, Maps, complex objects)

## Open Questions

1. ~~Should we include message reactions or just keep it simple with post/update/delete?~~ 
   → **Keep simple: post/update only**
2. ~~Do we want to show pagination for `getMessages()` or just return all?~~
   → **Return all with optional `fromId` for catchup**
3. ~~Should the token validation be more realistic (check KV) or keep it simple for docs?~~
   → **Keep simple: token = userId for clarity**
4. Do we need to show error handling for all operations or just key ones?
   → **Just key ones: auth expiration, permission denial**

## Next Steps

1. ✅ Review and refine design with two-DO architecture
2. Create project structure in `doc-test/rpc/chat-example/`
3. Implement Worker with User and Room DOs
4. Write doc-test with literate programming style
5. Verify generated docs are clear and accurate
6. Write traditional integration tests for downstream messaging (after doc-test)

