# Nebula Baseline Access Control

**Phase**: 2
**Status**: Pending
**Package**: `@lumenize/nebula` (new package created in this phase)
**Depends on**: Phase 1 (Refactor Nebula Auth)
**Master task file**: `tasks/nebula.md`

## Goal

Create `packages/nebula/` with `NebulaDO extends LumenizeDO` and `NebulaClient extends LumenizeClient`. Build real access control guards using `onBeforeCall` and `@mesh(guard)` annotations that consume nebula-auth's three-tier JWT identity. Validate with dummy methods and abuse case testing through e2e tests using NebulaClient with `Browser.fetch` and `Browser.WebSocket` injection.

Much of what we build here will be replaced in Phase 3 (DAG tree) and Phase 5 (Resources), especially the tests and dummy methods. The guards themselves are standalone functions designed for reuse.

## Architecture

### Package Layout

```
packages/nebula/
├── package.json
├── src/
│   ├── index.ts              # Public exports
│   ├── nebula-do.ts          # NebulaDO extends LumenizeDO
│   ├── nebula-client.ts      # NebulaClient extends LumenizeClient
│   ├── nebula-worker.ts      # Main Worker (composes auth + nebula routing)
│   └── guards.ts             # Standalone guard functions
├── test/
│   ├── wrangler.jsonc        # DO bindings for NebulaAuth + NebulaDO + Gateway
│   ├── vitest.config.js
│   ├── test-worker-and-dos.ts  # Test harness
│   └── access-control.test.ts # Abuse case tests
└── README.md
```

### How It Connects

```
Client (NebulaClient)
  → WebSocket via LumenizeClientGateway
    → NebulaDO (access control guards here)
      → JWT identity from nebula-auth flows through callContext

Browser request (login, refresh)
  → NebulaWorker.fetch()
    → routeNebulaAuthRequest() for /auth/* routes
    → NebulaDO routing for everything else
```

### NebulaWorker

The main Worker that will eventually be deployed to production. In this phase it composes:
1. `routeNebulaAuthRequest` (from `@lumenize/nebula-auth`) for auth routes
2. Gateway WebSocket routing (from `@lumenize/mesh`)
3. NebulaDO routing for application requests

```typescript
// Simplified — the Worker delegates auth to nebula-auth, everything else to NebulaDO
export default {
  async fetch(request: Request, env: Env) {
    // Auth routes (login, refresh, invite, etc.)
    const authResponse = await routeNebulaAuthRequest(request, env);
    if (authResponse) return authResponse;

    // Gateway WebSocket upgrade
    // ... (standard mesh pattern)

    // NebulaDO routes (application logic)
    // ... (standard routeDORequest pattern)
  }
}
```

### NebulaDO

Extends `LumenizeDO`. Responsible for:
- `onBeforeCall()`: Extract starId from JWT, validate scope, populate `callContext.state`
- Application methods decorated with `@mesh(guard)` for per-method access control

```typescript
export class NebulaDO extends LumenizeDO {
  onBeforeCall() {
    const auth = this.lmz.callContext.originAuth;
    if (!auth) throw new Error('Authentication required');

    const payload = auth.claims as NebulaJwtPayload;
    const instanceName = this.lmz.instanceName!;

    // Verify JWT scope covers this DO instance
    if (!matchAccess(payload.access.id, instanceName)) {
      throw new Error('Access denied: scope mismatch');
    }

    // Populate state for guards
    this.lmz.callContext.state.tier = parseId(instanceName).tier;
    this.lmz.callContext.state.role = payload.role;
    this.lmz.callContext.state.sub = auth.sub;
    this.lmz.callContext.state.email = payload.email;
    this.lmz.callContext.state.isAdmin = payload.isAdmin === true;
  }
}
```

### NebulaClient

Extends `LumenizeClient`. Adds:
- Auth scope + active scope tracking (two-scope model from `tasks/nebula-client.md`)
- Constructor accepts `Browser` instance for testing (fetch + WebSocket injection)
- Login/discovery flow awareness

For this phase, NebulaClient is minimal — enough to connect, authenticate, and call NebulaDO methods. The full client experience (subscriptions, scope switching, etc.) comes in Phase 7.

### Guard Functions

Standalone functions (not inline lambdas) so they're reusable across methods and testable in isolation. These survive into Phase 3+ when dummy methods get replaced.

```typescript
// guards.ts — standalone, reusable guard functions

export function requireAuthenticated(instance: NebulaDO) {
  if (!instance.lmz.callContext.state.sub) {
    throw new Error('Authentication required');
  }
}

export function requireAdmin(instance: NebulaDO) {
  if (!instance.lmz.callContext.state.isAdmin) {
    throw new Error('Admin access required');
  }
}

export function requireAdminApproved(instance: NebulaDO) {
  // Non-admin users must be adminApproved to access anything
  const state = instance.lmz.callContext.state;
  if (!state.isAdmin && !state.adminApproved) {
    throw new Error('Account not approved');
  }
}

export function requireRole(role: string) {
  return (instance: NebulaDO) => {
    // ... check role from state
  };
}
```

## Dummy Methods

Methods on NebulaDO designed solely to validate access control scenarios. Each targets a specific permission level. These get removed/replaced in Phase 3+.

```typescript
// On NebulaDO — dummy methods for testing access control

@mesh(requireAdmin)
adminOnlyAction(): string {
  return `admin action by ${this.lmz.callContext.state.sub}`;
}

@mesh(requireAuthenticated)
authenticatedAction(): string {
  return `authenticated action by ${this.lmz.callContext.state.sub}`;
}

@mesh()  // No guard — any mesh caller can invoke
unrestricted(): string {
  return 'unrestricted';
}
```

## Test Plan — Abuse Case Testing

All tests are e2e using NebulaClient with `Browser` from `@lumenize/testing`. The Browser provides cookie-aware fetch and WebSocket, enabling realistic auth flows.

### Test Setup

Each test scenario:
1. Creates a star-level NebulaAuth instance with subjects at various permission levels
2. Authenticates via nebula-auth (test mode for most tests, one real email test)
3. Creates a NebulaClient connected to a NebulaDO instance
4. Calls dummy methods and asserts success or rejection

### Scenarios

**Scope mismatch (onBeforeCall rejection)**:
- Authenticate against `acme.app.tenant-a`, try to call NebulaDO instance `acme.app.tenant-b` → rejected
- Authenticate against `acme.app.tenant-a`, try to call NebulaDO instance `acme.app` → rejected (star JWT can't access galaxy)
- Authenticate against `acme` (universe admin, wildcard JWT), call `acme.app.tenant-a` → allowed

**Admin-only methods**:
- Non-admin user calls `adminOnlyAction()` → rejected by guard
- Admin user calls `adminOnlyAction()` → succeeds
- Universe admin (wildcard) calls star-level `adminOnlyAction()` → succeeds (cross-scope admin)

**Unapproved users**:
- Self-signed-up user (not yet admin-approved) calls `authenticatedAction()` → behavior depends on guard (may reject or allow — design decision)
- Same user after admin approval → succeeds

**Delegation**:
- User with delegated access calls methods appropriate to their delegated role → succeeds
- Delegated user tries to exceed delegated permissions → rejected

**Token expiry / no auth**:
- Call with expired JWT → rejected at WebSocket connection level (never reaches onBeforeCall)
- Call with no JWT → rejected

**Real email round trip (one test)**:
- Full magic link flow: request magic link → receive email → click link → get tokens → connect NebulaClient → call NebulaDO method → success
- Uses the e2e email infrastructure from nebula-auth (Resend + deployed email-test Worker)

### Test Helpers

Build helpers that compose nebula-auth's test mode with NebulaClient creation:

```typescript
// Helper: authenticate and create a connected NebulaClient
async function createAuthenticatedClient(
  browser: Browser,
  env: Env,
  instanceName: string,  // e.g., 'acme.app.tenant-a'
  email: string,
): Promise<NebulaClient> {
  // 1. Login via nebula-auth test mode (skips real email)
  // 2. Get access token
  // 3. Create NebulaClient with browser.fetch and browser.WebSocket
  // 4. Wait for connection
  // ...
}
```

## Wrangler Bindings

The test `wrangler.jsonc` needs:
- `NEBULA_AUTH` → NebulaAuth DO class (from nebula-auth)
- `NEBULA_AUTH_REGISTRY` → NebulaAuthRegistry DO class (from nebula-auth)
- `NEBULA_DO` → NebulaDO class (from nebula)
- `LUMENIZE_CLIENT_GATEWAY` → LumenizeClientGateway class (from mesh)
- `AUTH_EMAIL_SENDER` → NebulaEmailSender service (from nebula-auth)
- `NEBULA_AUTH_RATE_LIMITER` → rate limiting binding
- Environment variables: `PRIMARY_JWT_KEY`, `NEBULA_AUTH_REDIRECT`, `NEBULA_AUTH_TEST_MODE`

## `callContext` Upgrade

This phase implements the `callContext` upgrade deferred from Phase 0:

- NebulaDO's `onBeforeCall()` extracts the starId (from `instanceName` or JWT) and stores it in `callContext.state`
- Guards read from `callContext.state` — not directly from JWT claims — so the precomputed values are available everywhere
- For this phase, the starId comes from the DO's `instanceName` which is set once in storage. Workers RPC propagation (Workers get starId from caller) is deferred to when we actually have NebulaWorker-to-NebulaDO call chains.

## What Gets Replaced Later

- **Dummy methods** (`adminOnlyAction`, `authenticatedAction`, `unrestricted`): Replaced by real resource operations in Phase 5
- **Most tests**: Replaced by integration tests that exercise real Resources + DAG access control in Phase 3/5
- **Simple guard functions**: May be augmented with DAG-aware permission checks in Phase 3
- **NebulaClient**: Gains subscription management, scope switching, full login flow in Phase 7

**What survives**: The guard function patterns, `onBeforeCall()` logic, `callContext.state` population, wrangler binding setup, and test helpers.

## Success Criteria

- [ ] `packages/nebula/` exists with `NebulaDO`, `NebulaClient`, `NebulaWorker`, and guards
- [ ] `NebulaDO.onBeforeCall()` validates JWT scope against the DO instance
- [ ] Standalone guard functions work with `@mesh(guard)` decorator
- [ ] All abuse case scenarios pass (scope mismatch, admin-only, unapproved, delegation, token expiry)
- [ ] At least one real email round-trip e2e test
- [ ] NebulaClient connects via Browser.fetch/WebSocket injection
- [ ] Cross-scope admin access works (universe admin → star DO)
- [ ] Test helpers for authenticated client creation are reusable
