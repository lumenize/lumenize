# Nebula Baseline Access Control

**Phase**: 2
**Status**: Pending
**App**: `apps/nebula/` (new app workspace created in this phase — not published to npm)
**Depends on**: Phase 1.96 (`verifyNebulaAccessToken` — pending, `tasks/nebula-verify-access-token.md`)

**Phase 1.96 — `verifyNebulaAccessToken`**: See `tasks/nebula-verify-access-token.md`. New export from `@lumenize/nebula-auth` — takes `(token, env)`, returns `NebulaJwtPayload | null`. Encapsulates key loading, signature verification, standard claims validation, and `matchAccess(authScopePattern, aud)`. Phase 2 imports this for the entrypoint's `onBeforeConnect` hook.

**Master task file**: `tasks/nebula.md`
**Sequence diagrams**: `website/docs/nebula/auth-flows.mdx`

## Goal

Create `apps/nebula/` with five DO classes (`NebulaDO` base, which extends LumenizeDO, and is extended by: `Universe`, `Galaxy`, `Star`, `ResourceHistory`), `NebulaClientGateway` (extends `LumenizeClientGateway` via hooks), `NebulaClient` (extends LumenizeClient), and the Worker entrypoint. Test subclasses (`StarTest`, `NebulaClientTest`) in the test harness exercise mesh→DO and mesh→client paths. Build out the elements of our four-layer security model that aren't already provided by Lumenize Mesh base classes (see Security Layers table below). Validate with dummy methods and abuse case testing through e2e tests using NebulaClient. We may also have lower-level tests for the pieces we build independent of the e2e tests through NebulaClient.

Much of what we build here will be replaced in Phase 3 (DAG tree) and Phase 5 (Resources), especially the tests and dummy methods.

The primary goals of this phase are:
1. Verify that nebula-auth's JWT format works with minimal implementations of the Nebula Mesh base components, especially `callContext`
2. Prove the universeGalaxyStarId binding mechanism — permanently locking each DO instance to the scope (universe, galaxy, or star) that first accessed it
3. Gain confidence in the security layering pattern that all future phases build on

---

## Prerequisite: Update Monorepo Scripts for `apps/`

The `apps/` directory is new to the monorepo. Three scripts search only `packages` and `tooling` — they need `apps` added before Phase 2 work begins:

- **`scripts/generate-types.sh`** (line 37) — `find packages tooling` → add `apps`
- **`scripts/type-check.sh`** (line 19) — `packages/*/tsconfig.json` glob → add `apps/*/tsconfig.json`
- **`scripts/test-code.sh`** (line 14) — `packages/*/package.json` glob → add `apps/*/package.json`

`scripts/setup-symlinks.sh` already uses recursive `find .` and will handle `apps/` automatically. Build/release/publish scripts are intentionally packages-only (apps aren't npm-published).

---

## Architecture

### App Layout

```
apps/nebula/
├── package.json                    # "private": true — never published
├── wrangler.jsonc                  # Production bindings — generates Env type via `wrangler types`
├── src/
│   ├── index.ts                    # Public exports (for sibling package imports)
│   ├── entrypoint.ts               # Worker default export (auth-scope check + routing)
│   ├── nebula-client-gateway.ts    # Extends LumenizeClientGateway (active-scope verified)
│   ├── nebula-do.ts                # NebulaDO base class (universeGalaxyStarId binding)
│   ├── universe.ts                 # Universe extends NebulaDO (singleton per universe)
│   ├── galaxy.ts                   # Galaxy extends NebulaDO (singleton per galaxy)
│   ├── star.ts                     # Star extends NebulaDO (singleton per star)
│   ├── resource-history.ts         # ResourceHistory extends NebulaDO (UUID instanceName)
│   └── nebula-client.ts            # NebulaClient extends LumenizeClient
├── test/
│   ├── wrangler.jsonc              # DO bindings for all classes (including test subclasses)
│   ├── vitest.config.js
│   ├── test-worker-and-dos.ts      # Test harness: StarTest (adds callClient) + NebulaClientTest (adds mesh methods + test initiators)
│   ├── scope-binding.test.ts       # universeGalaxyStarId binding + cross-active-scope rejection
│   ├── scope-verification.test.ts  # Entrypoint auth-scope check + admin active-scope switching
│   ├── guards.test.ts              # Admin-only methods, guard rejection
│   └── gateway-abuse.test.ts       # InstanceName injection, mesh → client, direct HTTP, token expiry
└── README.md
```

### Communication

All application communication uses `lmz.call()`. Transport (WebSocket from client, Workers RPC between DOs) is an implementation detail handled by the underlying Lumenize Mesh — Nebula code never references it directly.

### Security Layers

Four layers, from outermost to innermost:

| Layer | Where | What it checks |
|-------|-------|----------------|
| **Entrypoint** | `onBeforeConnect` hook in `routeDORequest` | Extracts JWT from WebSocket subprotocol, calls `verifyNebulaAccessToken` (signature + claims + `matchAccess(authScopePattern, aud)`) — rejects before any DO is called |
| **NebulaClientGateway** | extends Gateway hooks | `onBeforeCallToClient`: rejects calls whose `originAuth.claims.aud` doesn't match the connected client's `aud` |
| **NebulaDO.onBeforeCall()** | base class | Reads `aud` from `originAuth.claims` as `universeGalaxyStarId`, stores on first call, throws on mismatch — every Nebula DO gets this |
| **`@mesh(guard)`** | subclass methods | Per-method authorization (e.g., `requireAdmin`) |

### Entrypoint (`entrypoint.ts`)

The Worker `default export` — not a class, just a `{ fetch() }` router. Composes two routers using the established fallthrough pattern (each returns `undefined` for non-matching paths):

1. `routeNebulaAuthRequest` (from `@lumenize/nebula-auth`) for auth routes (login, refresh, invite). Returns `undefined` when the path doesn't match `/auth/` (fallthrough pattern from Phase 1.7). Phase 1.9 added `parseId()` validation here, so instance names arriving at the DO layer via auth routes are guaranteed well-formed (1–3 dot-separated slugs).
2. `routeDORequest` (from `@lumenize/routing`) for all DO bindings (Gateway and non-Gateway). Returns `undefined` when the path doesn't match any binding. Does **not** perform `parseId()` validation — it only matches URL paths to DO bindings and uses the instance name from the URL as-is. Instance names can be universeGalaxyStarIds (for Universe, Galaxy, Star) or UUIDs (for ResourceHistory). Active-scope validation is handled by `NebulaDO.onBeforeCall()`, which checks `originAuth.claims.aud`. **Active-scope verification** for Gateway connections occur in the `onBeforeConnect` hook in `routeDORequest`, which is called for all incoming WebSocket upgrades that go through the routing layer.

```typescript
import { routeNebulaAuthRequest, verifyNebulaAccessToken } from '@lumenize/nebula-auth';
import { routeDORequest } from '@lumenize/routing';
import { extractWebSocketToken } from '@lumenize/auth';

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
      // Phase 2: No HTTP access to Nebula DOs — all communication via WebSocket/mesh.
      // When Phase 5 adds onRequest() to NebulaDO for Resources, replace this with
      // verifyNebulaAccessToken gating (similar to onBeforeConnect below).
      onBeforeRequest(request, context) {
        return new Response('Not Implemented', { status: 501 });
      },
      async onBeforeConnect(request, context) {
        // Both the entrypoint (here) and the Gateway independently extract the JWT
        // from the same WebSocket subprotocol. The entrypoint does full signature
        // verification; the Gateway decodes for claims without re-verifying.
        const token = extractWebSocketToken(request);
        if (!token) {
          return new Response('Unauthorized: missing access token', { status: 401 });
        }

        const jwt = await verifyNebulaAccessToken(token, env);
        if (!jwt) {
          return new Response('Forbidden: invalid JWT', { status: 403 });
        }
      },
    });
    if (doResponse) return doResponse;

    return new Response('Not Found', { status: 404 });
  }
}
```

> **Why not `createRouteDORequestAuthHooks`?** `@lumenize/auth` exports a ready-made `createRouteDORequestAuthHooks` that provides `onBeforeConnect`/`onBeforeRequest` hooks. Nebula can't reuse it because: (a) it validates `aud` against a **static** `LUMENIZE_AUTH_AUDIENCE` env var, while Nebula's `aud` is the dynamic active scope; (b) it applies the `@lumenize/auth` access gate (`isAdmin || (emailVerified && adminApproved)`), not Nebula's `matchAccess(authScopePattern, aud)` check; (c) it doesn't know about `NebulaJwtPayload` or `authScopePattern`. The `verifyNebulaAccessToken` + `extractWebSocketToken` approach (~10 lines) is the right call.

> **`Env` type.** The app-level `wrangler.jsonc` defines production bindings and generates the global `Env` type via `npm run types` (the prerequisite step above adds `apps/` to the root script). The test `wrangler.jsonc` in `test/` adds test-specific bindings (e.g., `StarTest` subclass) — `npm run types` handles both.

**Direct HTTP safety.** `routeDORequest` handles both WebSocket upgrades and regular HTTP. Both layers return 501 for direct HTTP in Phase 2: the entrypoint's `onBeforeRequest` hook (line 107) rejects before the DO is reached, and `LumenizeDO`'s default `onRequest()` also returns 501 as a fallback. The entrypoint hook is an intentional tripwire — when Phase 5 opens `LumenizeDO.onRequest()` for Resources, the entrypoint's `onBeforeRequest` hook must be replaced with real JWT verification + `matchAccess` gating. Without the entrypoint tripwire, that gating step could be forgotten.

### NebulaClientGateway (`nebula-client-gateway.ts`)

Extends `LumenizeClientGateway` using the hooks from Phase 1.5 (`tasks/mesh-extensibility.md`). One override — the rest is inherited.

**Why so little code?** The base Gateway already auto-includes all JWT payload fields in `GatewayConnectionInfo.claims`, which propagates into `originAuth.claims` on every `CallContext`. Since the active scope lives in the standard JWT `aud` claim, every DO in the call chain can read `this.lmz.callContext.originAuth.claims.aud` without any Nebula-specific enrichment. The entrypoint already called `verifyNebulaAccessToken` (signature + claims + `matchAccess(authScopePattern, aud)`) before the connection reaches the Gateway, so `onBeforeAccept` and `onBeforeCallToMesh` need no overrides.

**Single override:**

**`onBeforeCallToClient` — active-scope verification (mesh → client)**: In Lumenize Mesh, clients are full peers — DOs and Workers can call methods on clients, not just the reverse. When a mesh call needs to be forwarded to a client, the hook receives a `CallEnvelope` (from `@lumenize/mesh` — contains `callContext: CallContext`, `chain`, and optional `metadata`) and compares the envelope's `originAuth.claims.aud` against `connectionInfo.claims.aud`. Rejects on mismatch. This check must live in the Gateway (server-side trust boundary), not in NebulaClient, because the client is within the end-user's control.

```typescript
override onBeforeCallToClient(envelope: CallEnvelope, connectionInfo: GatewayConnectionInfo): void {
  const aud = (envelope.callContext.originAuth?.claims as NebulaJwtPayload | undefined)?.aud;
  if (aud !== connectionInfo.claims.aud) {
    throw new Error('Active-scope mismatch on call to client');
  }
}
```

### NebulaDO (`nebula-do.ts`)

Base class for all Nebula DOs. `onBeforeCall()` is reserved for this class — subclasses should use `@mesh(guard)` for method-level authorization. If a subclass ever needs to extend `onBeforeCall`, it should call `super.onBeforeCall()` first.

**Lifecycle ordering:** `onBeforeCall` runs first (base class universeGalaxyStarId binding). A request from a different active scope is rejected at `onBeforeCall` before the guard ever executes. In other words, a Client from one Star can never call a DO from another Star. The same is true at the Universe and Galaxy levels.

```typescript
export class NebulaDO extends LumenizeDO {
  onBeforeCall() {
    const claims = this.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined;
    const universeGalaxyStarId = claims?.aud;

    // Reject calls that didn't come through NebulaClientGateway
    if (!universeGalaxyStarId) {
      throw new Error('Missing active scope (aud) in callContext');
    }

    // Store on first call, throw on mismatch
    const stored = this.ctx.storage.kv.get<string>('__nebula_universeGalaxyStarId');
    if (!stored) {
      this.ctx.storage.kv.put('__nebula_universeGalaxyStarId', universeGalaxyStarId);
    } else if (stored !== universeGalaxyStarId) {
      throw new Error('Active-scope mismatch');
    }
  }

  // No onRequest() for now — see "Direct HTTP safety" in the Entrypoint section.
}
```

This permanently locks each DO instance to the active scope (universe, galaxy, or star) that first accessed it (which is when the instance was created). A Star at `acme.app.tenant-a`, a Galaxy at `acme.app`, a Universe at `acme`, and a ResourceHistory with UUID `abc-123` all get locked because `originAuth.claims.aud` carried the active scope from the Gateway.

**Per-method guards.** Subclasses use `@mesh(guard)` for method-level authorization. Guards are standalone functions defined in `nebula-do.ts`:

```typescript
// In nebula-do.ts (shared by all subclasses)

function requireAdmin(instance: NebulaDO) {
  const claims = instance.lmz.callContext.originAuth?.claims as NebulaJwtPayload;
  if (!claims?.access?.admin) {
    throw new Error('Admin access required');
  }
}
```

**Trust chain for claims.** `OriginAuth` (from `@lumenize/mesh`) has `sub: string` and `claims?: Record<string, unknown>`. The base Gateway (Phase 1.7) auto-includes all JWT payload fields in `GatewayConnectionInfo.claims`, which propagates into `originAuth.claims` on the `CallContext`. So `originAuth.claims` contains the full `NebulaJwtPayload` structure (`access.authScopePattern`, `access.admin`, `aud`, `sub`, etc.). The cast to `NebulaJwtPayload` in the guard is safe because the entrypoint already verified the JWT signature — the claims are trusted.

**Guards must be synchronous.** Phase 1.95 changed `MeshGuard` to `(instance: T) => void` — the type system rejects async guards. Async guards would open the Cloudflare input gate, creating a race window between guard validation and method execution. Nebula guards only read from `originAuth.claims` (already in memory) and `ctx.storage.kv`/`ctx.storage.sql` (synchronous API), so they have no reason to be async.

### Universe (`universe.ts`)

Extends NebulaDO. Singleton per universe — instanceName equals a universe-level active scope (e.g., `"acme"`). Exercises universeGalaxyStarId binding at the universe level. Dummy methods for testing.

```typescript
export class Universe extends NebulaDO {
  // instanceName = universe-level active scope / JWT aud (e.g., 'acme')

  @mesh(requireAdmin)
  setUniverseConfig(key: string, value: string) {
    const config = this.ctx.storage.kv.get<Record<string, string>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh()
  getUniverseConfig(): Record<string, string> {
    return this.ctx.storage.kv.get<Record<string, string>>('config') ?? {};
  }
}
```

### Galaxy (`galaxy.ts`)

Extends NebulaDO. Singleton per galaxy — instanceName equals a galaxy-level active scope (e.g., `"acme.app"`). Exercises universeGalaxyStarId binding at the galaxy level. Dummy methods for testing.

```typescript
export class Galaxy extends NebulaDO {
  // instanceName = galaxy-level active scope / JWT aud (e.g., 'acme.app')

  @mesh(requireAdmin)
  setGalaxyConfig(key: string, value: string) {
    const config = this.ctx.storage.kv.get<Record<string, string>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh()
  getGalaxyConfig(): Record<string, string> {
    return this.ctx.storage.kv.get<Record<string, string>>('config') ?? {};
  }
}
```

### Star (`star.ts`)

Extends NebulaDO. Singleton per star — instanceName equals a star-level active scope (e.g., `"acme.app.tenant-a"`). Acts as the primary entry point for most operations within a star. Dummy methods exercise the three guard levels: admin-only, any-member, and unauthenticated-beyond-connection.

```typescript
export class Star extends NebulaDO {
  // instanceName = star-level active scope / JWT aud (e.g., 'acme.app.tenant-a')

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

### ResourceHistory (`resource-history.ts`)

Extends NebulaDO. Instance name is a UUID — not a universeGalaxyStarId. Demonstrates that NebulaDO's universeGalaxyStarId binding locks a UUID-named DO to the active scope that created it. In later phases this becomes the real resource history store.

```typescript
export class ResourceHistory extends NebulaDO {
  // instanceName = UUID (e.g., 'f47ac10b-58cc-4372-a567-0e02b2c3d479')
  // universeGalaxyStarId binding inherited from NebulaDO — locked to creating active scope

  @mesh()
  getHistory(): string {
    return `History for resource ${this.lmz.instanceName}`;
  }
}
```

### NebulaClient (`nebula-client.ts`)

Extends `LumenizeClient`. Implements the two-scope model and basic token management for this phase. See `website/docs/nebula/auth-flows.mdx` for sequence diagrams of the full login, returning user, and active-scope switching flows. Discovery-first login, subscriptions, active-scope switching UX, and WebSocket keepalive come in Phase 7.

**Two-scope model.** NebulaClient tracks two distinct scopes:

1. **Auth scope** — the scope the user authenticated against. Determines the refresh cookie path. A universe admin authenticates against `george-solopreneur` and gets a JWT with `access.authScopePattern: "george-solopreneur.*"`.

2. **Active scope** — the specific universe, galaxy, or star the client is targeting. Baked into the JWT's `aud` claim (Phase 1.8). That same universe admin might be interacting with `george-solopreneur.app.tenant-a`, so they refresh with `{ "activeScope": "george-solopreneur.app.tenant-a" }` in the request body.

The JWT's wildcard matching lets one auth scope cover many active scopes. The client needs both: auth scope for `POST {prefix}/{authScope}/refresh-token` (path-scoped cookie), and active scope as the `activeScope` field in the refresh request body. For regular users (non users/admins for Universe or Galaxy, no wildcard), auth scope and active scope are the same.

**Gateway connection.** NebulaClient uses the standard Lumenize Mesh instanceName format: `${sub}.${tabId}`. The active scope is NOT in the instanceName — it lives in the JWT `aud` claim. Switching active scope means getting a new access token (refresh with different `activeScope` in body) and connecting to a new Gateway instance. Access tokens are stored in memory per tab (not localStorage, not cookies).

**Gateway binding name.** NebulaClient sets `gatewayBindingName: 'NEBULA_CLIENT_GATEWAY'` in its config, matching the `NebulaClientGateway` binding. This determines the URL path segment the client uses to connect.

**Constructor and config.** NebulaClient extends `LumenizeClient`, which accepts `LumenizeClientConfig` (base URL, refresh function/URL, `gatewayBindingName`, optional `instanceName`, plus testing overrides for `fetch`/`WebSocket`/`sessionStorage`/`BroadcastChannel` from `Browser`). NebulaClient adds Nebula-specific concerns (auth scope, active scope) on top. For the `LumenizeClientConfig` shape and subclass patterns, see:
- `packages/mesh/test/for-docs/getting-started/editor-client.ts` — subclass with lifecycle management
- `packages/mesh/test/for-docs/getting-started/index.test.ts` (lines 40–57) — integration test with `Browser` injection
- `packages/mesh/test/for-docs/calls/calculator-client.ts` — minimal subclass using `lmz.call()`

**Phase 2 shape.** NebulaClient's `refresh` config is the key extension point — `LumenizeClient` accepts a custom async function `() => Promise<{ access_token: string; sub: string }>`, so NebulaClient captures both scopes in a closure passed to `super()`. No modifications to `LumenizeClient` needed. Real client-side `@mesh()` methods (subscriptions, notifications) come in Phase 7.

```typescript
interface NebulaClientConfig extends Omit<LumenizeClientConfig, 'refresh' | 'gatewayBindingName'> {
  authScope: string;     // e.g., 'acme.app.tenant-a' or 'acme' (for admins)
  activeScope: string;   // e.g., 'acme.app.tenant-a'
}

export class NebulaClient extends LumenizeClient {
  #authScope: string;
  #activeScope: string;

  constructor(config: NebulaClientConfig) {
    const { authScope, activeScope, ...baseConfig } = config;

    super({
      ...baseConfig,
      gatewayBindingName: 'NEBULA_CLIENT_GATEWAY',
      refresh: async () => {
        const fetchFn = config.fetch ?? fetch;
        const res = await fetchFn(
          `${config.baseUrl}/auth/${authScope}/refresh-token`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeScope }),
          },
        );
        if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
        const data = await res.json() as { access_token: string; sub: string };
        return { access_token: data.access_token, sub: data.sub };
      },
    });

    this.#authScope = authScope;
    this.#activeScope = activeScope;
  }
}
```

**Test subclass: `NebulaClientTest`.** Defined in `test/test-worker-and-dos.ts`. Adds two kinds of methods:

1. **`@mesh()` methods** — callable from the mesh (DOs call these through the Gateway). Two dummy methods exercise the mesh→client path, one unguarded and one with a client-side guard.
2. **Non-`@mesh()` test initiators** — tests call these directly to trigger outbound mesh calls, proving the client→DO round-trip works. This list will grow as we add more tests.

```typescript
// In test-worker-and-dos.ts

// Guard for client-side methods — same pattern as NebulaDO's requireAdmin,
// but typed against NebulaClientTest
function requireAdminCaller(instance: NebulaClientTest) {
  const claims = instance.lmz.callContext.originAuth?.claims as NebulaJwtPayload;
  if (!claims?.access?.admin) {
    throw new Error('Admin caller required');
  }
}

export class NebulaClientTest extends NebulaClient {
  // --- Mesh-callable methods (DOs call these through the Gateway) ---

  @mesh()
  echo(message: string): string {
    return `Client echoed: ${message}`;
  }

  @mesh(requireAdminCaller)
  adminEcho(message: string): string {
    return `Admin client echoed: ${message}`;
  }

  // --- Test initiators (tests call these to trigger outbound mesh calls) ---

  async callStarWhoAmI(starInstanceName: string): Promise<string> {
    return await this.lmz.call('STAR', starInstanceName, 'whoAmI');
  }
}
```

## Test Plan — Abuse Case Testing

Most tests are e2e using NebulaClient with `Browser` from `@lumenize/testing`. The Browser provides cookie-aware fetch and WebSocket, enabling realistic auth flows. A few belt-and-suspenders scenarios (marked below) use lower-level unit tests for conditions that can't occur through normal e2e flows.

Tests are split across four files by concern. A shared `createAuthenticatedClient` helper (see below) avoids duplicating auth setup. Where multiple assertions depend on the same state, group them in one test to avoid redundant setup.

### Test Setup

Each test scenario:
1. Creates a NebulaAuth instance at the appropriate level (universe, galaxy, or star) with subjects at various permission levels
2. Authenticates via nebula-auth (test mode for most tests, one real email test)
3. Creates a NebulaClient connected via NebulaClientGateway with the appropriate active scope
4. Calls Universe, Galaxy, Star, and/or ResourceHistory methods, asserts success or rejection

### Scenarios

**universeGalaxyStarId binding (NebulaDO.onBeforeCall + originAuth.claims.aud)**:

Star-level binding:
- Client connects via Gateway to `acme.app.tenant-a`, calls Star method → universeGalaxyStarId stored
- Same client calls ResourceHistory (UUID) → universeGalaxyStarId stored from callContext
- Different client connected to `acme.app.tenant-b` tries to call the same ResourceHistory UUID → active-scope mismatch → rejected by NebulaDO.onBeforeCall
- Admin with wildcard JWT connects to `acme.app.tenant-a`, calls ResourceHistory → allowed (entrypoint verified JWT covers that active scope)

Galaxy-level binding:
- Client with `aud: "acme.app"` connects via Gateway, calls Galaxy method → universeGalaxyStarId stored as `"acme.app"`
- Different client with `aud: "acme.other"` tries to call the same Galaxy instance → active-scope mismatch → rejected

Universe-level binding:
- Client with `aud: "acme"` connects via Gateway, calls Universe method → universeGalaxyStarId stored as `"acme"`
- Different client with `aud: "other-universe"` tries to call the same Universe instance → active-scope mismatch → rejected

**Auth-scope verification at entrypoint (unit tests, crafted JWTs)**:

These test the belt-and-suspenders `matchAccess(authScopePattern, aud)` check inside `verifyNebulaAccessToken`. Phase 1.8's refresh handler already prevents minting JWTs where `aud` isn't covered by `authScopePattern`, so this condition can't arise through normal auth flows. Tests must craft manually-signed JWTs to exercise these paths.

- JWT with `aud: "acme.app.tenant-a"` but `access.authScopePattern: "acme.app.tenant-b"` (auth scope doesn't cover active scope) → rejected at entrypoint (403, no DO instantiated)
- JWT with `aud: "acme.app.tenant-a"` and `access.authScopePattern: "acme.*"` → allowed (wildcard covers active scope)
- JWT with `aud: "acme.app.tenant-a"` and `access.authScopePattern: "acme.app.tenant-a"` → allowed (exact match)

**Guard enforcement (Star)**:
- Non-admin calls `setStarConfig()` → rejected by `requireAdmin` guard
- Star-level admin calls `setStarConfig()` → succeeds, writes to KV
- Universe admin (wildcard) calls star-level `setStarConfig()` → succeeds (cross-admin access)
- Non-admin calls `getStarConfig()` → succeeds (no guard beyond `@mesh()`)
- Non-admin calls `whoAmI()` → succeeds, returns caller's `sub`
- Wrong-active-scope user calls `whoAmI()` → rejected by `onBeforeCall` (universeGalaxyStarId mismatch) before guard ever runs — tests lifecycle ordering

**Mesh → client active-scope verification (Gateway bidirectional check)**:

Test setup: `StarTest` (subclass in `test-worker-and-dos.ts`) adds a test-only `@mesh(requireAdmin)` method `callClient(targetGatewayInstanceName, clientMethod)`. It uses `this.lmz.call()` to send a mesh call through the `NEBULA_CLIENT_GATEWAY` binding to a specific client instanceName.

- **Happy path**: Client A connected on `acme.app.tenant-a` (Gateway instance `subA.tab1`). StarTest on tenant-a calls `callClient('subA.tab1', 'echo', 'hello')` → envelope's `originAuth.claims.aud` matches Client A's `connectionInfo.claims.aud` → `onBeforeCallToClient` passes → returns `"Client echoed: hello"`.
- **Attack path**: Client B connected on `acme.app.tenant-b` (Gateway instance `subB.tab1`). StarTest on tenant-a calls `callClient('subB.tab1', 'echo', 'hello')` → envelope's `aud` is `"acme.app.tenant-a"` but Client B's is `"acme.app.tenant-b"` → `onBeforeCallToClient` rejects.
- **Client-side guard (happy)**: StarTest admin calls `callClient('subA.tab1', 'adminEcho', 'hello')` on same-scope client → scope match passes, `requireAdminCaller` guard passes (StarTest call originates from admin) → returns `"Admin client echoed: hello"`.
- In production this attack is unlikely (DOs don't normally address arbitrary Gateway instances), but the hook provides defense-in-depth.

**Admin active-scope switching**:
- Universe admin authenticates at `george-solopreneur`, refreshes with `{ "activeScope": "george-solopreneur.app.tenant-a" }`, creates NebulaClient, connects to Gateway → succeeds
- Admin destroys first client, refreshes with `{ "activeScope": "george-solopreneur.app.tenant-b" }`, creates new NebulaClient, connects to new Gateway instance → succeeds
- Verify the two clients used different access tokens (different `aud` claims)

**Missing originAuth.claims.aud (unit test, not e2e)**:
- This scenario can't happen through normal e2e flows (the Gateway always includes JWT payload in `originAuth.claims`), but `onBeforeCall` is a belt-and-suspenders defense. Test by calling `onBeforeCall()` directly on a NebulaDO instance with a callContext that lacks `originAuth` or has no `aud` in claims → throws immediately.

**Direct HTTP to NebulaDO**:
- HTTP request targeting Star or ResourceHistory binding directly (bypassing Gateway) → rejected at entrypoint `onBeforeRequest` hook (501), with `LumenizeDO`'s default `onRequest()` (also 501) as fallback — see "Direct HTTP safety" above

**Token expiry / no auth**:
- Call with expired JWT → rejected at connection level (never reaches onBeforeCall)
- Call with no JWT → rejected

**Real email round trip (one test)**:
- Full magic link flow: request magic link → receive email → click link → get tokens → connect NebulaClient → call Star method → success
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
  // Composes nebula-auth test mode login + refresh + NebulaClient creation.
  // See "NebulaClient" section above for the two-scope model details.
  // ...
}
```

## Wrangler Bindings

The test `wrangler.jsonc` needs bindings for both nebula-auth classes (imported by the test worker) and nebula app classes:
- `NEBULA_AUTH` → NebulaAuth DO class (from nebula-auth)
- `NEBULA_AUTH_REGISTRY` → NebulaAuthRegistry DO class (from nebula-auth)
- `NEBULA_CLIENT_GATEWAY` → NebulaClientGateway class (from apps/nebula — extends LumenizeClientGateway)
- `UNIVERSE` → Universe class (from apps/nebula)
- `GALAXY` → Galaxy class (from apps/nebula)
- `STAR` → StarTest class (test subclass in test-worker-and-dos.ts — extends Star, adds callClient)
- `RESOURCE_HISTORY_DO` → ResourceHistory class (from apps/nebula)
- `AUTH_EMAIL_SENDER` → NebulaEmailSender service (from nebula-auth)
- `NEBULA_AUTH_RATE_LIMITER` → rate limiting binding
- Environment variables: `PRIMARY_JWT_KEY`, `JWT_PUBLIC_KEY_BLUE`, `JWT_PUBLIC_KEY_GREEN`, `NEBULA_AUTH_REDIRECT`, `NEBULA_AUTH_TEST_MODE`
- Secrets (in `.dev.vars`): `JWT_PRIVATE_KEY_BLUE`, `JWT_PRIVATE_KEY_GREEN`

## What Gets Replaced Later

- **Dummy methods** (`setUniverseConfig`, `setGalaxyConfig`, `setStarConfig`, `getUniverseConfig`, `getGalaxyConfig`, `getStarConfig`, `whoAmI`, `getHistory`): Replaced by real resource operations in Phase 5
- **Dummy method tests**: Replaced by integration tests that exercise real Resources + DAG access control in Phase 3/5 (security layer and abuse case tests survive — they test infrastructure listed in "What survives" below)
- **Guards**: Augmented with DAG-aware permission checks in Phase 3
- **NebulaClient**: Gains subscription management, active-scope switching UX, full login flow in Phase 7
- **ResourceHistory**: Gains real temporal storage in Phase 5

**What survives**: `NebulaDO.onBeforeCall()` universeGalaxyStarId binding, security layer pattern, `NebulaClientGateway` (with hook overrides), wrangler binding setup, and test helpers.

## Success Criteria
- [ ] `apps/nebula/` exists with `NebulaDO`, `Universe`, `Galaxy`, `Star`, `ResourceHistory`, `NebulaClientGateway`, `NebulaClient`, `entrypoint.ts`, and guards
- [ ] `NebulaClientGateway` overrides `onBeforeCallToClient` to verify `originAuth.claims.aud` matches the connected client's `aud` (no other overrides needed — base class handles `onBeforeAccept` validation and `aud` propagation)
- [ ] Entrypoint `onBeforeConnect` hook extracts JWT from WebSocket subprotocol and calls `verifyNebulaAccessToken` (signature + claims + `matchAccess(authScopePattern, aud)` — all encapsulated)
- [ ] Entrypoint `onBeforeRequest` hook explicitly returns 501 for all direct HTTP (tripwire for Phase 5)
- [ ] `NebulaDO.onBeforeCall()` permanently binds each DO instance to its creating active scope (store on first call, throw on mismatch)
- [ ] universeGalaxyStarId binding works at all three levels: Universe (e.g., `"acme"`), Galaxy (e.g., `"acme.app"`), Star (e.g., `"acme.app.tenant-a"`)
- [ ] universeGalaxyStarId binding works for UUID-named DOs (ResourceHistory) — locked to the active scope that created them
- [ ] Cross-active-scope access to a UUID-named DO is rejected (universeGalaxyStarId mismatch)
- [ ] Standalone guard functions work with `@mesh(guard)` decorator (all Nebula guards are synchronous — no async)
- [ ] Guard lifecycle ordering verified: `onBeforeCall` rejects wrong active scope before guard runs
- [ ] Client-side `@mesh()` methods work (DO → Gateway → client round-trip via `NebulaClientTest.echo` and `NebulaClientTest.adminEcho`)
- [ ] Client-side guard (`requireAdminCaller`) passes for admin-originated calls
- [ ] Mesh → client calls through Gateway are verified for active-scope match (mismatched `aud` rejected, using StarTest subclass in test harness)
- [ ] All abuse case scenarios pass (active-scope mismatch, universeGalaxyStarId binding, mesh → client, guard rejection, direct HTTP, token expiry)
- [ ] At least one real email round-trip e2e test
- [ ] NebulaClient connects via Browser-injected fetch/WebSocket and calls Star methods via `lmz.call()` (see `packages/mesh/test/for-docs/getting-started/index.test.ts` lines 40–57 for the Browser + LumenizeClient integration pattern)
- [ ] Cross-admin access works (universe admin → star-level Star DO)
- [ ] Two-scope model works: auth scope for refresh cookie path, active scope via JWT `aud` (from `activeScope` in refresh body)
- [ ] Admin active-scope switching: refresh with new `activeScope` in body, new access token (different `aud`), new Gateway instance
- [ ] Test helpers for authenticated client creation are reusable
