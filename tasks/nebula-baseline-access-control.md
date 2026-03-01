# Nebula Baseline Access Control

**Phase**: 2
**Status**: Pending
**App**: `apps/nebula/` (new app workspace created in this phase — not published to npm)
**Depends on**: Phase 1.8 (JWT Active Scope in `aud` — `tasks/nebula-jwt-active-scope.md`)
**Master task file**: `tasks/nebula.md`

## Goal

Create `apps/nebula/` with three DO classes (`NebulaDO` base, `OrgDO`, `ResourceHistoryDO`), `NebulaClientGateway` (extends `LumenizeClientGateway` hooks), `NebulaClient`, and the Worker entrypoint. Build a four-layer security model: entrypoint JWT `aud` verification, Gateway star-scoping via `callContext.universeGalaxyStarId` (read from JWT `aud`), NebulaDO's `onBeforeCall` starId binding, and `@mesh(guard)` per-method authorization. Validate with dummy methods and abuse case testing through e2e tests using NebulaClient.

Much of what we build here will be replaced in Phase 3 (DAG tree) and Phase 5 (Resources), especially the tests and dummy methods.

The primary goals of this phase are:
1. Verify that nebula-auth's JWT format works with the Nebula Mesh components, especially `callContext`
2. Prove the starId binding mechanism — permanently locking each DO instance to its creating star
3. Establish the security layering pattern that all future phases build on

## Resolved: Active scope lives in JWT `aud` claim

**Decision (Phase 1.8):** The active scope (universeGalaxyStarId) is stored in the JWT `aud` claim. The `~`-delimited instanceName format is eliminated. See `tasks/nebula-jwt-active-scope.md` for the full implementation in nebula-auth.

**Key consequences for this phase:**
- Gateway instanceName is standard `${sub}.${tabId}` (Lumenize Mesh default)
- `NebulaClientGateway.onBeforeAccept` reads active scope from `connectionInfo.claims.aud`
- Entrypoint `onBeforeConnect` verifies the JWT `aud` claim (defense-in-depth)
- Access tokens are single-scope; switching active scope = refresh with `{ "activeScope": "newScope" }` in body
- No `~` delimiter anywhere — no parsing, no injection surface

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
| **Entrypoint** | `onBeforeConnect` hook in `routeDORequest` | Fully verifies JWT; defense-in-depth check that `matchAccess(jwt.access.authScopePattern, jwt.aud)` — rejects before any DO is instantiated |
| **NebulaClientGateway** | extends Gateway hooks | `onBeforeAccept`: reads `aud` from JWT claims as `universeGalaxyStarId`. `onBeforeCallToMesh`: stamps `universeGalaxyStarId` onto callContext. `onBeforeCallToClient`: rejects calls whose callContext starId doesn't match the connected client's claim |
| **NebulaDO.onBeforeCall()** | base class | Stores starId on first call, throws on mismatch — every Nebula DO gets this |
| **`@mesh(guard)`** | subclass methods | Per-method authorization (requireAdmin, allowlist, etc.) |

### Entrypoint (`entrypoint.ts`)

The Worker `default export` — not a class, just a `{ fetch() }` router. Composes two routers using the established fallthrough pattern (each returns `undefined` for non-matching paths):

1. `routeNebulaAuthRequest` (from `@lumenize/nebula-auth`) for auth routes (login, refresh, invite). Returns `undefined` when the path doesn't match `/auth/` — see Sub-task 0 prerequisite.
2. `routeDORequest` (from `@lumenize/routing`) for all DO bindings (Gateway and non-Gateway). Returns `undefined` when the path doesn't match any binding. **Scope verification** for Gateway connections uses the `onBeforeConnect` hook — this hook only fires for WebSocket upgrades, which only target the Gateway.

```typescript
import { routeNebulaAuthRequest, matchAccess } from '@lumenize/nebula-auth';
import { routeDORequest } from '@lumenize/routing';

export default {
  async fetch(request: Request, env: Env) {
    // Auth routes (login, refresh, invite, etc.)
    // Returns undefined for non-auth paths (fallthrough pattern)
    const authResponse = await routeNebulaAuthRequest(request, env);
    if (authResponse) return authResponse;

    // DO routing (Gateway + all other DO bindings)
    // onBeforeConnect: fully verifies JWT and checks aud claim (active scope)
    // Returns undefined if path doesn't match any binding
    const doResponse = await routeDORequest(request, env, {
      async onBeforeConnect(request) {
        // Full JWT verification (signature check, not just parse)
        const jwt = await verifyJwt(request, env.PRIMARY_JWT_KEY);
        if (!jwt) {
          return new Response('Forbidden: invalid JWT', { status: 403 });
        }
        // Defense-in-depth: verify active scope (aud) is covered by access pattern.
        // The server already validated this when minting the token (Phase 1.8),
        // but belt-and-suspenders is cheap here.
        if (!jwt.aud || !matchAccess(jwt.access.authScopePattern, jwt.aud)) {
          return new Response('Forbidden: JWT scope mismatch', { status: 403 });
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

1. **`onBeforeAccept` — extract active scope from JWT `aud`**: The base `LumenizeClientGateway.onBeforeAccept` validates the standard `.`-delimited `{sub}.{tabId}` format and auto-includes all JWT payload fields in `connectionInfo.claims`. Nebula overrides this to extract the `aud` claim (active scope, set by Phase 1.8's `scope` field in the refresh request body) and return it as `universeGalaxyStarId` — the only Nebula-specific claim the override needs to add. The instanceName stays standard `${sub}.${tabId}` — no custom delimiter.

```typescript
override onBeforeAccept(request: Request, connectionInfo: GatewayConnectionInfo): Record<string, unknown> | undefined {
  // Let base class validate sub.tabId format and populate claims from JWT
  super.onBeforeAccept(request, connectionInfo);

  const aud = connectionInfo.claims?.aud as string;
  if (!aud) throw new Error('Missing active scope (aud) in JWT');
  return { universeGalaxyStarId: aud };
}
```

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

1. **Auth scope** — the `universeGalaxyStarId` the user authenticated against. Determines the refresh cookie path. A universe admin authenticates against `george-solopreneur` and gets a JWT with `access.authScopePattern: "george-solopreneur.*"`.

2. **Active scope** — the specific star the client is targeting. Baked into the JWT's `aud` claim (Phase 1.8). That same universe admin might be interacting with `george-solopreneur.app.tenant-a`, so they refresh with `{ "activeScope": "george-solopreneur.app.tenant-a" }` in the request body.

The JWT's wildcard matching lets one auth scope cover many active scopes. The client needs both: auth scope for `POST {prefix}/{authScope}/refresh-token` (path-scoped cookie), and active scope as the `activeScope` field in the refresh request body.

For regular users (non-admins, no wildcard), auth scope and active scope are always the same. For admins, auth scope ≠ active scope — they authenticate at a higher tier but target specific stars.

**Gateway instanceName composition.** NebulaClient uses the standard Lumenize Mesh format: `${sub}.${tabId}`. The active scope is NOT in the instanceName — it lives in the JWT `aud` claim. Switching active scope means getting a new access token (refresh with different `activeScope` in body) and connecting to a new Gateway instance.

**Access token management.** Access tokens are stored in memory per tab (not localStorage, not cookies). Each tab refreshes independently against its auth scope's refresh endpoint: `POST {prefix}/{authScope}/refresh-token` with `{ "activeScope": "{activeScope}" }` in body. Each access token is single-scope — the `aud` claim determines which star it's valid for.

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
- JWT with `aud: "acme.app.tenant-a"` but `access.authScopePattern: "acme.app.tenant-b"` (scope doesn't cover aud) → rejected at entrypoint (403, no DO instantiated)
- JWT with `aud: "acme.app.tenant-a"` and `access.authScopePattern: "acme.*"` → allowed (wildcard covers aud)
- JWT with `aud: "acme.app.tenant-a"` and `access.authScopePattern: "acme.app.tenant-a"` → allowed (exact match)

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
- Universe admin authenticates at `george-solopreneur`, refreshes with `{ "activeScope": "george-solopreneur.app.tenant-a" }`, connects to Gateway → succeeds
- Same admin switches active scope to `george-solopreneur.app.tenant-b` (refresh with `{ "activeScope": "...tenant-b" }`, new access token, new Gateway instance) → succeeds
- Verify the switch required a refresh call (new access token with different `aud`)

**Gateway instanceName format**:
- InstanceName uses standard `${sub}.${tabId}` format — base class `onBeforeAccept` validates this
- Active scope comes from JWT `aud` claim, not from instanceName

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
  // 2. Refresh with { activeScope } in body to get single-scope access token (aud = activeScope)
  // 3. Create NebulaClient with auth scope + active scope
  // 4. Client connects to Gateway with standard instanceName: sub.tabId
  //    (Gateway reads active scope from JWT aud claim)
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
- [ ] `NebulaClientGateway` extends `LumenizeClientGateway` hooks: reads `aud` from JWT claims as `universeGalaxyStarId`, stamps `callContext.universeGalaxyStarId`, and bidirectional star verification via `connectionInfo.claims`
- [ ] Entrypoint `onBeforeConnect` hook fully verifies JWT and checks `matchAccess(jwt.access.authScopePattern, jwt.aud)` (defense-in-depth) before Gateway receives the connection
- [ ] `NebulaDO.onBeforeCall()` permanently binds each DO instance to its creating star (store on first call, throw on mismatch)
- [ ] StarId binding works for both singleton DOs (OrgDO, instanceName = starId) and UUID-named DOs (ResourceHistoryDO)
- [ ] Cross-star access to a UUID-named DO is rejected (starId mismatch)
- [ ] Standalone guard functions work with `@mesh(guard)` decorator
- [ ] DO → client calls through Gateway are verified for star membership (mismatched starId rejected, using OrgDOTest subclass in test harness)
- [ ] All abuse case scenarios pass (scope mismatch, starId binding, DO→client, admin-only, token expiry)
- [ ] At least one real email round-trip e2e test
- [ ] NebulaClient connects via Browser injection (fetch + lmz.call)
- [ ] Cross-scope admin access works (universe admin → star DO)
- [ ] Two-scope model works: auth scope for refresh cookie path, active scope via JWT `aud` (from `activeScope` in refresh body)
- [ ] Admin scope switching: refresh with new `activeScope` in body, new access token (different `aud`), new Gateway instance
- [ ] Test helpers for authenticated client creation are reusable
