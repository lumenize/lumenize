# LumenizeClientGateway & LumenizeClient

**Status**: Phase 1 - Design Documentation
**Created**: 2025-12-08
**Design Document**: `/website/docs/lumenize-mesh/`

## Goal

Add browser/Node.js clients as first-class participants in the Lumenize Mesh, enabling bidirectional calls between browser clients and other Lumenize Mesh nodes (LumenizeDO, LumenizeWorker).

## Design Principles

1. **Code Similarity**: LumenizeClient API mirrors LumenizeDO (`this.lmz.*`, `this.ctn()`)
2. **Zero Storage Gateway**: LumenizeClientGateway uses NO DO storage - state derived from WebSockets + alarms only
3. **Full Mesh Peers**: Clients can call any mesh node and receive calls from any mesh node
4. **1:1 Gateway-Client**: Each client connects to its own Gateway DO instance
5. **Auth Integrated**: Uses `@lumenize/auth` token patterns

## Key Decisions

See docs for full API details:
- **Mesh Overview**: `/website/docs/lumenize-mesh/index.mdx`
- **Getting Started**: `/website/docs/lumenize-mesh/getting-started.mdx`
- **LumenizeDO Reference**: `/website/docs/lumenize-mesh/lumenize-do.mdx`
- **LumenizeWorker Reference**: `/website/docs/lumenize-mesh/lumenize-worker.mdx`
- **LumenizeClient Reference**: `/website/docs/lumenize-mesh/lumenize-client.mdx`
- **Gateway Details**: `/website/docs/lumenize-mesh/gateway.mdx`
- **Authentication Propogation and Access Control**: `/website/docs/lumenize-mesh/security.mdx`
- **Creating Plugins**: `/website/docs/lumenize-mesh/creating-plugins.mdx`

**Note**: Documentation was restructured on 2025-12-28. Old `lumenize-base/` docs are archived in `/website/docs/_archived/`.

### Gateway-Client Relationship
- Gateway is 1:1 with a **connection**, not a user
- Same user can have multiple clients (one per tab, multiple browsers, browser+node.js, etc.)
- Client "name" becomes Gateway DO name (e.g., `${userId}.${tabId}`)

### Gateway State Machine (No Storage)
State derived from `this.ctx.getWebSockets()` + `this.ctx.getAlarm()`:

| getWebSockets() | getAlarm() | State | Behavior |
|-----------------|------------|-------|----------|
| Has connection | Any | Connected | Forward calls immediately |
| Empty | Pending | Grace Period | Buffer/wait for reconnect (5s) |
| Empty | None | Disconnected | Throw ClientDisconnectedError |

### Gateway `__executeOperation` Acts As a Proxy
Unlike LumenizeDO/LumenizeWorker which execute chains on `this`, Gateway forwards calls from inside Cloudflare to the client over WebSocket and returns the response. Similarly, it will forward calls from its client to nodes inside Cloudflare, including other Gateways which in turn forwards them to other clients.

### `this.lmz.call` Security Model

**Problem**: The current OCAN execution allows arbitrary property traversal. A malicious chain like `this.ctn().ctx.storage.kv.get('secret')` would access internal state.

**Solution**: Defense-in-depth with a **secure-by-default** model (explicit opt-in):

1. **Capability-Based Trust (Automatic)**
   - The **first** method in an RPC chain must be authorized via `@mesh` or `@mesh(handler)`.
   - Once authorized, the caller is granted access to the **entire public interface** (methods and properties) of the returned object for the duration of that continuation chain.
   - **Important Nuance**: In **nesting** (e.g., `multiply(add(1, 2), 10)`), every method called on `this` (`multiply` and `add`) must have an `@mesh` decorator. In **chaining** (e.g., `getPanel().reset()`), only the first method (`getPanel`) needs `@mesh`.
   - **True Privacy**: Use `#private` if you want a method private. Convention-based `_` or `__` methods are public in JavaScript and will be accessible if an object is returned.

2. **Class-level `onBeforeCall()` hook**
   - Override in your class for class-wide policies (access context via `this.lmz.callContext`).
   - typically focuses on WHO can call: authentication, audit logging, rate limiting.
   - LumenizeClient overidable default: reject peer calls from other LumenizeClients.

3. **Method Exposure (@mesh) — Entry Point Only**
   - Mandatory opt-in for the **first** method in an RPC chain.
   - Subsequent methods in a chain (fluent APIs) are trusted as "authorized returns" from the first call.
   - **Exception**: Methods used as local callbacks (handlers) in a continuation authored by the node itself do not require `@mesh` because they are part of a trusted continuation chain.

**Execution Flow**:
```
Class onBeforeCall → Entry Point Check (@mesh) → Execute Chain (Trusted Returns)
```

**Implementation Notes**:
- Use `@mesh` decorator to mark methods as mesh-callable.
- `executeOperationChain()` checks for this marker before execution.
- **Guard signature**: `@mesh((instance) => void)`. Guards receive the instance, providing access to both `instance.lmz.callContext` and instance state. This avoids the arrow-function-`this`-binding footgun.

**No `MeshAccessError` (Decision 2025-01-12)**:
Calling a method that lacks the `@mesh` decorator behaves the same as calling a method that doesn't exist — a generic "method not found" error.

**Rationale**: Distinguishing "exists but not exposed" from "doesn't exist" only helps attackers probe the API. During development, you'll see the error and realize you forgot `@mesh`. No need to reveal which methods exist but aren't exposed.

**Error Handling**:
- **Method not found** (generic) — covers both "doesn't exist" and "exists but no `@mesh`"
- **Guards/onBeforeCall** — errors thrown pass through unchanged, preserving domain-specific types (e.g., `PermissionDeniedError`, `QuotaExceededError`)

### LumenizeAuth Config: Instance Variables, Not Storage

**Decision (2025-01-17)**: `LumenizeAuth` configuration uses instance variables, not DO storage.

**Problem**: `createAuthRoutes(env, { redirect, ... })` is called in the Worker's `fetch()`, but the `LumenizeAuth` DO needs that config. Options considered:
1. Call `configure()` on every request — wasteful RPC overhead
2. Store config in DO storage — requires version tracking for schema changes
3. Pass config as header on every call — duplicative, though small
4. Lazy init with retry — first request returns "NotConfigured", middleware calls `configure()`, then retries

**Solution**: Option 4 with instance variables (no storage):
- Config stored in memory only, lost on eviction
- First request after eviction: 3 round trips (request → NotConfigured → configure() → retry)
- Normal operation: zero overhead
- `configure()` is idempotent, so concurrent "NotConfigured" responses are harmless

**Rationale**:
- Low-load systems hibernate → 3 round trips are an acceptable tradeoff for robustness and config evolvability
- High-load systems don't hibernate → only pay the cost on code update or eviction for some other reason
- No version tracking needed — deploy new code, eviction happens naturally, fresh config flows in
- Self-healing: no storage migrations, no stale config

### Rate Limiting: Instance Variables Are Acceptable

**Decision (2025-01-17)**: Rate limiting in `LumenizeAuth` uses instance variables, not DO storage.

**Rationale**:
- Storage writes are 10,000x more expensive than reads — unacceptable for a rate limiter that writes on every request
- Rate limiting is inherently ephemeral; if the DO hibernates and limits reset, that's acceptable — if traffic is low enough to hibernate, it's not hitting any reasonable rate limit
- This is a **valid exception** to the "no instance variables for mutable state" rule because: (1) the state is intentionally ephemeral, (2) losing it on eviction is the desired behavior, and (3) the cost of persistence is prohibitive

**Implementation**: `#rateLimits: Map<string, { count: number, windowStart: number }>`

### Debug: Standalone Package, Not NADIS

**Decision (2025-01-05)**: `@lumenize/debug` is a standalone cross-platform package, NOT a NADIS service.

**Rationale**:
- All other NADIS services (sql, alarms, fetch) require DO storage — debug does not
- Debug should work in Cloudflare Workers, Node.js, Bun, AND browsers
- Making it standalone keeps NADIS cleanly "DO services only"
- No external dependencies (not wrapping npm `debug`) for security and maintenance reasons

**Configuration Auto-Detection**:
The debug module auto-detects the environment and reads `DEBUG` from the appropriate source:
- **Cloudflare Workers**: `env?.DEBUG`
- **Node.js/Bun**: `process?.env?.DEBUG`
- **Browser**: `localStorage?.getItem('DEBUG')`

**Design Notes**:
- Use uppercase `DEBUG` consistently across all environments (deviation from npm `debug` which uses lowercase)
- JSON output for Cloudflare observability dashboard queryability
- Zero dependencies, no colors, no TTY detection

**Usage**:
```typescript
import { debug } from '@lumenize/debug';
const log = debug('MyDO.myMethod');
log.info('Something happened', { data });
```

## Implementation Phases

### Phase -1: Documentation Restructure & Package Rename
**Goal**: Consolidate all mesh documentation and rename `@lumenize/lumenize-base` to `@lumenize/mesh`

**Documentation Tasks** (DONE):
- [x] Restructure `website/docs/lumenize-mesh/` with Option D structure (Concepts → Tutorial → References)
- [x] Create `index.mdx` (concepts only)
- [x] Create `getting-started.mdx` (progressive tutorial)
- [x] Create `lumenize-do.mdx` (full reference with NADIS from old lumenize-base)
- [x] Create `lumenize-worker.mdx` (reference)
- [x] Rename `client-api.mdx` → `lumenize-client.mdx`
- [x] Expand `auth-integration.mdx` with full auth package content
- [x] Move `creating-plugins.mdx` to mesh folder
- [x] Archive old `lumenize-base/` and `auth/` docs to `_archived/`
- [x] Update `sidebars.ts` for new structure

**Package Rename Tasks** (DONE):
- [x] Rename directory `packages/lumenize-base/` → `packages/mesh/`
- [x] Rename file `lumenize-base.ts` → `lumenize-do.ts`
- [x] Rename class `LumenizeBase` → `LumenizeDO` across codebase
- [x] Update `package.json` name to `@lumenize/mesh`
- [x] Update all imports across the monorepo
- [x] Update TypeDoc config in `website/docusaurus.config.ts` (disabled auto-gen, using hand-written docs)

### Phase 0: Tweaks to Existing Code Before Implementing Client/Gateway

**0.1 LumenizeDO Lifecycle Hook** (PENDING):
- [ ] Add `onStart()` lifecycle hook to `LumenizeDO` base class
- [ ] Call from base constructor wrapped in `blockConcurrencyWhile`
- [ ] Allows async initialization (migrations, setup) without race conditions
- [ ] Users should NOT write custom constructors — use `onStart()` instead

**0.2 @lumenize/auth Magic Link Flow Fix** (PENDING):
The current implementation is broken for real-world use:
- Magic link click is a browser navigation, not a fetch
- `/auth/magic-link` returns JSON, which the browser just displays as raw text
- URL routing with `prefix: 'auth'` doesn't work — `routeDORequest` requires binding name and instance name in the URL, so /auth/logout won't work

Fix:
- [ ] Add `createAuthRoutes` factory function in `@lumenize/auth`
  - Wraps `routeDORequest` with URL rewriting (`/auth/magic-link` → `/auth/${gatewayBindingName}/${instanceName}/magic-link`)
  - Config: see website/docs/auth/index.mdx "Routing Function" section for details
  - Passes entire config to `LumenizeAuth.configure()` via lazy init pattern (see "LumenizeAuth Config" decision above)
- [ ] Change `/auth/magic-link` endpoint to return redirect (302) instead of JSON
  - Sets refresh token cookie
  - Redirects to configured `redirect`
  - Access token obtained via refresh-on-load pattern (SPA calls `/auth/refresh-token`)
- [ ] Update `/website/docs/auth/index.mdx` — new flow, remove misleading language
- [ ] Update `/website/docs/lumenize-mesh/getting-started.mdx` — use `createAuthRoutes`, show refresh-on-load pattern

**0.3 @lumenize/auth Rate Limiting Fix** (PENDING):
- [ ] Refactor rate limiting in `LumenizeAuth` to use instance variables instead of DO storage
  - Current implementation uses `this.svc.sql` with a `rate_limits` table
  - Storage writes are 10,000x more expensive than reads — unacceptable for rate limiting
  - Rate limiting is ephemeral by nature; if DO evicts, limits reset (acceptable — if traffic is low enough to hibernate, it's not exceeding any reasonable rate limit)
  - Use `#rateLimits: Map<string, { count: number, windowStart: number }>` instance variable
  - This is the one valid exception to the "no instance variables for mutable state" rule

**0.4 Core Utilities Restructuring** (PENDING):
- [ ] Merge `sql` utility from `@lumenize/core` into `@lumenize/mesh`
  - `sql` only makes sense for LumenizeDO (DO storage) — available via `this.svc.sql`
  - For mesh nodes, just import the base class — `this.svc.*` handles the rest (no separate `@lumenize/core` import needed)
  - Also export `sql` directly from `@lumenize/mesh` for standalone/vanilla usage
- [x] ~~Merge `@lumenize/auth` into `@lumenize/mesh`~~ **REVISED (2025-01-14)**: Keep `@lumenize/auth` as separate package
  - The coupling is minimal: just two headers (`X-Auth-User-Id`, `X-Auth-Claims`)
  - Users with existing auth (Auth0, Clerk, custom) only need the header contract
  - Separation of concerns — auth is a distinct domain from mesh communication
  - See `/website/docs/lumenize-mesh/security.mdx` for integration details and Auth0 example
- [ ] Publish `@lumenize/debug` as a standalone cross-platform package (see Debug decision below)

### Phase 1: Design Documentation (Docs-First)
**Goal**: Define user-facing APIs in MDX before implementation

**Deliverables**: See `/website/docs/lumenize-mesh/`

**Success Criteria**:
- API design approved by maintainer
- Clear examples for common use cases

### Phase 2: LumenizeClientGateway Implementation
**Goal**: Zero-storage DO that proxies between mesh and WebSocket client

**Success Criteria**:
- Extends DurableObject directly (not LumenizeDO)
- NO storage operations - state from getWebSockets() + getAlarm() only
- WebSocket attachments for connection metadata
- 5-second grace period on disconnect (via alarm)
- `__executeOperation()` forwards to client and returns response
- Incoming mesh calls handled when client connected
- Graceful handling when client disconnected

### Phase 3: WebSocket Transport (Fork from RPC)
**Goal**: Create mesh-specific WebSocket transport by forking from RPC

**Success Criteria**:
- `WebSocketTransport` class in `@lumenize/mesh`
- Forked from `rpc/src/websocket-rpc-transport.ts` (~200 lines)
- Adapted for mesh: call envelopes, incoming calls, token refresh
- `@lumenize/rpc` untouched (stays frozen)

### Phase 4: LumenizeClient Core
**Goal**: Browser-side mesh participant with call infrastructure

**Success Criteria**:
- `this.lmz.callRaw()` working through Gateway
- `this.lmz.call()` with continuation support
- `this.ctn()` for building operation chains
- **Instant Connect**: Connection established immediately upon instantiation (not lazy)
- Shared code with LumenizeDO where possible
- Uses refactored WebSocket transport

### Phase 5: Connection Management
**Goal**: Robust connection lifecycle

**Success Criteria**:
- Auto-reconnect with exponential backoff (from generic transport)
- **Wake-up Sensing**: Automatic reconnection on tab visibility/focus or system online events
- Connection state tracking and callbacks
- Message queuing during reconnection (configurable)
- Clean disconnect handling

### Phase 6: Auth & Call Context
**Goal**: Seamless token handling and zero-trust call context propagation

**Success Criteria**:
- Token passed via `lmz, lmz.access-token.{jwt}` subprotocol
- Gateway stores token in WebSocket attachment for verification
- `this.lmz.callContext` available in all method handlers (see auth-integration.mdx)
- `callContext` automatically preserved across hibernation (no manual capture needed)

**Implementation Notes** (not in user docs):

1. **Hybrid Context Strategy**: Use both AsyncLocalStorage AND continuation-captured context:
   - **AsyncLocalStorage**: Provides `this.lmz.callContext` for convenient access anywhere in the call stack
   - **Continuation snapshot**: Captures context at serialization time, restores it at execution time
   - The continuation is the **source of truth** for hibernation scenarios

2. **Context Capture Point**: Capture at `getOperationChain()` time (not `this.ctn()` time):
   - This is the "last moment" before the chain is sent/stored
   - Captures the most up-to-date context at dispatch time
   - Semantically cleaner: "attach context when committing to work, not when describing it"

3. **Affected Components**:
   - `lmz-api.ts` - Add `CallContext` type, `callContextStorage` (AsyncLocalStorage instance), `callContext` getter on `LmzApi`
   - `ocan/types.ts` - `OperationChain` becomes `{ ops: Operation[], context?: CallContext }` (or keep as array and handle separately)
   - `ocan/proxy-factory.ts` - `getOperationChain()` captures `callContextStorage.getStore()` and includes in return value
   - `ocan/execute.ts` - `executeOperationChain()` restores context to ALS before execution
   - `lumenize-do.ts` - `__executeOperation()` sets up ALS context from envelope, restored context available in handlers

4. **Execution Flow**:
   ```
   Incoming call → __executeOperation() sets ALS from envelope.metadata.callContext
                 → handler runs, can access this.lmz.callContext
                 → if handler creates continuation for later execution:
                     → getOperationChain() snapshots current ALS context
                     → chain serialized with context
                 → later, continuation executes:
                     → executeOperationChain() restores context to ALS
                     → handler runs with original callContext
   ```

5. **Freeze callContext**: Deep-freeze the callContext when setting it to prevent accidental modification:
   ```typescript
   const frozenContext = Object.freeze({
     origin: Object.freeze({...origin}),
     caller: Object.freeze({...caller}),
     priorCaller: priorCaller ? Object.freeze({...priorCaller}) : undefined,
     originAuth: originAuth ? deepFreeze(originAuth) : undefined,
     state: {},  // Mutable - for user data during request
   });
   callContextStorage.run(frozenContext, async () => { ... });
   ```

6. **Trust model**: Nodes in the mesh are trusted. Freezing prevents bugs, not malicious nodes. For high-security operations, verify `originAuthToken` (signed JWT) independently.

7. **Authentication Error Handling**:
   - `onAuthenticationError` fires for all auth failures: token refresh failed, initial connection rejected (401/403), mid-session token expiration (4401 close code)
   - Separate from `onConnectionError` which handles network-level WebSocket errors
   - Token refresh is HTTP in parallel to WebSocket — when it fails, WebSocket stays open for in-flight calls
   - Developer handles redirect to login in their `onAuthenticationError` callback

### Phase 7: Client-to-Client Communication
**Goal**: Enable LumenizeClient → LumenizeClient calls

**Success Criteria**:
- Client A → Gateway A → Gateway B → Client B working
- Round-trip latency acceptable (~60ms target)
- Error handling for disconnected target client

### Phase 8: Testing & Documentation Validation
**Goal**: Comprehensive test coverage

**Success Criteria**:
- Client → Gateway → DO integration tests
- DO → Gateway → Client downstream tests  
- Client → Client via Gateways tests
- Reconnection scenario tests
- Auth flow tests
- `test/for-docs/` examples
- `@check-example` annotations pass

## Code Sharing Strategy

| Component | Source | Reuse |
|-----------|--------|-------|
| OCAN/Continuations | `mesh/src/ocan/` | Direct import |
| CallEnvelope format | `mesh/src/lmz-api.ts` | Shared types |
| WebSocket transport | `rpc/src/websocket-rpc-transport.ts` | **Fork** (~200 lines) |
| Auth middleware | `mesh/src/auth/` | Direct import (merged from packages/auth) |

### WebSocket Transport: Fork from RPC

**Decision:** Fork rather than extract shared abstraction.

**Rationale:**
- `@lumenize/rpc` is frozen (not deprecated, but not building new things with it)
- LumenizeClient transport will diverge (mesh envelopes, incoming calls, token refresh)
- ~200 lines doesn't warrant an abstraction layer

**What to copy:** Connection lifecycle, auto-reconnect, keep-alive, state events, WebSocket injection, protocol array building

**What to adapt:** Message format (envelopes not batches), bidirectional calls, pending call tracking by callId

**Location:** `mesh/src/websocket-transport.ts`

### New LmzApi for Client

New `createLmzApiForClient()` alongside existing:
- `createLmzApiForDO()` - LumenizeDO
- `createLmzApiForWorker()` - LumenizeWorker
- `createLmzApiForClient()` - LumenizeClient (NEW)

## Package Location

```
packages/mesh/
  src/
    lumenize-do.ts              # Existing (renamed from lumenize-base.ts)
    lumenize-worker.ts          # Existing
    lumenize-client.ts          # NEW
    lumenize-client-gateway.ts  # NEW
    lmz-api.ts                  # Add createLmzApiForClient()
    types.ts                    # Shared types
```

## Resolved Questions

1. **LumenizeRouter scope**: `createLumenizeRouter` factory function with smart mesh defaults. Referenced in `index.mdx` supporting infrastructure table. Implementation deferred - not blocking for MVP.

2. **Offline queue behavior**: `callRaw()` fails immediately when disconnected; `call()` without handler is fire-and-forget.

3. **Gateway alarm/attachment storage**: Both use Cloudflare infrastructure, not DO SQLite - no storage charges.

## Gateway Implementation Details

### Connection Lifecycle

```typescript
// 1. Client initiates WebSocket connection
const ws = new WebSocket(url, [
  'lmz',                           // Primary protocol
  `lmz.access-token.${jwt}`,       // Auth token (smuggled)
  `lmz.client-id.${clientId}`      // Client identifier
]);

// 2. Gateway receives upgrade request
async fetch(request: Request): Promise<Response> {
  // Verify auth token from subprotocol
  const token = extractWebSocketToken(request);
  
  // Accept hibernatable WebSocket
  const pair = new WebSocketPair();
  this.ctx.acceptWebSocket(pair[1]);
  
  // Store metadata in attachment (not DO storage!)
  pair[1].serializeAttachment({
    userId: payload.sub,
    connectedAt: Date.now(),
    token
  });
  
  return new Response(null, {
    status: 101,
    headers: { 'Sec-WebSocket-Protocol': 'lmz' }
  });
}

// 3. Client Disconnects
async webSocketClose(ws: WebSocket, code: number, reason: string) {
  // Set 5-second grace period alarm
  await this.ctx.storage.setAlarm(Date.now() + 5000);
  
  // Note: If client reconnects before alarm, state goes back to Connected
}

// 4. Grace period expired — client didn't reconnect
async alarm() {
  // Set marker alarm (far future) to indicate subscriptions were lost
  // 100 years - no ongoing cost for pending alarms (only charged on setAlarm call)
  const MARKER_OFFSET_MS = 100 * 365 * 24 * 60 * 60 * 1000;
  await this.ctx.storage.setAlarm(Date.now() + MARKER_OFFSET_MS);
}

// 5. Client Reconnects — Determine subscription state
async fetch(request: Request): Promise<Response> {
  // ... handle WebSocket upgrade ...

  // Determine subscription state from alarm
  const subscriptionsLost = this.#determineSubscriptionState();

  // Send connection status to client immediately after handshake
  ws.send(JSON.stringify({
    type: 'connection_status',
    subscriptionsLost
  }));
}

#determineSubscriptionState(): boolean {
  const GRACE_PERIOD_MS = 5000;
  const alarm = this.ctx.storage.getAlarm();  // sync API

  if (alarm === null) {
    // Fresh connection (never disconnected)
    return false;
  }

  if (alarm > Date.now() + GRACE_PERIOD_MS) {
    // Marker alarm — grace period had expired
    this.ctx.storage.deleteAlarm();
    return true;
  }

  // Alarm still in grace period range — subscriptions intact
  this.ctx.storage.deleteAlarm();
  return false;
}
```

### Call Handling Implementation

```typescript
// --- Outgoing Calls (Client → Mesh) ---
async webSocketMessage(ws: WebSocket, message: string) {
  const envelope = JSON.parse(message);
  
  if (envelope.type === '__call') {
    // Client is making a call to a mesh node
    const { binding, instance, chain, callId } = envelope;
    
    try {
      // Forward to target DO/Worker
      const result = await this.lmz.callRaw(binding, instance, chain);
      
      // Send response back to client
      ws.send(JSON.stringify({
        type: '__response',
        callId,
        success: true,
        result
      }));
    } catch (error) {
      ws.send(JSON.stringify({
        type: '__response',
        callId,
        success: false,
        error: serializeError(error)
      }));
    }
  }
}

// --- Incoming Calls (Mesh → Client) ---
// Called by mesh nodes via: this.lmz.call('LUMENIZE_CLIENT_GATEWAY', clientId, ...)
async __executeOperation(envelope: CallEnvelope): Promise<any> {
  const ws = this.ctx.getWebSockets()[0];
  
  if (!ws) {
    // Check if in grace period
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm) {
      // Wait for reconnect (with timeout)
      await this.#waitForReconnect();
      // Retry getting WebSocket
      const ws = this.ctx.getWebSockets()[0];
      if (!ws) {
        throw new Error('Client did not reconnect in time');
      }
    } else {
      throw new Error('Client not connected');
    }
  }
  
  // Forward to client and await response
  return await this.#forwardToClient(ws, envelope);
}

// Implementation note: #waitForReconnect() uses setTimeout to race against grace period expiration.
// This is an exception to our "no setTimeout in DOs" rule because:
// 1. It's timing out an in-flight operation, not scheduling future work
// 2. The alarm already marks when grace period ends; setTimeout lets us wait up to that point
// 3. Alternative approaches (polling getAlarm, alarm notifying pending calls) are more complex
async #waitForReconnect(): Promise<void> {
  const alarm = await this.ctx.storage.getAlarm();
  if (!alarm) {
    this.#markSubscriptionsLost();
    throw new ClientDisconnectedError();
  }

  const remainingMs = alarm - Date.now();
  if (remainingMs <= 0) {
    this.#markSubscriptionsLost();
    throw new ClientDisconnectedError();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      this.#markSubscriptionsLost();
      reject(new ClientDisconnectedError());
    }, remainingMs);

    // When client reconnects, webSocketOpen clears pending waiters
    this.#pendingReconnectWaiters.push({ resolve, timeout });
  });
}

#markSubscriptionsLost() {
  // Set marker alarm so client knows subscriptions were lost when it reconnects
  const MARKER_OFFSET_MS = 100 * 365 * 24 * 60 * 60 * 1000;
  this.ctx.storage.setAlarm(Date.now() + MARKER_OFFSET_MS);
}

async #forwardToClient(ws: WebSocket, envelope: CallEnvelope): Promise<any> {
  const callId = crypto.randomUUID();
  
  // Send call to client
  ws.send(JSON.stringify({
    type: '__incomingCall',
    callId,
    chain: envelope.chain
  }));
  
  // Wait for response (with timeout)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Client call timed out'));
    }, 30000);
    
    // Response handling via webSocketMessage
    this.#pendingCalls.set(callId, { resolve, reject, timeout });
  });
}
```

### Trust Boundary Verification

```typescript
async webSocketMessage(ws: WebSocket, message: string) {
  const msg = JSON.parse(message);
  
  if (msg.type === '__call') {
    // From client message: ONLY the continuation (what to call)
    const { binding, instance, chain, callId } = msg;
    
    // From WebSocket attachment: verified identity (set at connection time)
    const attachment = ws.deserializeAttachment();
    
    // Build callContext from VERIFIED sources, not from message!
    const clientNode = {
      type: 'LumenizeClient',
      instanceNameOrId: attachment.verifiedInstanceName  // From JWT
    };
    
    const originAuth = {
      userId: attachment.verifiedUserId,    // From JWT
      claims: attachment.verifiedClaims,    // From JWT
    };
    
    // Even if the client sent fake originAuth in msg, we ignore it
    // and use only the verified data from the attachment
  }
}
```

### Gateway Token Verification

**Note**: These are internal implementation details for `LumenizeClientGateway`.

```typescript
// 1. On Connection (via Middleware)
onBeforeConnect: async (request, context) => {
  const result = await wsAuthMiddleware(request, context);
  // Returns enhanced request with X-Auth-User-Id header
  return result;
}

// 2. On Each Message (via Attachment)
async webSocketMessage(ws: WebSocket, message: string) {
  const attachment = ws.deserializeAttachment();
  
  // Check if token has expired
  if (attachment.tokenExp && attachment.tokenExp < Date.now() / 1000) {
    ws.close(4401, 'Token expired');
    return;
  }
  
  // Process message...
}

// 3. Identity Validation
async fetch(request: Request) {
  const authUserId = request.headers.get('X-Auth-User-Id');
  const instanceUserId = this.lmz.instanceName?.split('.')[0];
  
  if (authUserId && instanceUserId && authUserId !== instanceUserId) {
    return new Response('Unauthorized', { status: 403 });
  }
}

// 4. Client-side token storage (LumenizeClient)
// Stored in memory (private field). Never persisted to localStorage or cookies.
// Managed automatically by LumenizeClient.
class LumenizeClient {
  #accessToken: string | null = null;
  // Updated automatically during refresh
}
```

## Verify with Code Review, vitest-pool-workers Testing, or Live Testing

- [ ] (live) Round trip between two clients. Clients can be on same machine but the call will go up into Cloudflare hop from one Gateway to the next, then back down.
- [ ] (search and review) `blockConcurrency` is not used by call. I mistakenly did that for the current implementation because I didn't realize we could get fire and forget behavior with simple use of Promise/then/catch
- [ ] (vitest-pool) CORS with a whitelist blocks even for calls with no preflight
- [ ] (review) Malicious user can't control the callContext contents from a LumenizeClient. It must be determined at the Gateway
- [ ] (vitest-pool) `this.lmz.callContext` is automatically restored for continuations (no manual capture needed) even when there is a round-trip remote call.
- [ ] (live) Performance of various patterns for remote calls for both fire-and-forget as well as for ones where it actually awaits. Consider always making it two one-way calls but only after live testing.
- [ ] (review and vitest-pool) Clients must be authenticated
- [ ] (vitest-pool) Trusted return capability security model allows you to return an interface for just admins. Similarly, it should not allow the use of root-level methods without an @mesh decorator in nested conditions. For example, `multiply(subtract(4, 3), add(2, 1))` should only work if `multiply`, `subtract`, and `add` all have @mesh annotations that allow them.
- [ ] (vitest-pool) When you do a call where you want the result handler to be called right after the await returns that it does not require the handler to have an @mesh annotation. However, in a two one-way call situation, the final callback would need to have an @mesh decorator.
- [ ] (vitest-pool) lmz.callContext has the correct information even when there are deeply interleaved operations ongoing (ALS isolation).
- [ ] (vitest-pool) Verify that `callContext` is automatically captured in continuations and survives DO hibernation without manual user intervention.
- [ ] (vitest-pool) Verify that `callContext.state` modifications in DO2 are visible in DO1's continuation after the call returns.
- [ ] calls to `client.myMethod` don't go through access control checks. We want to be able to call them from browser-based code.
- [ ] LumenizeDO and LumenizeWorker are upgraded to support the new access control model
- [ ] (review) That we don't have lots of duplication in implementations of execute continuations and call including when packages/fetch and packages/alarms are used. Maybe they need to be different accross LumenizeDO, LumenizeWorker, and LumenizeClient (although reuse would be ideal), but fetch and alarms probably shouldn't have their own.
- [ ] Messages are queued when the client is in a reconnection grace period. Also, they should queue in a situation where the tab reawakens, the client sends a message and that triggers the reconnection. We may be monitoring the tab sleep/awake events and try the reconnection proactively. We want to keep that feature so messages sent from the mesh reach the client. However, we want to test multiple different timings to assure robustness. Needs analysis.
- [ ] (vitest-pool) Verify `{ newChain: true }` option in `lmz.call()` starts a fresh call chain with new `callContext` (origin becomes the calling node, state is empty, no inherited originAuth).
- [ ] Verify that when the access token expires, it tries the refresh token before calling onAuthenticationError

## References

- Design docs: `/website/docs/lumenize-mesh/`
- `packages/rpc/src/websocket-rpc-transport.ts` - Transport patterns
- `packages/mesh/src/auth/` - Auth middleware (after merge from packages/auth)
