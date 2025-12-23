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
- **Client API**: `/website/docs/lumenize-mesh/client-api.mdx`
- **Gateway Details**: `/website/docs/lumenize-mesh/gateway.mdx`
- **Auth Integration**: `/website/docs/lumenize-mesh/auth-integration.mdx`

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
Unlike LumenizeDO/LumenizeWorker which execute chains on `this`, Gateway forwards chains to the client over WebSocket and returns the response.

### `this.lmz.call` Security Model

**Problem**: The current OCAN execution allows arbitrary property traversal. A malicious chain like `this.ctn().ctx.storage.kv.get('secret')` would access internal state.

**Solution**: Defense-in-depth with a **secure-by-default** model (explicit opt-in):

1. **Capability-Based Trust (Automatic)**
   - The **first** method in an RPC chain must be authorized via `@mesh` or `@mesh(handler)`.
   - Once authorized, the caller is granted access to the **entire public interface** (methods and properties) of the returned object for the duration of that continuation chain.
   - **Important Nuance**: In **nesting** (e.g., `multiply(add(1, 2), 10)`), every method called on `this` (`multiply` and `add`) must have an `@mesh` decorator. In **chaining** (e.g., `getPanel().reset()`), only the first method (`getPanel`) needs `@mesh`.
   - **True Privacy**: Use `#private` for actual security. Convention-based `_` or `__` methods are public in JavaScript and will be accessible if an object is returned.

2. **Class-level `onBeforeCall(callContext)` hook**
   - Override in your class for class-wide policies.
   - WHO can call: authentication, audit logging, rate limiting.
   - LumenizeClient default: reject peer calls from other LumenizeClients.

3. **Method Exposure (@mesh) — Entry Point Only**
   - Mandatory opt-in for the **first** method in an RPC chain.
   - Subsequent methods in a chain (fluent APIs) are trusted as "authorized returns" from the first call.
   - **Exception**: Methods used as local callbacks (handlers) in a continuation authored by the node itself do not require `@mesh` because they are part of a trusted continuation chain.

**Execution Flow**:
```
Class onBeforeCall → Entry Point Check (@mesh) → Execute Chain (Trusted Returns)
```

**Implementation Notes**:
- Use a decorator to mark methods as mesh-callable.
- `executeOperationChain()` checks for this marker before execution.
- Blocked names stored in `Set` for O(1) lookup.
- Decorator metadata stored via `Reflect.defineMetadata()`.

## Implementation Phases

### Phase 0: Rename Package
**Goal**: Rename `@lumenize/lumenize-base` to `@lumenize/mesh`

**Tasks**:
- [ ] Rename directory `packages/lumenize-base/` → `packages/mesh/`
- [ ] Rename file `lumenize-base.ts` → `lumenize-do.ts`
- [ ] Rename class `LumenizeBase` → `LumenizeDO` across codebase
- [ ] Update `package.json` name to `@lumenize/mesh`
- [ ] Update all imports across the monorepo
- [ ] Update TypeDoc config in `website/docusaurus.config.ts`
- [ ] Update sidebar references in `website/sidebars.ts`
- [ ] Merge `website/docs/lumenize-base/` content into `website/docs/lumenize-mesh/`

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
- Shared code with LumenizeDO where possible
- Uses refactored WebSocket transport

### Phase 5: Connection Management
**Goal**: Robust connection lifecycle

**Success Criteria**:
- Auto-reconnect with exponential backoff (from generic transport)
- Connection state tracking and callbacks
- Message queuing during reconnection (configurable)
- Clean disconnect handling

### Phase 6: Auth & Call Context
**Goal**: Seamless token handling and zero-trust call context propagation

**Success Criteria**:
- Token passed via `lmz, lmz.access-token.{jwt}` subprotocol
- Gateway stores token in WebSocket attachment for verification
- `this.lmz.callContext` available in all method handlers (see auth-integration.mdx)

**Implementation Notes** (not in user docs):

1. **AsyncLocalStorage for race safety**: Use Node.js `AsyncLocalStorage` (supported in Workers since 2023) to isolate each request's context across calls.

2. **Freeze callContext**: Deep-freeze the callContext when setting it to prevent accidental modification:
   ```typescript
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

3. **Trust model**: Nodes in the mesh are trusted. Freezing prevents bugs, not malicious nodes. For high-security operations, verify `originAuthToken` (signed JWT) independently.

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
| Auth middleware | `auth/src/middleware.ts` | Use directly |

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

1. **LumenizeRouter scope**: Factory function with smart mesh defaults. Deferred - not blocking for MVP.

2. **Offline queue behavior**: `callRaw()` fails immediately when disconnected; `call()` without handler is fire-and-forget.

3. **Gateway alarm/attachment storage**: Both use Cloudflare infrastructure, not DO SQLite - no storage charges.

## Confirm with Code Review, vitest-pool-workers Testing, or Live Testing

- [ ] (live) Round trip between two clients. Clients can be on same machine but the call will go up into Cloudflare hop from one Gateway to the next, then back down.
- [ ] (search and review) `blockConcurrency` is not used by call. I mistakenly did that for the current implementation because I didn't realize we could get fire and forget behavior with simple use of Promise/then/catch
- [ ] (vitest-pool) CORS with a whitelist blocks even for calls with no preflight
- [ ] (review) Malicious user can't control the callContext contents from a LumenizeClient. It must be determined at the Gateway
- [ ] (vitest-pool) `this.lmz.callContext` is the same for continuations as for the original call even when there is a round-trip remote call.
- [ ] (live) Performance of various patterns for remote calls for both fire-and-forget as well as for ones where it actually awaits. Consider always making it two one-way calls but only after live testing.
- [ ] (review and vitest-pool) Clients must be authenticated
- [ ] (vitest-pool) Trusted return capability security model allows you to return an interface for just admins. Similarly, it should not allow the use of root-level methods without an @mesh decorator in nested conditions. For example, `multiply(subtract(4, 3), add(2, 1))` should only work if `multiply`, `subtract`, and `add` all have @mesh annotations that allow them.
- [ ] (vitest-pool) lmz.callContext is has the correct information even when there is deeply interlieved operations ongoing.
- [ ] (vitest-pool) Verify that `callContext` is fully serializable and can be captured in a continuation to survive DO hibernation.

## References

- Design docs: `/website/docs/lumenize-mesh/`
- `packages/rpc/src/websocket-rpc-transport.ts` - Transport patterns  
- `packages/auth/src/middleware.ts` - Auth middleware
