# Mesh Testing Auth Strategy

**Status**: Not Started

## Objective

Export a `createTestRefreshFunction` helper from `@lumenize/mesh` that lets LumenizeClient mint JWTs locally in tests — no test mode, no LumenizeAuth DO, no magic link dance. Document this as the recommended testing pattern for users building on Lumenize Mesh. Narrow `LUMENIZE_AUTH_TEST_MODE` to auth-internal use only; it should never appear in user-facing mesh docs.

## Background

An audit of all 14 mesh test files found an exact correlation: the only tests that use `LUMENIZE_AUTH_TEST_MODE` are the 3 for-docs integration tests that connect via LumenizeClient (`getting-started`, `calls`, `security`). The other 11 tests use `createTestingClient` (direct DO RPC) or `MockWebSocket` and need no auth at all.

Those 3 tests currently require significant auth infrastructure just to get a JWT: `LUMENIZE_AUTH_TEST_MODE` binding, `LUMENIZE_AUTH` DO binding + migration, `createAuthRoutes()`, rate limiter, and the `testLoginWithMagicLink` 4-step dance (POST magic link → GET redirect → POST set-subject-data → POST refresh-token). All of this exists solely to produce a JWT that the auth hooks will accept.

`createTestRefreshFunction` replaces all of that by minting JWTs locally using `signJwt` + the private key already in `.dev.vars`. The auth hooks verify these JWTs normally — same signature check, same claims validation, same access gate. Zero test-only infrastructure beyond what the production Worker already needs. Test mode continues to exist for `@lumenize/auth`'s own tests (you can't self-mint JWTs to test the code that mints JWTs), but it's internal to that package and not something users need to know about.

## Testing Pyramid for Users

**Integration tests** (`LumenizeClient` + `createTestRefreshFunction`): Full production path — Client → Worker fetch → auth hooks → Gateway → DO. The `refresh` callback mints a JWT, hooks verify it, Gateway forwards it. Production fidelity with zero test-mode infrastructure.

**Isolated DO tests** (`createTestingClient`): Direct DO RPC, bypasses Worker/Gateway/auth entirely. No auth needed. Good for testing storage, alarms, business logic in isolation, and most critically for this task document, manipulating DO state - we need to close the LumenizeClientGateway's WebSocket to test client-side re-connection and login-prompt logic.

## Why This Works: LumenizeClient's `refresh` Option

LumenizeClient's `refresh` option accepts either a URL string (e.g. the default `/auth/refresh-token` endpoint) or a function. The function alternative is there to enable integration of any auth system. In that function, you can hit some alternative refresh endpoint or do something more complicated so long as the function returns the access token and sub. For our testing purposes, we'll just pass in a function that mints a JWT locally and either echo's the provided sub or generate a random one. The client calls `refresh` eagerly on connect and again when the access token expires.

## `createTestRefreshFunction` API Design

```typescript
interface createTestRefreshFunctionOptions {
  // Private key PEM string. Default: env.JWT_PRIVATE_KEY_BLUE
  privateKey?: string;

  // Subject ID for the JWT. Defaults to a generated UUID
  sub?: string;

  // Grant admin approval in the JWT claims. Default: true (to pass the access gate)
  adminApproved?: boolean;

  // Email verified flag. Default: true
  emailVerified?: boolean;

  // Grant admin role in the JWT claims. Default: false
  isAdmin?: boolean;

  // JWT issuer. Should match env.LUMENIZE_AUTH_ISSUER if set. Default: 'lumenize-auth'
  iss?: string;

  // JWT audience. Should match env.LUMENIZE_AUTH_AUDIENCE if set. Default: 'lumenize'
  aud?: string;

  // Token TTL in seconds. Default: 3600 (1 hour — plenty for tests)
  ttl?: number;

  // If true, the returned function throws to simulate an expired refresh token.
  // LumenizeClient catches this and fires `onLoginRequired`. Default: false.
  expired?: boolean;
}

/**
 * Creates a `refresh` callback for LumenizeClient that mints JWTs locally.
 *
 * The returned function signs a JWT using the provided options.
 * Auth hooks verify it normally against the corresponding public key —
 * no test mode, no bypass, all production code paths exercised.
 * 
 * See: https://lumenize.com/docs/mesh/testing for more details
 */
export function createTestRefreshFunction(
  options: createTestRefreshFunctionOptions
): () => Promise<{ access_token: string; sub: string }> {
  // ...
}
```

You use it like this:

```typescript
import { createTestRefreshFunction } from '@lumenize/mesh';

using client = new MyClient({
  baseUrl: 'https://localhost',
  refresh: createTestRefreshFunction(/* ... */),
  // ...
});
```

Implementation uses `signJwt` and `importPrivateKey` already exported from `@lumenize/auth`. The function returns a closure that can be called repeatedly (LumenizeClient calls `refresh` on connect and when tokens expire). Default `adminApproved: true` and `emailVerified: true` because the access gate requires `emailVerified && adminApproved` (or `isAdmin`) — most tests need to pass the gate.

## Phases

### Phase 1: Implement `createTestRefreshFunction`

**Goal**: Provide the self-minting helper in `@lumenize/mesh`.

**Success Criteria**:
- [ ] `createTestRefreshFunction(options)` exported from `@lumenize/mesh`
- [ ] Minimal JSDoc without examples but a link to https://lumenize.com/docs/mesh/testing
- [ ] Unit tests (sign a JWT, verify it's valid, check claims, verify `expired: true` throws)

**Notes**:
- New file: `packages/mesh/src/create-test-refresh-function.ts`. Lives in `@lumenize/mesh` — the package that owns LumenizeClient — so users already have it. `@lumenize/mesh` already depends on `@lumenize/auth` for `signJwt` and `importPrivateKey`.

### Phase 2: Migrate mesh for-docs tests to self-minting

**Goal**: Replace `testLoginWithMagicLink` with `createTestRefreshFunction` in all 3 for-docs test projects. Remove `LUMENIZE_AUTH_TEST_MODE` from mesh `vitest.config.js`.

**Success Criteria**:
- [ ] `getting-started/index.test.ts` uses `createTestRefreshFunction` instead of `testLoginWithMagicLink`
- [ ] `calls/index.test.ts` uses `createTestRefreshFunction` instead of `testLoginWithMagicLink`
- [ ] `security/index.test.ts` uses `createTestRefreshFunction` instead of `testLoginWithMagicLink`
- [ ] `security/index.test.ts` replaces `__testForceClose` with `createTestingClient` + `ctx.getWebSockets()[0].close(code)`
- [ ] `__testForceClose` method removed from `LumenizeClientGateway`
- [ ] `LUMENIZE_AUTH_TEST_MODE` removed from all 3 miniflare bindings in `vitest.config.js`
- [ ] `LUMENIZE_AUTH` DO binding removed from the 3 project `wrangler.jsonc` files (if no longer needed)
- [ ] `createAuthRoutes` removed from the 3 project entry points (if no longer needed)
- [ ] All tests pass
- [ ] for-docs entry points (`index.ts` — the `fetch` handler) are now exactly production code (no test-mode divergence)

**Notes**:
- Tests currently get `sub` from `testLoginWithMagicLink`'s return value. With `createTestRefreshFunction`, the test controls `sub` directly — actually better (deterministic test identity).
- The `security` tests currently use `__testForceClose` (which requires `LUMENIZE_AUTH_TEST_MODE`) to simulate network glitches. Replace with `createTestingClient` tunneling into the Gateway DO via the standard Hibernation API:
  ```typescript
  using gatewayClient = createTestingClient<typeof LumenizeClientGateway>('LUMENIZE_CLIENT_GATEWAY', instanceName);
  await gatewayClient.ctx.getWebSockets()[0].close(4403);  // await required over RPC
  ```
  To test the expired refresh token → `onLoginRequired` path, use `createTestRefreshFunction({ expired: true })`. This eliminates `__testForceClose` and the last dependency on `LUMENIZE_AUTH_TEST_MODE` in the security tests.
- The for-docs entry points should probably keep `LumenizeAuth` + `createAuthRoutes` for documentation purposes (showing the full production setup), even if the tests don't exercise them.

### Phase 3: Document the testing strategy

**Goal**: `website/docs/mesh/testing.mdx` documents the recommended testing patterns for users.

**Success Criteria**:
- [ ] `createTestRefreshFunction` pattern documented as the primary integration testing approach
- [ ] `createTestingClient` pattern documented as the complementary approach for isolated DO testing
- [ ] Clear testing pyramid: isolated (`createTestingClient`) → integration (`LumenizeClient` + `createTestRefreshFunction`)
- [ ] Example showing the full path: `createTestRefreshFunction` → LumenizeClient → Worker → auth hooks → Gateway → DO
- [ ] Example: simulating network glitch via `createTestingClient` + `testingClient.getWebSockets()[0].close(code)`
- [ ] Example: testing `onLoginRequired` via `createTestRefreshFunction({ expired: true })`
- [ ] No mention of `LUMENIZE_AUTH_TEST_MODE` in mesh docs

### Phase 4: Narrow test mode scope

**Goal**: Ensure `LUMENIZE_AUTH_TEST_MODE` is auth-internal only.

**Success Criteria**:
- [ ] All mesh tests work without test mode (confirmed in Phase 2)
- [ ] `website/docs/auth/testing.mdx` documents test mode as auth-internal only
- [ ] No user-facing mesh docs mention test mode

## Related

- `tasks/resend-email-for-auth.md` — Origin of the self-minting pattern (Phase 3 architecture)
- `packages/auth/src/jwt.ts` — `signJwt`, `importPrivateKey` (the primitives the pattern uses)
- `packages/auth/src/hooks.ts` — `createRouteDORequestAuthHooks`, `forwardJwtRequest` (what hooks inject)
- `packages/auth/src/test-helpers.ts` — Current `testLoginWithMagicLink` (what this replaces for mesh tests)
- `packages/mesh/vitest.config.js` — Multi-project config with `LUMENIZE_AUTH_TEST_MODE` in 3 of 5 projects
- `packages/mesh/test/for-docs/getting-started/index.test.ts` — Canonical integration test (migration target)
