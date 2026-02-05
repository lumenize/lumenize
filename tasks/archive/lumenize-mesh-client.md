# LumenizeClientGateway & LumenizeClient

**Status**: COMPLETE (live performance testing in `tasks/backlog.md`)
**Created**: 2025-12-08
**Design Document**: `/website/docs/mesh/`

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
- **Mesh Overview**: `/website/docs/mesh/index.mdx`
- **Getting Started**: `/website/docs/mesh/getting-started.mdx`
- **LumenizeDO Reference**: `/website/docs/mesh/lumenize-do.mdx`
- **LumenizeWorker Reference**: `/website/docs/mesh/lumenize-worker.mdx`
- **LumenizeClient Reference**: `/website/docs/mesh/lumenize-client.mdx`
- **Gateway Details**: `/website/docs/mesh/gateway.mdx`
- **Authentication Propogation and Access Control**: `/website/docs/mesh/security.mdx`
- **Creating Plugins**: `/website/docs/mesh/creating-plugins.mdx`

**Note**: Documentation was restructured on 2025-12-28. Old `lumenize-base/` docs are archived in `/website/docs/_archived/`.

### Gateway-Client Relationship
- Gateway is 1:1 with a **connection**, not a user
- Same user can have multiple clients (one per tab, multiple browsers, browser+node.js, etc.)
- Client "name" becomes Gateway DO name (e.g., `${sub}.${tabId}` where `sub` is the JWT subject)

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
- [x] Restructure `website/docs/mesh/` with Option D structure (Concepts → Tutorial → References)
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

**0.1 LumenizeDO Lifecycle Hook** (DONE):
- [x] Add `onStart()` lifecycle hook to `LumenizeDO` base class
- [x] Call from base constructor wrapped in `blockConcurrencyWhile`
- [x] Allows async initialization (migrations, setup) without race conditions
- [x] Users should NOT write custom constructors — use `onStart()` instead

**0.2 @lumenize/auth Magic Link Flow Fix** (DONE):
- [x] Add `createAuthRoutes` factory function in `@lumenize/auth`
  - Wraps `routeDORequest` with URL rewriting (`/auth/magic-link` → `/auth/${gatewayBindingName}/${instanceName}/magic-link`)
  - Passes entire `AuthConfig` to `LumenizeAuth.configure()` via lazy init pattern
  - Single `AuthConfig` interface for all options (auth settings + routing options)
- [x] Change `/auth/magic-link` endpoint to return redirect (302) instead of JSON
  - Sets refresh token cookie
  - Redirects to configured `redirect`
  - Access token obtained via refresh-on-load pattern (SPA calls `/auth/refresh-token`)
- [x] Update `/website/docs/auth/index.mdx` — new flow, API reference shows all config options
- [x] Update `/website/docs/mesh/getting-started.mdx` — already uses `createAuthRoutes` correctly

**0.3 @lumenize/auth Rate Limiting Fix** (DONE):
- [x] Refactor rate limiting in `LumenizeAuth` to use instance variables instead of DO storage
  - Uses `#rateLimits: Map<string, { count: number; windowStart: number }>` instance variable
  - Removed `rate_limits` SQL table creation from `#ensureSchema()`
  - Rate limiting is ephemeral; if DO evicts, limits reset (acceptable for low-traffic scenarios)

**0.4 Core Utilities Restructuring** (DONE):
- [x] Merge `sql` utility from `@lumenize/core` into `@lumenize/mesh`
  - `sql` is now built-in to LumenizeDO — always available via `this.svc.sql`
  - No imports needed — just extend `LumenizeDO` and use `this.svc.sql`
  - Type exported from `@lumenize/mesh` for use in other packages (e.g., `@lumenize/alarms`)
  - Standalone usage removed — mesh is a tightly coupled system
- [x] ~~Merge `@lumenize/auth` into `@lumenize/mesh`~~ **REVISED (2025-01-14)**: Keep `@lumenize/auth` as separate package
  - The coupling is minimal: just the `Authorization: Bearer {jwt}` header contract
  - Users with existing auth (Auth0, Clerk, custom) only need to verify and forward the JWT
  - Separation of concerns — auth is a distinct domain from mesh communication
  - See `/website/docs/mesh/security.mdx` for integration details and Auth0 example
- [ ] Publish `@lumenize/debug` as a standalone cross-platform package (deferred to mesh publish)

### Phase 1: Design Documentation (Docs-First)
**Goal**: Define user-facing APIs in MDX before implementation

**Deliverables**: See `/website/docs/mesh/`

**Success Criteria**:
- API design approved by maintainer
- Clear examples for common use cases

### Phase 1.5: CallContext Infrastructure for LumenizeDO/LumenizeWorker
**Goal**: Add `callContext` support to existing mesh nodes before Gateway implementation

**Background**: The Gateway needs to propagate `callContext` between clients and mesh nodes. Before implementing Gateway, we need the infrastructure in LumenizeDO and LumenizeWorker to handle `callContext` in call envelopes.

**CallContext Revision (2025-01-18)**:

The current `CallContext` interface uses `caller` for immediate caller and doesn't track the full call chain. Per discussion, we're renaming to make the call chain explicit:

**Before** (current docs):
```typescript
interface CallContext {
  origin: NodeIdentity;      // Original caller at chain start
  originAuth?: AuthClaims;   // Verified JWT claims from origin
  caller: NodeIdentity;      // Immediate caller (per-hop)
  callee: NodeIdentity;      // This node (per-hop)
  state: Record<string, any>; // Mutable hook data
}
```

**After** (revised):
```typescript
interface NodeIdentity {
  type: 'LumenizeDO' | 'LumenizeWorker' | 'LumenizeClient';
  bindingName: string;
  instanceName?: string;  // undefined for Workers
}

interface CallContext {
  origin: NodeIdentity;           // Original caller at chain start (immutable)
  originAuth?: {                  // Verified JWT claims from origin (immutable)
    sub: string;                  // JWT subject (RFC 7519)
    claims?: Record<string, any>;
  };
  callChain: NodeIdentity[];      // Full chain: [origin, hop1, hop2, ..., immediateCallerBeforeThis]
                                  // Last element is immediate caller. Empty if origin is calling directly.
  state: Record<string, any>;     // Mutable, starts as {}, propagates and accumulates
}

interface CallOptions {
  newChain?: boolean;             // Start fresh callContext (default: false, inherits current)
  state?: Record<string, any>;    // Initial/additional state (merged with inherited state, or used as initial if newChain)
}
```

**Key changes**:
- `caller` → `callChain` (array) — provides full tracing without needing `state.spans`
- Removed `callee` — redundant, just use `this.lmz.bindingName`/`instanceName`
- Removed `priorCaller` — subsumed by `callChain` array
- Immediate caller is `callChain[callChain.length - 1]` (or `origin` if `callChain` is empty)
- Gateway is NOT in `callChain` — it's an implementation detail; calls appear to come from LumenizeClient directly
- Added `CallOptions.state` for providing initial/additional state when making calls

**Helper getter** (convenience):
```typescript
// In LmzApi
get caller(): NodeIdentity {
  return this.callContext.callChain.length > 0
    ? this.callContext.callChain[this.callContext.callChain.length - 1]
    : this.callContext.origin;
}
```

**Tasks**:

**1.5.1 Add CallContext Types** (DONE):
- [x] Add `NodeIdentity` interface to `@lumenize/mesh/types.ts`
- [x] Add `CallContext` interface to `@lumenize/mesh/types.ts`
- [x] Export from `@lumenize/mesh/index.ts`

**1.5.2 Extend CallEnvelope** (DONE):
- [x] Add `callContext: CallContext` to `CallEnvelope` interface in `lmz-api.ts`
- [x] Update `callRaw()` to include `callContext` in envelope
- [x] When building envelope, append current node to `callChain`

**1.5.3 Add AsyncLocalStorage for CallContext** (DONE):
- [x] Create `callContextStorage` (AsyncLocalStorage instance) in `lmz-api.ts`
- [x] Add `callContext` getter to `LmzApi` interface that reads from ALS
- [x] Add `caller` convenience getter to `LmzApi`

**1.5.4 Update __executeOperation in LumenizeDO** (DONE):
- [x] Extract `callContext` from envelope
- [x] Set up ALS context before executing chain
- [x] Require `callContext` in envelope (no backwards compat needed - mesh not yet released)

**1.5.5 Update __executeOperation in LumenizeWorker** (DONE):
- [x] Same as LumenizeDO

**1.5.6 Capture CallContext in Continuations** (DONE):
- [x] Deep clone callContext at capture time in `lmz.call()` via `captureCallContext()` in `lmz-api.ts`
- [x] Restore captured context when executing handlers via `runWithCallContext()`
- [x] Ensures `this.lmz.callContext` works in continuation handlers even with interleaved calls

**1.5.7 Add onBeforeCall Hook** (DONE):
- [x] Add `onBeforeCall()` method to `LumenizeDO` base class (default: no-op, calls `super.onBeforeCall()`)
- [x] Add `onBeforeCall()` method to `LumenizeWorker` base class
- [x] Call `onBeforeCall()` in `__executeOperation` before executing chain
- [x] Users override to add authentication checks, populate `state`, etc.

**1.5.8 Add @mesh Decorator** (DONE):
- [x] Create `mesh` decorator function in `@lumenize/mesh`
- [x] Decorator marks methods as mesh-callable (sets metadata on method)
- [x] Optional guard function: `@mesh.guard((instance) => { /* throw to reject */ })`
- [x] Update `executeOperationChain()` to check for `@mesh` marker on entry point method

**1.5.9 Update Documentation** (DONE):
- [x] Update `mesh-api.mdx` with revised `CallContext` interface
- [x] Update `managing-context.mdx` to reflect `callChain` instead of `caller`
- [x] Update tracing example to use `callChain` directly instead of manual `state.spans`
- [x] Update `security.mdx` examples that reference `caller`
- [x] Update `gateway.mdx` to document `connection_status` message purpose

**1.5.10 Tests** (DONE):
- [x] Test `callContext` propagation across DO→DO calls
- [x] Test `callContext` propagation across DO→Worker→DO calls
- [x] Test `callChain` accumulates correctly through multi-hop calls
- [x] Test `state` mutations propagate and accumulate
- [x] Test `onBeforeCall` hook is called
- [x] Test `@mesh` decorator blocks non-decorated methods
- [x] Test `@mesh.guard()` functions work
- [x] Test `callContext` is restored in continuation handlers

### Phase 2: LumenizeClientGateway Implementation (COMPLETE)
**Goal**: Zero-storage DO that proxies between mesh and WebSocket client

**Success Criteria**:
- [x] Extends DurableObject directly (not LumenizeDO)
- [x] NO storage operations - state from getWebSockets() + getAlarm() only
- [x] WebSocket attachments for connection metadata
- [x] 5-second grace period on disconnect (via alarm)
- [x] `__executeOperation()` forwards to client and returns response
- [x] Incoming mesh calls handled when client connected
- [x] Graceful handling when client disconnected (grace period waiting)

**Implementation Details**:
- Created `packages/mesh/src/lumenize-client-gateway.ts`
- Added `ClientDisconnectedError` (registered with structured-clone for proper serialization)
- Added `GatewayMessageType` constants for wire protocol
- Gateway builds `callContext.origin` and `originAuth` from WebSocket attachment (verified sources)
- Gateway passes `callChain` and `state` from client (trusted for tracing)
- Tests in `packages/mesh/test/lumenize-client-gateway.test.ts`

### Phase 3: WebSocket Transport (SKIPPED - merged into Phase 4)
**Goal**: ~~Create mesh-specific WebSocket transport by forking from RPC~~

**Decision**: After implementing Phase 2, we realized the transport is inherently part of the client implementation. The original plan to fork `websocket-rpc-transport.ts` as a separate step doesn't make sense - the transport patterns will be borrowed and adapted as we build LumenizeClient. Phase 1.5 already handled the call execution upgrades (callContext, OCAN fork) that keep RPC compatible.

### Phase 4: LumenizeClient Core (COMPLETE)
**Goal**: Browser-side mesh participant with call infrastructure

**Implementation**: `packages/mesh/src/lumenize-client.ts` (951 lines)

**Success Criteria**:
- [x] `this.lmz.callRaw()` working through Gateway (lines 878-923)
- [x] `this.lmz.call()` with continuation support (lines 925-950)
- [x] `this.ctn()` for building operation chains (lines 378-382)
- [x] **Instant Connect**: Connection established immediately upon instantiation (lines 317-318)
- [x] Shared code with LumenizeDO where possible
- [x] Borrowed patterns from Lumenize RPC's websocket-transport

### Phase 5: Connection Management (COMPLETE)
**Goal**: Robust connection lifecycle

**Implementation**: Same file (lumenize-client.ts)

**Success Criteria**:
- [x] Auto-reconnect with exponential backoff (lines 609-623, 1s→30s max)
- [x] **Wake-up Sensing**: Tab visibility (line 631), window focus (line 643), system online (line 655)
- [x] Connection state tracking and callbacks (lines 328-330, 667-672)
- [x] Message queuing during reconnection (lines 832-872, max 100 messages, 30s timeout)
- [x] Clean disconnect handling

### Phase 6: Auth & Call Context (COMPLETE)
**Goal**: Seamless token handling and zero-trust call context propagation

**Implementation**: lumenize-client.ts + lumenize-client-gateway.ts

**Success Criteria**:
- [x] Token passed via `lmz, lmz.access-token.{jwt}` subprotocol (lines 502-505)
- [x] Gateway stores token in WebSocket attachment for verification (gateway lines 302-308)
- [x] `this.lmz.callContext` available in all method handlers (lines 350-358, 786-794)
- [x] `callContext` automatically preserved across hibernation (lmz-api.ts captureCallContext)

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

7. **Login Required Handling**:
   - `onLoginRequired` fires when refresh token fails (HTTP 401) — user must re-login
   - Access token expiration (4401) is handled automatically via refresh and reconnect
   - Separate from `onConnectionError` which handles network-level WebSocket errors
   - Developer handles redirect to login in their `onLoginRequired` callback

### Phase 7: Client-to-Client Communication (COMPLETE)
**Goal**: Enable LumenizeClient → LumenizeClient calls

**Implementation**: Gateway `__executeOperation()` (lines 442-500) + client `#handleIncomingCall()` (lines 773-820)

**Success Criteria**:
- [x] Client A → Gateway A → Gateway B → Client B working (gateway forwards, client receives)
- [x] Error handling for disconnected target client (ClientDisconnectedError, grace period)
- [ ] Round-trip latency acceptable (~60ms target) — needs live profiling

### Phase 8: Testing & Documentation Validation (MOSTLY COMPLETE)
**Goal**: Comprehensive test coverage

**Test Files**:
- `packages/mesh/test/lumenize-client.test.ts` (550 lines) - unit tests
- `packages/mesh/test/lumenize-client-gateway.test.ts` - gateway tests
- `packages/mesh/test/for-docs/mesh/getting-started.test.ts` (134 lines) - integration

**Success Criteria**:
- [x] Client → Gateway → DO integration tests
- [x] DO → Gateway → Client downstream tests
- [x] Client → Client via Gateways tests (getting-started.test.ts)
- [x] Reconnection scenario tests
- [x] Auth flow tests
- [x] `test/for-docs/` examples
- [x] `@check-example` annotations pass — 99/99 verified

## Code Sharing Strategy

| Component | Source | Reuse |
|-----------|--------|-------|
| OCAN/Continuations | `mesh/src/ocan/` | Direct import |
| CallEnvelope format | `mesh/src/lmz-api.ts` | Shared types |
| WebSocket transport | `rpc/src/websocket-rpc-transport.ts` | **Fork** (~200 lines) |
| Auth hooks | `mesh/src/auth/` | Direct import (merged from packages/auth) |

### WebSocket Transport: Learn and borrow from Lumenize RPC's websocket-transport

**Decision:** Don't modify any dependencies of Lumenize RPC. Rather, copy.

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
    sub: payload.sub,
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
      sub: attachment.sub,                  // From JWT
      claims: attachment.claims,            // From JWT
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
  // Returns enhanced request with Authorization: Bearer {verified-jwt} header
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

// 3. Identity Validation (Gateway decodes JWT and validates sub matches instance name)
async fetch(request: Request) {
  // Gateway decodes JWT from Authorization: Bearer header to extract sub
  const sub = /* decoded from JWT payload */ '';
  const instanceSub = instanceName.substring(0, instanceName.indexOf('.'));

  if (sub && instanceSub && sub !== instanceSub) {
    return new Response('Forbidden: identity mismatch', { status: 403 });
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

### Verified ✅

- [x] (vitest-pool) Trusted return capability security model allows you to return an interface for just admins. Similarly, it should not allow the use of root-level methods without an @mesh decorator in nested conditions. For example, `multiply(subtract(4, 3), add(2, 1))` should only work if `multiply`, `subtract`, and `add` all have @mesh annotations that allow them. **VERIFIED**: `test/call-context.test.ts` - "@mesh decorator security > blocks calls to methods without @mesh decorator"
- [x] (vitest-pool) lmz.callContext has the correct information even when there are deeply interleaved operations ongoing (ALS isolation). **VERIFIED**: `test/call-context.test.ts` - "ALS isolation for concurrent calls > concurrent calls have isolated callContext (no cross-contamination)"
- [x] (vitest-pool) Verify that `callContext` is automatically captured in continuations and each interleaved handler gets its own captured context (not a shared/mutated one). **VERIFIED**: `test/call-context.test.ts` - "CallContext capture in continuation handlers (Phase 1.5.6) > interleaved lmz.call() handlers each get their own captured context". Note: Handlers are in-memory Promise callbacks and will be lost on hibernation/eviction - this is inherent to the pattern. For hibernation-safe patterns, see docs.
- [x] (vitest-pool) Verify that `callContext.state` modifications in DO2 are visible in DO1's continuation after the call returns. **VERIFIED**: `test/call-context.test.ts` - "State propagation > state modifications propagate to downstream calls"
- [x] LumenizeDO and LumenizeWorker are upgraded to support the new access control model **DONE**: Both use `requireMeshDecorator: true` and support `@mesh` decorator, `onBeforeCall()` hook, and full `CallContext` propagation
- [x] (code review) Message queueing implemented: `lumenize-client.ts` lines 832-872 - queues up to 100 messages, 30s timeout for callRaw, flushes on `connection_status` receipt
- [x] (code review) Gateway builds verified callContext from WebSocket attachment (not from client message): `lumenize-client-gateway.ts` lines 509-550 - uses `attachment.sub`, `attachment.claims` from verified JWT
- [x] (code review) Token refresh before onLoginRequired: `lumenize-client.ts` lines 586-602 (`#handleTokenExpired`) calls `#refreshToken()` before reconnect; only fires `onLoginRequired` on 401 from refresh endpoint
- [x] (search and review) `blockConcurrencyWhile` is not used by call. I mistakenly did that for the current implementation because I didn't realize we could get fire and forget behavior with simple use of Promise/then/catch
- [x] (vitest-pool) When you do a call where you want the result handler to be called right after the await returns that it does not require the handler to have an @mesh annotation. However, in a two one-way call situation, the final callback would need to have an @mesh decorator. **VERIFIED**: `packages/mesh/test/for-docs/calls/index.test.ts` 
- [x] "handler without @mesh: local handlers work without @mesh decorator"
- [x] calls to `client.myMethod` don't go through access control checks. We want to be able to call them from browser-based code.
- [x] (vitest-pool) `this.lmz.callContext` is automatically restored for continuations (no manual capture needed) even when there is a round-trip remote call. **VERIFIED**: `packages/mesh/test/for-docs/calls/index.test.ts` - "context preservation: callContext available in handlers after remote call"
- [x] (vitest-pool) Verify `{ newChain: true }` option in `lmz.call()` starts a fresh call chain with new `callContext` (origin becomes the calling node, state is empty, no inherited originAuth). **VERIFIED**: `packages/mesh/test/for-docs/calls/index.test.ts` - "newChain: true breaks call chain so recipients see DO as origin"
- [x] (vitest-pool) Custom error classes registered on globalThis preserve their type across the mesh. **VERIFIED**: `packages/mesh/test/for-docs/calls/index.test.ts` - "operation chaining: non-admin gets AdminAccessError with preserved type"
- [x] (vitest-pool) Two one-way calls pattern (DO→Worker→DO) works correctly for avoiding wall-clock billing. **VERIFIED**: `packages/mesh/test/for-docs/calls/index.test.ts` - "two one-way calls: DO→Worker→DO avoids wall-clock billing"
### Pending Verification ⏳

- [x] (vitest-pool) Verify manual persistence pattern from `managing-context.mdx` works: `getOperationChain()` + `this.lmz.callContext` can be stored to `ctx.storage.kv` and later restored/executed. **VERIFIED**: `packages/mesh/test/for-docs/calls/index.test.ts` - "manual persistence: store and execute continuation with context". Converted to `@check-example`. See `backlog.md` for ergonomic improvements discovered during implementation.
- [x] (vitest-pool) Round trip between two clients. Clients can be on same machine but the call will go up into Cloudflare hop from one Gateway to the next, then back down. **VERIFIED**: getting-started test (`packages/mesh/test/for-docs/getting-started/index.test.ts`) covers Client→DO→Client (broadcast) and Client→Worker→Client (direct delivery) with Alice and Bob as two separate EditorClient instances. Security test (`packages/mesh/test/for-docs/security/index.test.ts`) covers Alice+Bob+Carol three-client scenario. Direct Client→Client peer calls via `onBeforeCall` override are a separate post-MVP feature.
- [x] (vitest-pool) CORS with an allowlist blocks WebSocket upgrades from disallowed origins. **VERIFIED**: `packages/mesh/test/for-docs/security/index.test.ts` — "CORS allowlist rejects WebSocket upgrade from disallowed origin". Security Worker configured with `cors: { origin: ['https://localhost'] }`. Test verifies: evil origin → 403 "Forbidden: Origin not allowed" (before auth hooks or Gateway), allowed origin → not 403.
- [ ] (live) Performance of various patterns for remote calls for both fire-and-forget as well as for ones where it actually awaits. Consider always making it two one-way calls but only after live testing. **DEFERRED**: Requires deployment.
- [x] (review and vitest-pool) Clients must be authenticated (verify auth hooks are enforced). **VERIFIED**: Gateway rejects connections without `Authorization: Bearer` header (`lumenize-client-gateway.ts:243`), validates JWT `sub` matches instance name prefix (`lumenize-client-gateway.ts:294`). Test coverage in `test/lumenize-client-gateway.test.ts` (lines 41-85: missing auth → 401, identity mismatch → 403, valid → 101) and `test/for-docs/security/index.test.ts` (Worker rejects forged JWT with 401).
- [x] (review) That we don't have lots of duplication in implementations of execute continuations and call including when packages/fetch and packages/alarms are used. Maybe they need to be different accross LumenizeDO, LumenizeWorker, and LumenizeClient (although reuse would be ideal), but fetch and alarms probably shouldn't have their own.
- [x] Messages are queued when the client is in a reconnection grace period with various timing scenarios (tab wake, immediate send, etc.). **VERIFIED** (code review): `lumenize-client.ts` lines 832-872 implement message queuing (max 100 messages, 30s timeout for callRaw). Queue flushed on `connection_status` receipt (lines 862-872). Tab wake sensing (lines 625-665) triggers immediate reconnect with backoff reset. Timing scenarios: (1) tab wake → visibilitychange listener resets backoff, calls connectInternal immediately; (2) immediate send while disconnected → queued with 30s timeout; (3) queue overflow → rejected with "Message queue full" error.

## References

- Design docs: `/website/docs/mesh/`
- `packages/rpc/src/websocket-rpc-transport.ts` - Transport patterns
- `packages/mesh/src/auth/` - Auth hooks (after merge from packages/auth)
