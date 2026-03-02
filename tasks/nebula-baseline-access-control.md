# Nebula Baseline Access Control

**Phase**: 2
**Status**: Pending
**App**: `apps/nebula/` (new app workspace created in this phase — not published to npm)
**Depends on**: Phase 1.95 (Enforce Synchronous Guards — complete, `tasks/archive/nebula-sync-guards-in-lumenize-mesh.md`), Phase 1.8 (JWT Active Scope in `aud` — complete, `tasks/archive/nebula-jwt-active-scope.md`)
**Precondition from Phase 1.9**: The nebula-auth router validates instance names via `parseId()` before they reach any DO. Phase 2 code can trust that instance names arriving at the DO layer are well-formed `universe.galaxy.star` IDs (1–3 dot-separated slugs). The entrypoint should adopt the same `parseId()` validation for its own routing (or rely on `routeDORequest` doing so).
**Master task file**: `tasks/nebula.md`
**Sequence diagrams**: `website/docs/nebula/auth-flows.mdx`

## Goal

Create `apps/nebula/` with three DO classes (`NebulaDO` base, `OrgDO`, `ResourceHistoryDO`), `NebulaClientGateway` (extends `LumenizeClientGateway` hooks), `NebulaClient`, and the Worker entrypoint. Build a four-layer security model: entrypoint JWT `aud` verification, Gateway star-scoping via `callContext.universeGalaxyStarId` (read from JWT `aud`), NebulaDO's `onBeforeCall` starId binding, and `@mesh(guard)` per-method authorization. Validate with dummy methods and abuse case testing through e2e tests using NebulaClient.

Much of what we build here will be replaced in Phase 3 (DAG tree) and Phase 5 (Resources), especially the tests and dummy methods.

The primary goals of this phase are:
1. Verify that nebula-auth's JWT format works with the Nebula Mesh components, especially `callContext`
2. Prove the starId binding mechanism — permanently locking each DO instance to its creating star
3. Establish the security layering pattern that all future phases build on

---

## Architecture

### App Layout

```
apps/nebula/
├── package.json                    # "private": true — never published
├── wrangler.jsonc                  # Production bindings — generates Env type via `wrangler types`
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
│   ├── test-worker-and-dos.ts      # Test harness with OrgDOTest subclass (adds callClient)
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
| **Entrypoint** | `onBeforeConnect` hook in `routeDORequest` | Extracts JWT from WebSocket subprotocol, verifies signature, defense-in-depth check that `matchAccess(jwt.access.authScopePattern, jwt.aud)` — rejects before any DO is instantiated |
| **NebulaClientGateway** | extends Gateway hooks | `onBeforeAccept`: reads `aud` from `jwtPayload` as `universeGalaxyStarId`. `onBeforeCallToMesh`: stamps `universeGalaxyStarId` onto callContext. `onBeforeCallToClient`: rejects calls whose callContext starId doesn't match the connected client's claim |
| **NebulaDO.onBeforeCall()** | base class | Stores starId on first call, throws on mismatch — every Nebula DO gets this |
| **`@mesh(guard)`** | subclass methods | Per-method authorization (e.g., `requireAdmin`) |

### Entrypoint (`entrypoint.ts`)

The Worker `default export` — not a class, just a `{ fetch() }` router. Composes two routers using the established fallthrough pattern (each returns `undefined` for non-matching paths):

1. `routeNebulaAuthRequest` (from `@lumenize/nebula-auth`) for auth routes (login, refresh, invite). Returns `undefined` when the path doesn't match `/auth/` (fallthrough pattern from Phase 1.7).
2. `routeDORequest` (from `@lumenize/routing`) for all DO bindings (Gateway and non-Gateway). Returns `undefined` when the path doesn't match any binding. **Scope verification** for Gateway connections uses the `onBeforeConnect` hook — this hook fires for all WebSocket upgrades, but in practice only the Gateway accepts WebSocket connections.

```typescript
import { routeNebulaAuthRequest, matchAccess } from '@lumenize/nebula-auth';
import { routeDORequest } from '@lumenize/routing';
import { extractWebSocketToken, verifyJwt, verifyJwtWithRotation, importPublicKey } from '@lumenize/auth';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

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
      async onBeforeConnect(request, context) {
        // Both the entrypoint (here) and the Gateway independently extract the JWT
        // from the same WebSocket subprotocol. The entrypoint does full signature
        // verification; the Gateway decodes for claims without re-verifying.
        //
        // Extract JWT from WebSocket subprotocol (lmz.access-token.{token})
        const token = extractWebSocketToken(request);
        if (!token) {
          return new Response('Unauthorized: missing access token', { status: 401 });
        }

        // Full JWT verification (signature check, blue/green key rotation)
        const publicKeys = await getPublicKeys(env); // see helper below
        const payload = publicKeys.length === 1
          ? await verifyJwt(token, publicKeys[0])
          : await verifyJwtWithRotation(token, publicKeys);
        if (!payload) {
          return new Response('Forbidden: invalid JWT', { status: 403 });
        }

        // Defense-in-depth: verify active scope (aud) is covered by access pattern.
        // The server already validated this when minting the token (Phase 1.8),
        // but belt-and-suspenders is cheap here.
        const jwt = payload as unknown as NebulaJwtPayload;
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

> **Note:** The `getPublicKeys` helper follows the same pattern as nebula-auth's router — imports keys fresh each call (no caching, per Phase 1.9 Fix 4), loads both `JWT_PUBLIC_KEY_BLUE` and `JWT_PUBLIC_KEY_GREEN` from env. This is the second copy (~10 lines, from nebula-auth's router). No attribution needed for intra-monorepo copies. If a third copy appears, extract to a shared utility.

> **`Env` type.** The app-level `wrangler.jsonc` defines production bindings and generates the global `Env` type via `wrangler types` (run directly in `apps/nebula/`, not via the root npm script which only handles packages). The test `wrangler.jsonc` in `test/` adds test-specific bindings (e.g., `OrgDOTest` subclass) — run `wrangler types` there separately for test-specific types.

**Direct HTTP safety.** `routeDORequest` handles both WebSocket upgrades and regular HTTP. Direct HTTP to NebulaDO subclasses is safe for two reasons: (1) `onRequest` is an optional method on `LumenizeDO` — when not defined, `fetch()` returns 501, and (2) `onBeforeCall` rejects any mesh call missing `universeGalaxyStarId`, which direct HTTP never carries. Phase 5 uses `onRequest()` for real HTTP routing in Resources.

### NebulaClientGateway (`nebula-client-gateway.ts`)

Extends `LumenizeClientGateway` using the hooks from Phase 1.5 (`tasks/mesh-extensibility.md`). ~50 lines of overrides instead of an ~800 line fork.

**Hook overrides from LumenizeClientGateway:**

1. **`onBeforeAccept` — extract active scope from JWT `aud`**: The base class validates the standard `.`-delimited `{sub}.{tabId}` format. Its return value (if `Record`) is merged on top of `jwtPayload` to form `GatewayConnectionInfo.claims`. Nebula overrides to extract the `aud` claim (the active scope, set by Phase 1.8) and return it as `universeGalaxyStarId`:

```typescript
override onBeforeAccept(
  instanceName: string,
  sub: string,
  jwtPayload: Record<string, unknown>
): Response | Record<string, unknown> | undefined {
  // Let base class validate sub.tabId format
  const baseResult = super.onBeforeAccept(instanceName, sub, jwtPayload);
  if (baseResult instanceof Response) return baseResult; // base rejected

  const aud = jwtPayload.aud as string;
  if (!aud) throw new Error('Missing active scope (aud) in JWT');
  // baseResult is undefined (default) or Record — spread handles both
  return { ...baseResult, universeGalaxyStarId: aud };
}
```

After this hook, `GatewayConnectionInfo.claims` contains all JWT payload fields (auto-merged by the base class) plus `universeGalaxyStarId`. The instanceName remains standard `${sub}.${tabId}` — no custom delimiter.

2. **`onBeforeCallToMesh` — callContext enrichment (client → DO)**: Adds `universeGalaxyStarId` as a top-level field on `callContext` (not in `state`, which is mutable). Like `callChain` and `originAuth`, top-level fields are immutable by convention — no DO along the call chain should modify them:

```typescript
override onBeforeCallToMesh(baseContext: CallContext, connectionInfo: GatewayConnectionInfo): CallContext {
  // NebulaCallContext extends CallContext with universeGalaxyStarId
  return {
    ...baseContext,
    universeGalaxyStarId: connectionInfo.claims.universeGalaxyStarId as string,
  } satisfies NebulaCallContext;
}
```

3. **`onBeforeCallToClient` — star verification (DO → client)**: In Lumenize Mesh, clients are full peers — DOs can call methods on clients, not just the reverse. When a DO sends a call that the Gateway needs to forward to a client, the hook compares the envelope's `callContext.universeGalaxyStarId` against `connectionInfo.claims.universeGalaxyStarId`. Rejects on mismatch. This check must live in the Gateway (server-side trust boundary), not in NebulaClient, because the client is within the end-user's control.

```typescript
override onBeforeCallToClient(envelope: CallEnvelope, connectionInfo: GatewayConnectionInfo): void {
  const ctx = envelope.callContext as NebulaCallContext | undefined;
  if (ctx?.universeGalaxyStarId !== connectionInfo.claims.universeGalaxyStarId) {
    throw new Error('Star scope mismatch on call to client');
  }
}
```

### NebulaDO (`nebula-do.ts`)

Base class for all Nebula DOs. `onBeforeCall()` is reserved for this class — subclasses use `@mesh(guard)` for method-level authorization. If a subclass ever needs to extend `onBeforeCall`, it calls `super.onBeforeCall()` first.

**Lifecycle ordering:** `onBeforeCall` runs first (base class starId binding), then `@mesh(guard)` (subclass method authorization). A request from the wrong star is rejected at `onBeforeCall` before the guard ever executes.

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

  // No onRequest() — see "Direct HTTP safety" in the Entrypoint section.
}
```

This permanently locks each DO instance to the star that first accessed it. An OrgDO at `acme.app.tenant-a` and a ResourceHistoryDO with UUID `abc-123` both get locked — the OrgDO because its instanceName matches the star, and the ResourceHistoryDO because the callContext carried the star from the Gateway.

### OrgDO (`org-do.ts`)

Extends NebulaDO. Singleton per star — instanceName equals the `universeGalaxyStarId`. Acts as the primary entry point for most operations within a star. Dummy methods exercise the three guard levels: admin-only, any-member, and unauthenticated-beyond-connection.

```typescript
export class OrgDO extends NebulaDO {
  // instanceName = universeGalaxyStarId (e.g., 'acme.app.tenant-a')

  @mesh(requireAdmin)
  setStarConfig(key: string, value: string) {
    const config = this.ctx.storage.kv.get<Record<string, string>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh()
  getStarConfig(): Record<string, string> {
    return this.ctx.storage.kv.get<Record<string, string>>('config') ?? {};
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

Extends `LumenizeClient`. Implements the two-scope model and basic token management for this phase. See `website/docs/nebula/auth-flows.mdx` for sequence diagrams of the full login, returning user, and scope switching flows. Discovery-first login, subscriptions, scope switching UX, and WebSocket keepalive come in Phase 7.

**Two-scope model.** NebulaClient tracks two distinct scopes:

1. **Auth scope** — the `universeGalaxyStarId` the user authenticated against. Determines the refresh cookie path. A universe admin authenticates against `george-solopreneur` and gets a JWT with `access.authScopePattern: "george-solopreneur.*"`.

2. **Active scope** — the specific star the client is targeting. Baked into the JWT's `aud` claim (Phase 1.8). That same universe admin might be interacting with `george-solopreneur.app.tenant-a`, so they refresh with `{ "activeScope": "george-solopreneur.app.tenant-a" }` in the request body.

The JWT's wildcard matching lets one auth scope cover many active scopes. The client needs both: auth scope for `POST {prefix}/{authScope}/refresh-token` (path-scoped cookie), and active scope as the `activeScope` field in the refresh request body. For regular users (non-admins, no wildcard), auth scope and active scope are always the same.

**Gateway connection.** NebulaClient uses the standard Lumenize Mesh instanceName format: `${sub}.${tabId}`. The active scope is NOT in the instanceName — it lives in the JWT `aud` claim. Switching active scope means getting a new access token (refresh with different `activeScope` in body) and connecting to a new Gateway instance. Access tokens are stored in memory per tab (not localStorage, not cookies).

**Gateway binding name.** NebulaClient sets `gatewayBindingName: 'NEBULA_CLIENT_GATEWAY'` in its config, matching the `NebulaClientGateway` binding. This determines the URL path segment the client uses to connect.

**Constructor.** Accepts a `Browser` instance for testing (fetch + WebSocket injection).

### Guards

Authentication is enforced at connection time — every caller reaching a NebulaDO subclass already has a valid JWT. `NebulaDO.onBeforeCall()` enforces starId binding. Guards provide per-method authorization on subclasses.

The `MeshGuard<T>` type is `(instance: T) => void | Promise<void>`. Guards receive the DO instance and can read `instance.lmz.callContext.originAuth.claims` for JWT fields. Typing the guard against the base class (`NebulaDO`) makes it usable on all subclasses via contravariance:

```typescript
// In nebula-do.ts (shared by all subclasses)

function requireAdmin(instance: NebulaDO) {
  const claims = instance.lmz.callContext.originAuth?.claims as NebulaJwtPayload;
  if (!claims?.access?.admin) {
    throw new Error('Admin access required');
  }
}
```

**Trust chain for claims.** The base Gateway (Phase 1.7) auto-includes all JWT payload fields in `GatewayConnectionInfo.claims`, which propagates into `originAuth.claims` on the `CallContext`. So `originAuth.claims` is a `Record<string, unknown>` that contains the full `NebulaJwtPayload` structure (`access.authScopePattern`, `access.admin`, `aud`, `sub`, etc.) plus any additional claims returned by `onBeforeAccept` (e.g., `universeGalaxyStarId`).

The cast to `NebulaJwtPayload` in the guard is safe because the entrypoint already verified the JWT signature — the claims are trusted.

**Guards must be synchronous.** The Mesh `MeshGuard` type allows `Promise<void>` returns, but async guards open the Cloudflare input gate — creating a race window between guard validation and method execution. Nebula guards only read from `originAuth.claims` (already in memory) and `ctx.storage.kv`/`ctx.storage.sql` (synchronous API), so they have no reason to be async. Keep all Nebula guards synchronous.

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

Most tests are e2e using NebulaClient with `Browser` from `@lumenize/testing`. The Browser provides cookie-aware fetch and WebSocket, enabling realistic auth flows. A few belt-and-suspenders scenarios (marked below) use lower-level unit tests for conditions that can't occur through normal e2e flows.

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

**Guard enforcement (OrgDO)**:
- Non-admin calls `setStarConfig()` → rejected by `requireAdmin` guard
- Star-level admin calls `setStarConfig()` → succeeds, writes to KV
- Universe admin (wildcard) calls star-level `setStarConfig()` → succeeds (cross-scope admin)
- Non-admin calls `getStarConfig()` → succeeds (no guard beyond `@mesh()`)
- Non-admin calls `whoAmI()` → succeeds, returns caller's `sub`
- Wrong-star user calls `whoAmI()` → rejected by `onBeforeCall` (starId mismatch) before guard ever runs — tests lifecycle ordering

**DO → client star verification (Gateway bidirectional check)**:

Test setup: `OrgDOTest` (subclass in `test-worker-and-dos.ts`) adds a test-only `@mesh(requireAdmin)` method `callClient(targetGatewayInstanceName, clientMethod)`. It uses `this.lmz.call()` to send a mesh call through the `NEBULA_CLIENT_GATEWAY` binding to a specific client instanceName.

- **Happy path**: Client A connected on `acme.app.tenant-a` (Gateway instance `subA.tab1`). OrgDOTest on tenant-a calls `callClient('subA.tab1', 'someMethod')` → envelope's `callContext.universeGalaxyStarId` matches Client A's `connectionInfo.claims.universeGalaxyStarId` → `onBeforeCallToClient` passes.
- **Attack path**: Client B connected on `acme.app.tenant-b` (Gateway instance `subB.tab1`). OrgDOTest on tenant-a calls `callClient('subB.tab1', 'someMethod')` → envelope starId is `"acme.app.tenant-a"` but Client B's is `"acme.app.tenant-b"` → `onBeforeCallToClient` rejects.
- In production this attack is unlikely (DOs don't normally address arbitrary Gateway instances), but the hook provides defense-in-depth.

**Admin scope switching**:
- Universe admin authenticates at `george-solopreneur`, refreshes with `{ "activeScope": "george-solopreneur.app.tenant-a" }`, creates NebulaClient, connects to Gateway → succeeds
- Admin destroys first client, refreshes with `{ "activeScope": "george-solopreneur.app.tenant-b" }`, creates new NebulaClient, connects to new Gateway instance → succeeds
- Verify the two clients used different access tokens (different `aud` claims)

**Missing callContext.universeGalaxyStarId (unit test, not e2e)**:
- This scenario can't happen through normal e2e flows (NebulaClientGateway always stamps `universeGalaxyStarId`), but `onBeforeCall` is a belt-and-suspenders defense. Test by calling `onBeforeCall()` directly on a NebulaDO instance with a callContext that lacks `universeGalaxyStarId` → throws immediately.

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
- Environment variables: `PRIMARY_JWT_KEY`, `JWT_PUBLIC_KEY_BLUE`, `JWT_PUBLIC_KEY_GREEN`, `NEBULA_AUTH_REDIRECT`, `NEBULA_AUTH_TEST_MODE`
- Secrets (in `.dev.vars`): `JWT_PRIVATE_KEY_BLUE`, `JWT_PRIVATE_KEY_GREEN`

## What Gets Replaced Later

- **Dummy methods** (`setStarConfig`, `getStarConfig`, `whoAmI`, `getHistory`): Replaced by real resource operations in Phase 5
- **Most tests**: Replaced by integration tests that exercise real Resources + DAG access control in Phase 3/5
- **Guards**: Augmented with DAG-aware permission checks in Phase 3
- **NebulaClient**: Gains subscription management, scope switching UX, full login flow in Phase 7
- **ResourceHistoryDO**: Gains real temporal storage in Phase 5

**What survives**: `NebulaDO.onBeforeCall()` starId binding, security layer pattern, `NebulaCallContext` type, `NebulaClientGateway` (with all hook overrides), wrangler binding setup, and test helpers.

## Success Criteria
- [ ] `apps/nebula/` exists with `NebulaDO`, `OrgDO`, `ResourceHistoryDO`, `NebulaClientGateway`, `NebulaClient`, `entrypoint.ts`, and guards
- [ ] `NebulaClientGateway` overrides `onBeforeAccept(instanceName, sub, jwtPayload)` to extract `aud` as `universeGalaxyStarId`, overrides `onBeforeCallToMesh` to stamp it onto callContext, and overrides `onBeforeCallToClient` for bidirectional star verification
- [ ] Entrypoint `onBeforeConnect` hook extracts JWT from WebSocket subprotocol, verifies signature, and checks `matchAccess(jwt.access.authScopePattern, jwt.aud)` (defense-in-depth)
- [ ] `NebulaDO.onBeforeCall()` permanently binds each DO instance to its creating star (store on first call, throw on mismatch)
- [ ] StarId binding works for both singleton DOs (OrgDO, instanceName = starId) and UUID-named DOs (ResourceHistoryDO)
- [ ] Cross-star access to a UUID-named DO is rejected (starId mismatch)
- [ ] Standalone guard functions work with `@mesh(guard)` decorator (all Nebula guards are synchronous — no async)
- [ ] Guard lifecycle ordering verified: `onBeforeCall` rejects wrong-star before guard runs
- [ ] DO → client calls through Gateway are verified for star membership (mismatched starId rejected, using OrgDOTest subclass in test harness)
- [ ] All abuse case scenarios pass (scope mismatch, starId binding, DO→client, guard rejection, direct HTTP, token expiry)
- [ ] At least one real email round-trip e2e test
- [ ] NebulaClient connects via Browser injection (fetch + lmz.call)
- [ ] Cross-scope admin access works (universe admin → star DO)
- [ ] Two-scope model works: auth scope for refresh cookie path, active scope via JWT `aud` (from `activeScope` in refresh body)
- [ ] Admin scope switching: refresh with new `activeScope` in body, new access token (different `aud`), new Gateway instance
- [ ] Test helpers for authenticated client creation are reusable
