# Nebula Baseline Access Control

**Phase**: 2
**Status**: Pending
**App**: `apps/nebula/` (new app workspace created in this phase — not published to npm)
**Depends on**: Phase 1.7 (Mesh Gateway Fix)
**Master task file**: `tasks/nebula.md`

## Goal

Create `apps/nebula/` with three DO classes (`NebulaDO` base, `OrgDO`, `ResourceHistoryDO`), `NebulaClientGateway` (extends `LumenizeClientGateway` hooks), `NebulaClient`, and the Worker entrypoint. Build a four-layer security model: entrypoint scope verification, Gateway star-scoping via `callContext.universeGalaxyStarId`, NebulaDO's `onBeforeCall` starId binding, and `@mesh(guard)` per-method authorization. Validate with dummy methods and abuse case testing through e2e tests using NebulaClient.

Much of what we build here will be replaced in Phase 3 (DAG tree) and Phase 5 (Resources), especially the tests and dummy methods.

The primary goals of this phase are:
1. Verify that nebula-auth's JWT format works with the Nebula Mesh components, especially `callContext`
2. Prove the starId binding mechanism — permanently locking each DO instance to its creating star
3. Establish the security layering pattern that all future phases build on

## Open Questions

### Move active scope into the JWT (eliminate `~`-delimited instanceName)

**Idea:** Instead of encoding the active scope in the Gateway instanceName (`sub~starId~tabId`), put it in the JWT itself. The refresh endpoint would accept a `scope` query param; the server validates the requested scope is covered by the user's `access` pattern, then mints the access token with the active scope baked in.

**Where to put it — two options:**

1. **`aud` claim (standard)** — Per RFC 7519, `aud` identifies the intended recipient of the token. The active universeGalaxyStarId IS the intended recipient ("this token is for the `.crm` service"). This is semantically correct and enables standard JWT `aud` validation. However, `aud` is a generic string/array — its meaning as a universeGalaxyStarId is implicit, which may be unclear to developers reading the JWT.

2. **Custom `scope` claim** — A custom claim like `activeScope: "george-solopreneur.crm"` is explicit and self-documenting. No ambiguity about what it represents. Trade-off: doesn't participate in standard JWT `aud` validation, so scope checking must be done manually (which we'd do anyway in `onBeforeAccept`). Could use both — `aud` for standard validation + `activeScope` for readability — but that's redundant.

**Impact if adopted (same regardless of `aud` vs custom claim):**
- **instanceName goes back to standard** `${sub}.${tabId}` (Lumenize Mesh default). No more `~`-delimited format, no custom parsing in `onBeforeAccept`, no injection surface from delimiter handling.
- **Refresh endpoint** (`POST {prefix}/{authScope}/refresh-token`) gains a `?scope=` param. Server checks `matchAccess(jwt.access.id, requestedScope)` before minting.
- **NebulaClientGateway simplifies** — `onBeforeAccept` reads the active scope from JWT claims (already auto-included after Phase 1.7) instead of parsing it from instanceName. `onBeforeCallToMesh` stamps it as `universeGalaxyStarId`.
- **Entrypoint simplifies** — `onBeforeConnect` checks the JWT's active scope matches the requested scope instead of parsing `~` from the instanceName.
- **Access token is single-scope** — switching active scope requires a new access token (refresh call with different `?scope=`). The refresh token stays multi-scope. Each tab can hold a different access token for a different scope, which is arguably more secure.
- **Might warrant a Phase 1.8** in nebula-auth (token minting change + refresh endpoint change) before this Phase 2 work begins.

**Learning opportunity:** Audit all standard JWT registered claims (`iss`, `sub`, `aud`, `exp`, `nbf`, `iat`, `jti`) against current usage. Are there other fields we're hardcoding or ignoring that could carry meaning? For example: `nbf` (not before) could enforce a delay on freshly-minted tokens if needed; `iss` could distinguish which NebulaAuth DO instance minted the token (it may already do this).

**Decision:** TBD — resolve before implementing the `~`-delimited instanceName logic in this phase. If adopted, several sections below change significantly. Sub-decisions: (1) adopt active-scope-in-JWT at all, (2) if yes, `aud` vs custom claim vs both.

---

## Architecture

### App Layout

```
apps/nebula/
├── package.json                    # "private": true — never published
├── src/
│   ├── index.ts                    # Public exports (for sibling package imports)
│   ├── entrypoint.ts               # Worker default export (scope check + routing)
│   ├── nebula-client-gateway.ts    # Extends LumenizeClientGateway (star-scoped)
│   ├── nebula-do.ts                # NebulaDO base class (starId binding)
│   ├── org-do.ts                   # OrgDO extends NebulaDO (singleton per star)
│   ├── resource-history-do.ts      # ResourceHistoryDO extends NebulaDO (UUID instanceName)
│   ├── nebula-client.ts            # NebulaClient extends LumenizeClient
│   └── types.ts                    # NebulaCallContext, shared types
├── test/
│   ├── wrangler.jsonc              # DO bindings for all classes (including test subclasses)
│   ├── vitest.config.js
│   ├── test-worker-and-dos.ts      # Test harness with OrgDOTest subclass (adds callClientOnGateway)
│   ├── star-binding.test.ts        # StarId binding + cross-star rejection
│   ├── scope-verification.test.ts  # Entrypoint scope check + admin scope switching
│   ├── guards.test.ts              # Admin-only methods, guard rejection
│   └── gateway-abuse.test.ts       # InstanceName injection, DO→client, direct HTTP, token expiry
└── README.md
```

### Communication

All application communication uses `lmz.call()`. Transport (WebSocket from client, Workers RPC between DOs) is an implementation detail handled by the underlying Lumenize Mesh — Nebula code never references it directly.

### Security Layers

Four layers, from outermost to innermost:

| Layer | Where | What it checks |
|-------|-------|----------------|
| **Entrypoint** | `onBeforeConnect` hook in `routeDORequest` | `matchAccess(jwt.access.id, starId)` — fully verifies JWT, rejects before any DO is instantiated |
| **NebulaClientGateway** | extends Gateway hooks | `onBeforeAccept`: validates `~`-delimited instanceName, extracts starId as claim. `onBeforeCallToMesh`: stamps starId onto callContext. `onBeforeCallToClient`: rejects calls whose callContext starId doesn't match the connected client's claim |
| **NebulaDO.onBeforeCall()** | base class | Stores starId on first call, throws on mismatch — every Nebula DO gets this |
| **`@mesh(guard)`** | subclass methods | Per-method authorization (requireAdmin, allowlist, etc.) |

### Entrypoint (`entrypoint.ts`)

The Worker `default export` — not a class, just a `{ fetch() }` router. Composes two routers using the established fallthrough pattern (each returns `undefined` for non-matching paths):

1. `routeNebulaAuthRequest` (from `@lumenize/nebula-auth`) for auth routes (login, refresh, invite). Returns `undefined` when the path doesn't match `/auth/` — see Sub-task 0 prerequisite.
2. `routeDORequest` (from `@lumenize/routing`) for all DO bindings (Gateway and non-Gateway). Returns `undefined` when the path doesn't match any binding. **Scope verification** for Gateway connections uses the `onBeforeConnect` hook — this hook only fires for WebSocket upgrades, which only target the Gateway.

```typescript
import { routeNebulaAuthRequest } from '@lumenize/nebula-auth';
import { routeDORequest } from '@lumenize/routing';

export default {
  async fetch(request: Request, env: Env) {
    // Auth routes (login, refresh, invite, etc.)
    // Returns undefined for non-auth paths (fallthrough pattern)
    const authResponse = await routeNebulaAuthRequest(request, env);
    if (authResponse) return authResponse;

    // DO routing (Gateway + all other DO bindings)
    // onBeforeConnect: fully verifies JWT and checks scope covers the requested star
    // Returns undefined if path doesn't match any binding
    const doResponse = await routeDORequest(request, env, {
      async onBeforeConnect(request, { doInstanceNameOrId }) {
        // doInstanceNameOrId = "sub~universeGalaxyStarId~tabId"
        const segments = doInstanceNameOrId.split('~');
        if (segments.length !== 3) {
          return new Response('Forbidden: invalid Gateway instance name', { status: 403 });
        }
        const [, starId] = segments;
        // Full JWT verification (signature check, not just parse)
        const jwt = await verifyJwt(request, env.PRIMARY_JWT_KEY);
        if (!jwt || !matchAccess(jwt.access.id, starId)) {
          return new Response('Forbidden: JWT scope does not cover this star', { status: 403 });
        }
      },
    });
    if (doResponse) return doResponse;

    return new Response('Not Found', { status: 404 });
  }
}
```

`routeDORequest` handles both WebSocket upgrades and regular HTTP. Direct HTTP to NebulaDO subclasses is safe: `onRequest` is an optional method on `LumenizeDO` — when not defined, the `fetch()` handler returns 501 ("Not Implemented: override onRequest() to handle HTTP requests"). Additionally, `onBeforeCall` rejects any mesh call missing `universeGalaxyStarId`, which direct HTTP never carries. Phase 5 uses `onRequest()` for real HTTP routing in Resources.

### NebulaClientGateway (`nebula-client-gateway.ts`)

Extends `LumenizeClientGateway` using the hooks from `tasks/mesh-extensibility.md`. ~50 lines of overrides instead of an ~800 line fork.

**Hook overrides from LumenizeClientGateway:**

1. **`onBeforeAccept` — instance name validation + additional claims**: The base `LumenizeClientGateway.onBeforeAccept` validates a `.`-delimited `{sub}.{tabId}` format. Nebula overrides this because `universeGalaxyStarId` is itself dot-segmented (e.g., `acme.app.tenant-a`), so we use `~` as the delimiter instead: `${sub}~${universeGalaxyStarId}~${tabId}`. Parses on `~`, verifies three segments, checks sub matches JWT. Returns `{ universeGalaxyStarId: segments[1] }` as additional claims — the base class auto-includes all JWT payload fields (including `access`, `email`, etc.), so the override only needs to add Nebula-specific fields.

2. **`onBeforeCallToMesh` — callContext enrichment (client → DO)**: Adds `universeGalaxyStarId` as a top-level field on `callContext` (not in `state`, which is mutable). Like `callChain` and `originAuth`, top-level fields are immutable by convention — no DO along the call chain should modify them:

```typescript
override onBeforeCallToMesh(baseContext: CallContext, connectionInfo: GatewayConnectionInfo): NebulaCallContext {
  return {
    ...baseContext,
    universeGalaxyStarId: connectionInfo.claims?.universeGalaxyStarId as string,
  };
}
```

3. **`onBeforeCallToClient` — star verification (DO → client)**: In Lumenize Mesh, clients are full peers — DOs can call methods on clients, not just the reverse. When a DO sends a call that the Gateway needs to forward to a client, the hook compares the envelope's `callContext.universeGalaxyStarId` against `connectionInfo.claims.universeGalaxyStarId`. Rejects on mismatch. This check must live in the Gateway (server-side trust boundary), not in NebulaClient, because the client is within the end-user's control.

```typescript
override onBeforeCallToClient(envelope: CallEnvelope, connectionInfo: GatewayConnectionInfo): void {
  const ctx = envelope.callContext as NebulaCallContext | undefined;
  if (ctx?.universeGalaxyStarId !== connectionInfo.claims?.universeGalaxyStarId) {
    throw new Error('Star scope mismatch on call to client');
  }
}
```

### NebulaDO (`nebula-do.ts`)

Base class for all Nebula DOs. `onBeforeCall()` is reserved for this class — subclasses use `@mesh(guard)` for method-level authorization. If a subclass ever needs to extend `onBeforeCall`, it calls `super.onBeforeCall()` first.

```typescript
export class NebulaDO extends LumenizeDO {
  onBeforeCall() {
    const ctx = this.lmz.callContext as NebulaCallContext;
    const starId = ctx.universeGalaxyStarId;

    // Reject calls that didn't come through NebulaClientGateway
    if (!starId) {
      throw new Error('Missing universeGalaxyStarId in callContext');
    }

    // Store on first call, throw on mismatch
    const stored = this.ctx.storage.kv.get<string>('__nebula_star_id');
    if (!stored) {
      this.ctx.storage.kv.put('__nebula_star_id', starId);
    } else if (stored !== starId) {
      throw new Error('Star scope mismatch');
    }
  }

  // Does NOT implement onRequest(). LumenizeDO.onRequest is optional — when not
  // defined, fetch() returns 501 ("Not Implemented"). Direct HTTP is additionally
  // safe because onBeforeCall rejects anything missing universeGalaxyStarId.
  // Phase 5 implements onRequest() for real HTTP routing in Resources.
}
```

This permanently locks each DO instance to the star that first accessed it. An OrgDO at `acme.app.tenant-a` and a ResourceHistoryDO with UUID `abc-123` both get locked — the OrgDO because its instanceName matches the star, and the ResourceHistoryDO because the callContext carried the star from the Gateway.

### OrgDO (`org-do.ts`)

Extends NebulaDO. Singleton per star — instanceName equals the `universeGalaxyStarId`. Acts as the primary entry point for most operations within a star. Hosts the allowlist for Phase 2 testing.

```typescript
export class OrgDO extends NebulaDO {
  // instanceName = universeGalaxyStarId (e.g., 'acme.app.tenant-a')

  @mesh(requireAdmin)
  addToAllowlist(sub: string) {
    const allowlist = this.ctx.storage.kv.get<Set<string>>('allowlist') ?? new Set();
    allowlist.add(sub);
    this.ctx.storage.kv.put('allowlist', allowlist);
  }

  @mesh(requireAdmin)
  removeFromAllowlist(sub: string) {
    const allowlist = this.ctx.storage.kv.get<Set<string>>('allowlist') ?? new Set();
    allowlist.delete(sub);
    this.ctx.storage.kv.put('allowlist', allowlist);
  }

  @mesh()
  whoAmI(): string {
    return `You are ${this.lmz.callContext.originAuth!.sub}`;
  }
}
```

### ResourceHistoryDO (`resource-history-do.ts`)

Extends NebulaDO. Instance name is a UUID — not a starId. Demonstrates that NebulaDO's starId binding locks a UUID-named DO to the star that created it. In later phases this becomes the real resource history store.

```typescript
export class ResourceHistoryDO extends NebulaDO {
  // instanceName = UUID (e.g., 'f47ac10b-58cc-4372-a567-0e02b2c3d479')
  // starId binding inherited from NebulaDO — locked to creating star

  @mesh()
  getHistory(): string {
    return `History for resource ${this.lmz.instanceName}`;
  }
}
```

### NebulaClient (`nebula-client.ts`)

Extends `LumenizeClient`. Implements the two-scope model and basic token management for this phase. Discovery-first login, subscriptions, scope switching UX, and WebSocket keepalive come in Phase 7.

**Two-scope model.** NebulaClient tracks two distinct scopes:

1. **Auth scope** — the `universeGalaxyStarId` the user authenticated against. Determines the refresh cookie path and JWT issuer. A universe admin authenticates against `george-solopreneur` and gets a JWT with `access.id: "george-solopreneur.*"`.

2. **Active scope** — the specific star the client is targeting. That same universe admin might be interacting with `george-solopreneur.app.tenant-a`.

The JWT's wildcard matching lets one auth scope cover many active scopes. The client needs both: auth scope for `POST {prefix}/{authScope}/refresh-token` (path-scoped cookie), and active scope for the Gateway instanceName.

For regular users (non-admins, no wildcard), auth scope and active scope are always the same. For admins, auth scope ≠ active scope — they authenticate at a higher tier but target specific stars.

**Gateway instanceName composition.** NebulaClient composes the Gateway instanceName as `${sub}~${activeScope}~${tabId}`. Switching active scope means connecting to a new Gateway instance (same JWT, different instanceName).

**Access token management.** Access tokens are stored in memory per tab (not localStorage, not cookies). Each tab refreshes independently against its auth scope's refresh endpoint: `{prefix}/{authScope}/refresh-token`.

**Gateway binding name.** NebulaClient passes `gatewayBindingName: 'NEBULA_CLIENT_GATEWAY'` in its `LumenizeClientConfig`. This determines the URL path segment the client uses to connect — `routeDORequest` extracts it from the URL and routes to the correct Gateway DO binding.

**Constructor.** Accepts a `Browser` instance for testing (fetch + WebSocket injection).

### Guards

Authentication is enforced at connection time — every caller reaching a NebulaDO subclass already has a valid JWT. `NebulaDO.onBeforeCall()` enforces starId binding. Guards provide per-method authorization on subclasses.

`originAuth.claims` contains the full JWT payload (auto-included by the base class) plus any additional claims from `onBeforeAccept`. Guards read JWT fields like `access.admin` directly from `originAuth.claims`:

```typescript
// In nebula-do.ts (shared by all subclasses)

function requireAdmin(instance: NebulaDO) {
  const claims = instance.lmz.callContext.originAuth?.claims as NebulaJwtPayload;
  if (!claims?.access?.admin) {
    throw new Error('Admin access required');
  }
}
```

## Types

```typescript
// types.ts

import type { CallContext } from '@lumenize/mesh';

/** CallContext with universeGalaxyStarId as top-level immutable field (set by NebulaClientGateway.onBeforeCallToMesh) */
export interface NebulaCallContext extends CallContext {
  universeGalaxyStarId: string;
}
```

## Test Plan — Abuse Case Testing

All tests are e2e using NebulaClient with `Browser` from `@lumenize/testing`. The Browser provides cookie-aware fetch and WebSocket, enabling realistic auth flows.

Tests are split across four files by concern. A shared `createAuthenticatedClient` helper (see below) avoids duplicating auth setup. Where multiple assertions depend on the same state, group them in one test to avoid redundant setup.

### Test Setup

Each test scenario:
1. Creates a star-level NebulaAuth instance with subjects at various permission levels
2. Authenticates via nebula-auth (test mode for most tests, one real email test)
3. Creates a NebulaClient connected to a star via NebulaClientGateway
4. Calls OrgDO and/or ResourceHistoryDO methods, asserts success or rejection

### Scenarios

**StarId binding (NebulaDO.onBeforeCall + callContext.universeGalaxyStarId)**:
- Client connects via Gateway to `acme.app.tenant-a`, calls OrgDO method → starId stored
- Same client calls ResourceHistoryDO (UUID) → starId stored from callContext
- Different client connected to `acme.app.tenant-b` tries to call the same ResourceHistoryDO UUID → starId mismatch → rejected by NebulaDO.onBeforeCall
- Admin with wildcard JWT connects to `acme.app.tenant-a`, calls ResourceHistoryDO → allowed (entrypoint verified JWT covers that star)

**Scope verification at entrypoint**:
- JWT with `access.id: "acme.app.tenant-a"` requests Gateway for `acme.app.tenant-b` → rejected at entrypoint (403, no DO instantiated)
- JWT with `access.id: "acme.*"` requests Gateway for `acme.app.tenant-a` → allowed
- JWT with `access.id: "acme.app.tenant-a"` requests Gateway for `acme.app.tenant-a` → allowed (exact match)

**Admin-only methods (OrgDO)**:
- Non-admin user calls `addToAllowlist()` → rejected by `requireAdmin` guard
- Star-level admin calls `addToAllowlist()` → succeeds
- Universe admin (wildcard) calls star-level `addToAllowlist()` → succeeds (cross-scope admin)

**OrgDO allowlist lifecycle**:
- Admin calls `addToAllowlist(sub)` → succeeds
- Non-allowlisted user calls `whoAmI()` → succeeds (no allowlist guard on `whoAmI` in Phase 2)
- (Allowlist is an OrgDO admin feature; access to the star itself is controlled by the entrypoint scope check and starId binding)

**DO → client star verification (Gateway bidirectional check)**:
- `OrgDOTest` (subclass in `test-worker-and-dos.ts`) adds `callClientOnGateway(gatewayInstanceName, method)` — a test-only `@mesh(requireAdmin)` method that calls a client via a specified Gateway instance
- Two clients connected to different stars: Client A on `acme.app.tenant-a`, Client B on `acme.app.tenant-b`
- OrgDOTest on tenant-a calls a method on Client A through tenant-a's Gateway → Gateway forwards (starId matches)
- OrgDOTest on tenant-a calls `callClientOnGateway` targeting tenant-b's Gateway → `envelope.callContext.universeGalaxyStarId` is `"acme.app.tenant-a"` but `connectionInfo.claims.universeGalaxyStarId` is `"acme.app.tenant-b"` → `onBeforeCallToClient` rejects

**Admin scope switching (auth scope ≠ active scope)**:
- Universe admin authenticates at `george-solopreneur`, connects to `george-solopreneur.app.tenant-a` via Gateway → succeeds
- Same admin switches active scope to `george-solopreneur.app.tenant-b` (new Gateway instance, same JWT) → succeeds
- Verify no refresh call was made during the switch

**Gateway instanceName injection**:
- Client sends Gateway instanceName with `~` in the tabId segment (e.g., `sub~acme.app.tenant-a~tab~evil`) → Gateway rejects (segment count ≠ 3)
- Client sends Gateway instanceName with missing segments (e.g., `sub~acme.app.tenant-a`) → Gateway rejects

**Missing callContext.universeGalaxyStarId**:
- Simulate a mesh call arriving at a NebulaDO without `universeGalaxyStarId` on callContext → `onBeforeCall` throws immediately

**Direct HTTP to NebulaDO**:
- HTTP request targeting OrgDO or ResourceHistoryDO binding directly (bypassing Gateway) → returns 501 (LumenizeDO default), and any mesh call path would fail at `onBeforeCall` (missing `universeGalaxyStarId`)

**Token expiry / no auth**:
- Call with expired JWT → rejected at connection level (never reaches onBeforeCall)
- Call with no JWT → rejected

**Real email round trip (one test)**:
- Full magic link flow: request magic link → receive email → click link → get tokens → connect NebulaClient → call OrgDO method → success
- Uses the e2e email infrastructure from nebula-auth (Resend + deployed email-test Worker)

### Test Helpers

Build helpers that compose nebula-auth's test mode with NebulaClient creation:

```typescript
async function createAuthenticatedClient(
  browser: Browser,
  env: Env,
  authScope: string,      // e.g., 'acme.app.tenant-a' or 'acme' (for admins)
  activeScope: string,    // e.g., 'acme.app.tenant-a'
  email: string,
): Promise<NebulaClient> {
  // 1. Login via nebula-auth test mode (skips real email)
  // 2. Get access token
  // 3. Create NebulaClient with auth scope + active scope
  // 4. Client connects to Gateway with instanceName: sub~activeScope~tabId
  // ...
}
```

## Wrangler Bindings

The test `wrangler.jsonc` needs bindings for both nebula-auth classes (imported by the test worker) and nebula app classes:
- `NEBULA_AUTH` → NebulaAuth DO class (from nebula-auth)
- `NEBULA_AUTH_REGISTRY` → NebulaAuthRegistry DO class (from nebula-auth)
- `NEBULA_CLIENT_GATEWAY` → NebulaClientGateway class (from apps/nebula — extends LumenizeClientGateway)
- `ORG_DO` → OrgDOTest class (test subclass in test-worker-and-dos.ts — extends OrgDO)
- `RESOURCE_HISTORY_DO` → ResourceHistoryDO class (from apps/nebula)
- `AUTH_EMAIL_SENDER` → NebulaEmailSender service (from nebula-auth)
- `NEBULA_AUTH_RATE_LIMITER` → rate limiting binding
- Environment variables: `PRIMARY_JWT_KEY`, `NEBULA_AUTH_REDIRECT`, `NEBULA_AUTH_TEST_MODE`

## What Gets Replaced Later

- **Dummy methods** (`addToAllowlist`, `removeFromAllowlist`, `whoAmI`, `getHistory`): Replaced by real resource operations in Phase 5
- **Most tests**: Replaced by integration tests that exercise real Resources + DAG access control in Phase 3/5
- **Guards**: Augmented with DAG-aware permission checks in Phase 3
- **NebulaClient**: Gains subscription management, scope switching UX, full login flow in Phase 7
- **ResourceHistoryDO**: Gains real temporal storage in Phase 5

**What survives**: `NebulaDO.onBeforeCall()` starId binding, security layer pattern, `NebulaCallContext` type, `NebulaClientGateway`, wrangler binding setup, and test helpers.

## Success Criteria
- [ ] `apps/nebula/` exists with `NebulaDO`, `OrgDO`, `ResourceHistoryDO`, `NebulaClientGateway`, `NebulaClient`, `entrypoint.ts`, and guards
- [ ] `NebulaClientGateway` extends `LumenizeClientGateway` hooks with `~`-delimited instanceName, `callContext.universeGalaxyStarId`, and bidirectional star verification via `connectionInfo.claims`
- [ ] Entrypoint `onBeforeConnect` hook fully verifies JWT and checks scope covers the requested star before Gateway receives the connection
- [ ] `NebulaDO.onBeforeCall()` permanently binds each DO instance to its creating star (store on first call, throw on mismatch)
- [ ] StarId binding works for both singleton DOs (OrgDO, instanceName = starId) and UUID-named DOs (ResourceHistoryDO)
- [ ] Cross-star access to a UUID-named DO is rejected (starId mismatch)
- [ ] Standalone guard functions work with `@mesh(guard)` decorator
- [ ] DO → client calls through Gateway are verified for star membership (mismatched starId rejected, using OrgDOTest subclass in test harness)
- [ ] All abuse case scenarios pass (scope mismatch, starId binding, DO→client, admin-only, instanceName injection, token expiry)
- [ ] At least one real email round-trip e2e test
- [ ] NebulaClient connects via Browser injection (fetch + lmz.call)
- [ ] Cross-scope admin access works (universe admin → star DO)
- [ ] Two-scope model works: auth scope for refresh, active scope for Gateway instanceName
- [ ] Admin scope switching: new Gateway instance, same JWT, no re-auth
- [ ] Test helpers for authenticated client creation are reusable
