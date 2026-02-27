# Nebula Baseline Access Control

**Phase**: 2
**Status**: Pending
**App**: `apps/nebula/` (new app workspace created in this phase — not published to npm)
**Depends on**: Phase 1 (Refactor Nebula Auth)
**Master task file**: `tasks/nebula.md`

## Goal

Create `apps/nebula/` with three DO classes (`NebulaDO` base, `OrgDO`, `ResourceHistoryDO`), `NebulaClientGateway` (extends `LumenizeClientGateway` via Phase 1.5 hooks), `NebulaClient`, and the Worker entrypoint. Build a four-layer security model: entrypoint scope verification, Gateway star-scoping via `callContext.universeGalaxyStarId`, NebulaDO's `onBeforeCall` starId binding, and `@mesh(guard)` per-method authorization. Validate with dummy methods and abuse case testing through e2e tests using NebulaClient.

Much of what we build here will be replaced in Phase 3 (DAG tree) and Phase 5 (Resources), especially the tests and dummy methods.

The primary goals of this phase are:
1. Verify that nebula-auth's JWT format works with the Nebula Mesh components, especially `callContext`
2. Prove the starId binding mechanism — permanently locking each DO instance to its creating star
3. Establish the security layering pattern that all future phases build on

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
│   ├── wrangler.jsonc              # DO bindings for all classes
│   ├── vitest.config.js
│   ├── test-worker-and-dos.ts      # Test harness
│   └── access-control.test.ts      # Abuse case tests
└── README.md
```

### Communication

All application communication uses `lmz.call()`. Transport (WebSocket from client, Workers RPC between DOs) is an implementation detail handled by the underlying Lumenize Mesh — Nebula code never references it directly.

### Security Layers

Four layers, from outermost to innermost:

| Layer | Where | What it checks |
|-------|-------|----------------|
| **Entrypoint** | `entrypoint.ts` | `matchAccess(jwt.access.id, starId)` — rejects before any DO is instantiated |
| **NebulaClientGateway** | extends Gateway (Phase 1.5 hooks) | Bidirectional star enforcement: sets `callContext.universeGalaxyStarId` for client→DO calls; verifies starId match for DO→client calls before forwarding to client |
| **NebulaDO.onBeforeCall()** | base class | Stores starId on first call, throws on mismatch — every Nebula DO gets this |
| **`@mesh(guard)`** | subclass methods | Per-method authorization (requireAdmin, allowlist, etc.) |

### Entrypoint (`entrypoint.ts`)

The Worker `default export` — not a class, just a `{ fetch() }` router. Composes three concerns:

1. `routeNebulaAuthRequest` for auth routes (login, refresh, invite)
2. **Scope verification** for Gateway routes — extracts the starId from the Gateway instanceName (using the `~` delimiter), reads the JWT, and runs `matchAccess(jwt.access.id, starId)`. Rejects with 403 before any DO is involved.
3. `routeDORequest` for Gateway and DO bindings

```typescript
export default {
  async fetch(request: Request, env: Env) {
    // Auth routes (login, refresh, invite, etc.)
    const authResponse = await routeNebulaAuthRequest(request, env);
    if (authResponse) return authResponse;

    // For Gateway routes: verify JWT scope covers the requested star
    const scopeError = verifyGatewayScope(request);
    if (scopeError) return scopeError; // 403

    // DO routing (Gateway + DO bindings)
    return routeDORequest(request, env, { /* config */ });
  }
}
```

`routeDORequest` handles both WebSocket upgrades and regular HTTP. Direct HTTP to NebulaDO subclasses returns 501 (LumenizeDO's default `fetch()`). This is safe because `onBeforeCall` rejects any call missing `universeGalaxyStarId` — direct HTTP never carries it. Phase 1.5 adds an `onRequest()` lifecycle hook to LumenizeDO (agents SDK pattern); Phase 5 uses it for real HTTP routing in Resources.

### NebulaClientGateway (`nebula-client-gateway.ts`)

Extends `LumenizeClientGateway` using the hooks added in Phase 1.5 (`tasks/mesh-extensibility.md`). ~50 lines of overrides instead of an ~800 line fork.

**Overrides from LumenizeClientGateway:**

1. **Instance name format**: `${sub}~${universeGalaxyStarId}~${tabId}` (using `~` delimiter instead of `.`). The `~` is URL-safe (RFC 3986 unreserved) and avoids ambiguity since starIds contain dots.

2. **Instance name validation**: Parses on `~`, verifies three segments, checks sub matches JWT.

3. **callContext enrichment (client → DO)**: When building the `CallContext` for downstream calls, adds `universeGalaxyStarId` parsed from its own instanceName:

```typescript
const callContext = {
  callChain: [verifiedOrigin, ...clientCallChain.slice(1)],
  originAuth,
  state: clientContext?.state ? postprocess(clientContext.state) : {},
  universeGalaxyStarId: starId,  // parsed from own instanceName, immutable downstream
};
```

4. **Star verification (DO → client)**: In Lumenize Mesh, clients are full peers — DOs can call methods on clients, not just the reverse. When a DO sends a call that the Gateway needs to forward to a client, the Gateway verifies that the incoming call's `callContext.universeGalaxyStarId` matches its own starId. Rejects on mismatch. This check must live in the Gateway (server-side trust boundary), not in NebulaClient, because the client is within the end-user's control.

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

  // No fetch() override — inherits LumenizeDO's 501 default.
  // Direct HTTP is safe: onBeforeCall rejects anything missing universeGalaxyStarId.
  // Phase 1.5 adds onRequest() lifecycle hook to LumenizeDO; Phase 5 uses it.
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

  // Test-only: attempts to call a method on a client via a specified Gateway instance.
  // Used to verify that the Gateway rejects cross-star DO→client calls.
  @mesh(requireAdmin)
  callClientOnGateway(gatewayInstanceName: string, method: string) {
    return this.lmz.call('NEBULA_CLIENT_GATEWAY', gatewayInstanceName, method);
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

**Constructor.** Accepts a `Browser` instance for testing (fetch + WebSocket injection).

### Guards

Authentication is enforced at connection time — every caller reaching a NebulaDO subclass already has a valid JWT. `NebulaDO.onBeforeCall()` enforces starId binding. Guards provide per-method authorization on subclasses.

```typescript
// In nebula-do.ts (shared by all subclasses)

function requireAdmin(instance: NebulaDO) {
  const claims = instance.lmz.callContext.originAuth?.claims as NebulaJwtPayload;
  if (!claims?.isAdmin) {
    throw new Error('Admin access required');
  }
}
```

## Types

```typescript
// types.ts

import type { CallContext } from '@lumenize/mesh';

export interface NebulaCallContext extends CallContext {
  universeGalaxyStarId: string;
}
```

## Test Plan — Abuse Case Testing

All tests are e2e using NebulaClient with `Browser` from `@lumenize/testing`. The Browser provides cookie-aware fetch and WebSocket, enabling realistic auth flows.

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
- Two clients connected to different stars: Client A on `acme.app.tenant-a`, Client B on `acme.app.tenant-b`
- OrgDO on tenant-a calls a method on Client A through tenant-a's Gateway → Gateway forwards (starId matches)
- OrgDO on tenant-a has a test method that attempts to call Client B through tenant-b's Gateway → callContext carries `universeGalaxyStarId: "acme.app.tenant-a"` but tenant-b's Gateway has starId `"acme.app.tenant-b"` → Gateway rejects before forwarding to client

**Delegation**:
- User with delegated access calls methods appropriate to their delegated role → succeeds
- Delegated user tries to exceed delegated permissions → rejected

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

The test `wrangler.jsonc` needs:
- `NEBULA_AUTH` → NebulaAuth DO class (from nebula-auth)
- `NEBULA_AUTH_REGISTRY` → NebulaAuthRegistry DO class (from nebula-auth)
- `NEBULA_CLIENT_GATEWAY` → NebulaClientGateway class (from apps/nebula — extends LumenizeClientGateway)
- `ORG_DO` → OrgDO class (from apps/nebula)
- `RESOURCE_HISTORY_DO` → ResourceHistoryDO class (from apps/nebula)
- `AUTH_EMAIL_SENDER` → NebulaEmailSender service (from nebula-auth)
- `NEBULA_AUTH_RATE_LIMITER` → rate limiting binding
- Environment variables: `PRIMARY_JWT_KEY`, `NEBULA_AUTH_REDIRECT`, `NEBULA_AUTH_TEST_MODE`

## `callContext` Usage

`NebulaClientGateway` sets `callContext.universeGalaxyStarId` when building the call context for downstream DOs. This field is parsed from the Gateway's own instanceName (the `~`-delimited middle segment) and carried immutably through the entire call chain.

Guards and `onBeforeCall()` read JWT claims directly from `callContext.originAuth`. `callContext.state` is available for derived values but isn't needed in this phase.

## Implementation Notes from Security Review

**1. Claims mapping mismatch (NebulaClientGateway).** `LumenizeClientGateway`'s default `onBeforeAccept` maps `payload.isAdmin` and `payload.emailVerified`, but nebula-auth's JWT has `access.admin` (nested) and `email` (not `emailVerified`). `NebulaClientGateway` overrides `onBeforeAccept` (Phase 1.5 hook) to correctly map nebula-auth's JWT shape. Either include `access` in claims and have guards check `claims.access.admin`, or map `access.admin` → `isAdmin` for guard convenience.

**2. Null guard on `universeGalaxyStarId` in `onBeforeCall`.** If a call reaches a NebulaDO without going through the Gateway (bug, direct RPC from a non-Nebula DO), `universeGalaxyStarId` would be `undefined`. Without a null check, the first call would silently store `undefined` and all subsequent undefined calls would pass — defeating the starId binding. Add `if (!starId) throw new Error('Missing universeGalaxyStarId')` at the top of `onBeforeCall`.

**3. Direct HTTP to DO bindings bypasses entrypoint scope check.** `routeDORequest` routes to any configured binding. The entrypoint's `verifyGatewayScope()` only checks Gateway routes. A crafted HTTP request targeting `/org-do/...` would skip the scope check. `routeDORequest` already supports `onBeforeRequest`/`onBeforeConnect` hooks — use them in the entrypoint to restrict public access to only the Gateway binding. Direct HTTP is additionally safe because `onBeforeCall` rejects any call missing `universeGalaxyStarId` — the inherited 501 from LumenizeDO's default `fetch()` is sufficient for this phase. Phase 1.5 adds an `onRequest()` lifecycle hook to LumenizeDO (agents SDK pattern); Phase 5 uses it for real HTTP routing in Resources.

**4. `~` delimiter injection in Gateway instanceName.** The client controls the `tabId` segment. If it contains `~`, parsing would produce more than 3 segments. Split on `~` and reject if segment count ≠ 3. Add an abuse case test for this.

## What Gets Replaced Later

- **Dummy methods** (`addToAllowlist`, `removeFromAllowlist`, `whoAmI`, `getHistory`): Replaced by real resource operations in Phase 5
- **Most tests**: Replaced by integration tests that exercise real Resources + DAG access control in Phase 3/5
- **Guards**: Augmented with DAG-aware permission checks in Phase 3
- **NebulaClient**: Gains subscription management, scope switching UX, full login flow in Phase 7
- **ResourceHistoryDO**: Gains real temporal storage in Phase 5

**What survives**: `NebulaDO.onBeforeCall()` starId binding, security layer pattern, `NebulaCallContext` type, `NebulaClientGateway`, wrangler binding setup, and test helpers.

## Success Criteria

- [ ] `apps/nebula/` exists with `NebulaDO`, `OrgDO`, `ResourceHistoryDO`, `NebulaClientGateway`, `NebulaClient`, `entrypoint.ts`, and guards
- [ ] `NebulaClientGateway` extends `LumenizeClientGateway` (via Phase 1.5 hooks) with `~`-delimited instanceName, `callContext.universeGalaxyStarId`, and bidirectional star verification
- [ ] Entrypoint verifies JWT scope covers the requested star before routing to Gateway
- [ ] `NebulaDO.onBeforeCall()` permanently binds each DO instance to its creating star (store on first call, throw on mismatch)
- [ ] StarId binding works for both singleton DOs (OrgDO, instanceName = starId) and UUID-named DOs (ResourceHistoryDO)
- [ ] Cross-star access to a UUID-named DO is rejected (starId mismatch)
- [ ] Standalone guard functions work with `@mesh(guard)` decorator
- [ ] DO → client calls through Gateway are verified for star membership (mismatched starId rejected)
- [ ] All abuse case scenarios pass (scope mismatch, starId binding, DO→client, admin-only, delegation, token expiry)
- [ ] At least one real email round-trip e2e test
- [ ] NebulaClient connects via Browser injection (fetch + lmz.call)
- [ ] Cross-scope admin access works (universe admin → star DO)
- [ ] Two-scope model works: auth scope for refresh, active scope for Gateway instanceName
- [ ] Admin scope switching: new Gateway instance, same JWT, no re-auth
- [ ] Test helpers for authenticated client creation are reusable
