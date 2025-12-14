# LumenizeClientGateway & LumenizeClient

**Status**: Phase 1 - Design Documentation
**Created**: 2025-12-08
**Design Document**: `/website/docs/lumenize-mesh/`

## Goal

Add browser/Node.js clients as first-class participants in the Lumenize Mesh (LM), enabling bidirectional RPC between browser clients and Cloudflare DOs/Workers.

## Background: Lumenize Mesh Vision

The **Lumenize Mesh (LM)** is an actor-model network where nodes communicate via `this.lmz.call()` and `this.lmz.callRaw()`:

| Node Type | Runs In | Storage | Extends |
|-----------|---------|---------|---------|
| LumenizeDO | Cloudflare DO | Yes | DurableObject |
| LumenizeWorker | Cloudflare Worker | No | WorkerEntrypoint |
| **LumenizeClient** (NEW) | Browser/Node.js | Local only | - |
| **LumenizeClientGateway** (NEW) | Cloudflare DO | **None** | DurableObject |

**Infrastructure nodes** (not user-extended):
- LumenizeClientGateway - Proxies between mesh and WebSocket client
- createLumenizeRouter - Factory function for Worker routing with mesh defaults

## Design Principles

1. **Code Similarity**: LumenizeClient API mirrors LumenizeDO (`this.lmz.*`, `this.ctn()`)
2. **Zero Storage Gateway**: LumenizeClientGateway uses NO DO storage - state derived from WebSockets + alarms only
3. **Full Mesh Peers**: Clients can call any mesh node and receive calls from any mesh node
4. **1:1 Gateway-Client**: Each client connects to its own Gateway DO instance
5. **Auth Integrated**: Uses existing `@lumenize/auth` token patterns

## Key Decisions

### Gateway-Client Relationship
- Gateway is 1:1 with a **connection**, not a user
- Same user can have multiple clients (one per tab recommended)
- Client "name" becomes Gateway DO name (e.g., `${userId}.${tabId}`)

### Gateway State Machine (No Storage)
State derived from `this.ctx.getWebSockets()` + `this.ctx.getAlarm()`:

| getWebSockets() | getAlarm() | State | Behavior |
|-----------------|------------|-------|----------|
| Has connection | Any | Connected | Forward calls immediately |
| Empty | Pending | Grace Period | Buffer/wait for reconnect (5s) |
| Empty | None | Disconnected | Reject calls with "not connected" |

### Gateway `__executeOperation` Is a Proxy
Unlike LumenizeDO/LumenizeWorker which execute chains on `this`, Gateway forwards chains to the client over WebSocket and returns the response.

### createLumenizeRouter
Factory function (not a class) for creating Workers with mesh-friendly defaults:
```typescript
// Creates a fetch handler with auth + gateway routing
const handleRequest = createLumenizeRouter(env, {
  authConfig: { publicKeysPem: [...] },
  gatewayBinding: 'LUMENIZE_CLIENT_GATEWAY',
});
```

## API Sketch

### LumenizeClient

```typescript
interface LumenizeClientConfig {
  baseUrl?: string;                   // Default: 'wss://localhost:8787'
  gatewayBinding?: string;            // Default: 'LUMENIZE_GATEWAY'
  instanceName: string;               // Suggest '${userId}.${tabId}' - becomes Gateway instance name
  
  // Auth
  accessToken?: string;               // Initial JWT
  refreshEndpoint?: string;           // Default: '/auth/refresh-token'
  // Token refresh handled internally - parses JWT expiry, refreshes ~30s before
  
  // Connection callbacks
  onConnectionStateChange?: (state: ConnectionState) => void;
  onConnectionError?: (error: Error) => void;
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

class LumenizeClient {
  // Identity - similar to LumenizeDO
  readonly lmz: {
    readonly type: 'LumenizeClient';
    readonly bindingName?: string;    // 'LUMENIZE_CLIENT_GATEWAY'
    readonly instanceName?: string;   // User-provided name
    readonly instanceNameOrId?: string;
    
    // RPC to any mesh node (routed through Gateway)
    callRaw(binding: string, instance: string | undefined, chain: any): Promise<any>;
    call(binding: string, instance: string | undefined, remote: Continuation, handler?: Continuation): void;
  };
  
  // Continuations - identical to LumenizeDO
  ctn<T = this>(): Continuation<T>;
  
  // Connection lifecycle
  connect(): Promise<void>;
  disconnect(): void;
  readonly connectionState: ConnectionState;
  
  // Resource cleanup
  [Symbol.dispose](): void;
}

// Factory function (preferred)
function createLumenizeClient(config: LumenizeClientConfig): LumenizeClient;
```

### LumenizeClientGateway

```typescript
// Not user-extended - internal implementation
class LumenizeClientGateway extends DurableObject<Env> {
  // WebSocket handlers
  async fetch(request: Request): Promise<Response>;
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void>;
  async alarm(): Promise<void>;
  
  // Mesh RPC entry point - proxies to client
  async __executeOperation(envelope: CallEnvelope): Promise<any>;
}
```

### createLumenizeRouter

```typescript
interface LumenizeRouterConfig {
  authConfig?: {
    publicKeysPem: string[];
    audience?: string;
    issuer?: string;
  };
  gatewayBinding?: string;  // Default: 'LUMENIZE_CLIENT_GATEWAY'
  // ... other mesh defaults
}

// Returns a fetch handler for use in Worker
function createLumenizeRouter(
  env: any,
  config?: LumenizeRouterConfig
): (request: Request) => Promise<Response>;
```

## Implementation Phases

### Phase 0: Rename Package
**Goal**: Rename `@lumenize/lumenize-base` to `@lumenize/mesh`

**Rationale**: 
- All mesh participants (LumenizeDO, LumenizeWorker, LumenizeClient, LumenizeClientGateway) come from the same package
- `@lumenize/mesh` is more intuitive than `@lumenize/lumenize-base`
- Package not yet published, so now is the right time

**Tasks**:
- [ ] Rename directory `packages/lumenize-base/` → `packages/mesh/`
- [ ] Rename file `lumenize-base.ts` → `lumenize-do.ts`
- [ ] Rename class `LumenizeBase` → `LumenizeDO` across codebase
- [ ] Update `package.json` name to `@lumenize/mesh`
- [ ] Update all imports across the monorepo
- [ ] Update TypeDoc config in `website/docusaurus.config.ts`
- [ ] Update sidebar references in `website/sidebars.ts`
- [ ] Merge `website/docs/lumenize-base/` content into `website/docs/lumenize-mesh/`
  - Reconcile the two `index.mdx` files (restructure as needed)
  - Move/integrate LumenizeDO and LumenizeWorker docs

### Phase 1: Design Documentation (Docs-First)
**Goal**: Define user-facing APIs in MDX before implementation

**Deliverables**:
- `website/docs/lumenize-mesh/index.mdx` - Overview, Lumenize Mesh concept
- `website/docs/lumenize-mesh/gateway.mdx` - Gateway behavior, state machine
- `website/docs/lumenize-mesh/client-api.mdx` - LumenizeClient API reference
- `website/docs/lumenize-mesh/auth-integration.mdx` - Token handling patterns

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
- Shared code with LumenizeDO where possible
- Uses refactored WebSocket transport

### Phase 5: Connection Management
**Goal**: Robust connection lifecycle

**Success Criteria**:
- Auto-reconnect with exponential backoff (from generic transport)
- Connection state tracking and callbacks
- Message queuing during reconnection (configurable)
- Clean disconnect handling

### Phase 6: Auth Integration
**Goal**: Seamless token handling via existing @lumenize/auth patterns

**Success Criteria**:
- Token passed via `lmz, lmz.access-token.{jwt}` subprotocol
- `updateAccessToken()` for token refresh
- `onTokenExpiring` callback before expiry
- Gateway stores token in WebSocket attachment for verification
- Authentication info propagated via `this.lmz.callContext` (zero-trust call chain)
- `this.lmz.callContext` available in all method handlers
- Example: Subscription token validation pattern (subscriber provides token, publisher validates)

**Technical Design: Call Context Propagation**

Zero-trust requires every node to verify the original caller's permissions, not just the immediate caller. This is achieved via `this.lmz.callContext`:

```typescript
type CallChainNode = { type, bindingName, instanceNameOrId };

interface CallContext {
  callChain: CallChainNode[];  // [origin, ..., priorCaller, caller]
  callee: CallChainNode;       // This node
  originAuth?: { userId, sessionId, claims };
  
  // Convenience getters (computed from callChain)
  get origin(): CallChainNode;       // callChain[0]
  get caller(): CallChainNode;       // callChain.at(-1)
  get priorCaller(): CallChainNode;  // callChain.at(-2)
}
```

**Implementation approach**:

1. **Envelope carries callContext**: `CallEnvelope.metadata` contains `{ callChain, callee, originAuth }` — exposed via `this.lmz.callContext` with convenience getters
2. **AsyncLocalStorage for race safety**: Multiple concurrent requests to a DO could interleave at `await` points. Use Node.js `AsyncLocalStorage` (supported in Workers since 2023) to isolate each request's context:
   ```typescript
   // In __executeOperation:
   return callContextStorage.run(callContext, async () => {
     return await this.__executeChain(operationChain);
   });
   ```
3. **Automatic propagation in callRaw()**: When making sub-calls, append self to callChain:
   ```typescript
   const currentContext = callContextStorage.getStore();
   const thisNode = { type: this.type, bindingName: this.bindingName, instanceNameOrId: this.instanceNameOrId };
   const metadata = {
     callChain: [...(currentContext?.callChain ?? []), thisNode],
     callee: { type: calleeType, bindingName, instanceNameOrId },
     originAuth: currentContext?.originAuth,  // Propagated from origin!
   };
   ```
4. **Getter on LmzApi**: `this.lmz.callContext` reads from AsyncLocalStorage with convenience getters:
   ```typescript
   get callContext(): CallContext | undefined {
     const ctx = callContextStorage.getStore();
     if (!ctx) return undefined;
     return {
       ...ctx,
       get origin() { return ctx.callChain[0]; },
       get caller() { return ctx.callChain.at(-1); },
       get priorCaller() { return ctx.callChain.at(-2); },
     };
   }
   ```

**Why AsyncLocalStorage**: Without it, if Request A sets `this.lmz.callContext = A`, then awaits, Request B could set `this.lmz.callContext = B`, and when A resumes it would see B's context. AsyncLocalStorage prevents this race condition.

**Why callChain array**: Provides full call history for debugging/auditing, security verification (did call come through expected path?), and circuit detection (prevent infinite loops). Convenience getters (`origin`, `caller`, `priorCaller`) make common cases simple.

**Security: Freeze callContext**: Deep-freeze the callContext when setting it in AsyncLocalStorage to prevent accidental or malicious modification:
```typescript
// In __executeOperation:
const frozenContext = Object.freeze({
  callChain: Object.freeze(callChain.map(n => Object.freeze({...n}))),
  callee: Object.freeze({...callee}),
  originAuth: originAuth ? deepFreeze(originAuth) : undefined,
  get origin() { return this.callChain[0]; },
  get caller() { return this.callChain.at(-1); },
  get priorCaller() { return this.callChain.at(-2); },
});
callContextStorage.run(frozenContext, async () => { ... });
```

**Trust model**: Nodes in the mesh are trusted. The frozen callContext prevents bugs, not malicious nodes. For high-security operations (financial, data deletion), verify `originAuthToken` (signed JWT) independently rather than trusting parsed `originAuth` claims.

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

Reuse from existing packages:

| Component | Source | Reuse |
|-----------|--------|-------|
| OCAN/Continuations | `mesh/src/ocan/` | Direct import |
| CallEnvelope format | `mesh/src/lmz-api.ts` | Shared types |
| WebSocket transport | `rpc/src/websocket-rpc-transport.ts` | **Fork** (~200 lines) |
| Auth middleware | `auth/src/middleware.ts` | Use directly |

### WebSocket Transport: Fork from RPC

**Decision:** Fork the transport code from `@lumenize/rpc` rather than extracting a shared abstraction.

**Rationale:**
- `@lumenize/rpc` is frozen (not deprecated, but not building new things with it)
- Refactoring RPC risks breaking `@lumenize/testing` for no user benefit
- LumenizeClient transport will diverge (mesh envelopes, incoming calls, token refresh)
- ~200 lines of code doesn't warrant an abstraction layer
- Risk/reward is wrong for shared code approach

**What to copy from `rpc/src/websocket-rpc-transport.ts`:**
- Connection lifecycle (`connect()`, `disconnect()`, `isConnected()`)
- Auto-reconnect with exponential backoff
- Keep-alive mode
- Connection state events (`onConnectionChange`, `onClose`)
- WebSocket class injection (for testing)
- Protocol array building (for token/clientId smuggling)

**What to adapt for mesh:**
- Message format: mesh call envelopes instead of RPC batches
- Bidirectional: handle incoming calls, not just responses
- Pending call tracking: by callId, not batchId
- Token refresh: coordinate with `onTokenExpiring` callback

**Location:** New file `mesh/src/websocket-transport.ts`

### New LmzApi for Client

New `createLmzApiForClient()` alongside existing:
- `createLmzApiForDO()` - LumenizeDO
- `createLmzApiForWorker()` - LumenizeWorker
- `createLmzApiForClient()` - LumenizeClient (NEW)

## Package Location

Both LumenizeClientGateway and LumenizeClient in `@lumenize/mesh`:
- Keeps shared types together
- Tree-shaking handles browser vs. server code
- Simpler dependency management

```
packages/mesh/
  src/
    lumenize-do.ts          # Existing (renamed from lumenize-base.ts)
    lumenize-worker.ts      # Existing
    lumenize-client.ts      # NEW
    lumenize-client-gateway.ts  # NEW
    lmz-api.ts             # Add createLmzApiForClient()
    types.ts               # Shared types
```

## Resolved Questions (Phase 1)

1. **LumenizeRouter scope**: ✅ Factory function with smart mesh defaults (auth + gateway routing). Deferred to future work - not blocking for MVP.

2. **Offline queue behavior**: ✅ Decided: `callRaw()` fails immediately when disconnected; `call()` without handler is fire-and-forget. Auto-reconnect handles temporary disconnections.

3. **Gateway alarm storage**: ✅ Alarms use Cloudflare's alarm system, not DO SQLite - no storage charges. Documented in gateway.mdx.

4. **WebSocket attachment storage**: ✅ Attachments stored in Cloudflare's WebSocket infrastructure, not DO SQLite - no storage charges. Documented in gateway.mdx.

## References

- `packages/mesh/src/lmz-api.ts` - Call infrastructure
- `packages/rpc/src/websocket-rpc-transport.ts` - Transport patterns  
- `packages/auth/src/middleware.ts` - Auth middleware
- Memory [[11961810]] - Auth package details

## Archive

Previous task file: `tasks/lumenize-client.md` (outdated, superseded by this document)

