# Mesh Testing Auth Strategy

**Status**: Complete — all 7 phases done (0-6)

## Objective

Export a `createTestRefreshFunction` helper from `@lumenize/mesh` that lets LumenizeClient mint JWTs locally in tests — no test mode, no LumenizeAuth DO, no magic link dance. Document this as the recommended testing pattern for users building on Lumenize Mesh. Narrow `LUMENIZE_AUTH_TEST_MODE` to auth-internal use only; it should never appear in user-facing mesh docs.

## Background

An audit of all 14 mesh test files found an exact correlation: the only tests that use `LUMENIZE_AUTH_TEST_MODE` are the 3 for-docs integration tests that connect via LumenizeClient (`getting-started`, `calls`, `security`). The other 11 tests use `createTestingClient` (direct DO RPC) or `MockWebSocket` and need no auth at all.

Those 3 tests currently require significant auth infrastructure just to get a JWT: `LUMENIZE_AUTH_TEST_MODE` binding, `LUMENIZE_AUTH` DO binding + migration, `createAuthRoutes()`, rate limiter, and the `testLoginWithMagicLink` 4-step dance (POST magic link → GET redirect → POST set-subject-data → POST refresh-token). All of this exists solely to produce a JWT that the auth hooks will accept.

`createTestRefreshFunction` replaces all of that by minting JWTs locally using `signJwt` + the private key already in `.dev.vars`. The auth hooks verify these JWTs normally — same signature check, same claims validation, same access gate. Zero test-only infrastructure beyond what the production Worker already needs. Test mode continues to exist for `@lumenize/auth`'s own tests (you can't self-mint JWTs to test the code that mints JWTs), but it's internal to that package and not something users need to know about.

## Testing Pyramid for Users

**Integration tests** (`LumenizeClient` + `createTestRefreshFunction`): Full production path — Client → Worker fetch → auth hooks → Gateway → DO. The `refresh` callback mints a JWT, hooks verify it, Gateway forwards it. Production fidelity with zero test-mode infrastructure.

**Isolated DO tests** (`createTestingClient`): Direct DO RPC, bypasses Worker/Gateway/auth entirely. No auth needed. Good for testing storage, alarms, business logic in isolation, and most critically for this task document, manipulating DO state — we need to close the LumenizeClientGateway's WebSocket to test client-side re-connection and login-prompt logic.

## Why This Works: LumenizeClient's `refresh` Option

LumenizeClient's `refresh` option accepts either a URL string (e.g. the default `/auth/refresh-token` endpoint) or a function. The function alternative is there to enable integration of any auth system. In that function, you can hit some alternative refresh endpoint or do something more complicated so long as the function returns the access token and sub. For our testing purposes, we'll just pass in a function that mints a JWT locally and either echo's the provided sub or generate a random one. The client calls `refresh` eagerly on connect and again when the access token expires.

## `createTestRefreshFunction` API Design

```typescript
interface createTestRefreshFunctionOptions {
  // Private key PEM string. Default: reads env.JWT_PRIVATE_KEY_BLUE
  // via import('cloudflare:test').env at call time
  privateKey?: string;

  // Subject ID for the JWT. Defaults to crypto.randomUUID()
  sub?: string;

  // Grant admin approval in the JWT claims. Default: true (to pass the access gate)
  adminApproved?: boolean;

  // Email verified flag. Default: true
  emailVerified?: boolean;

  // Grant admin role in the JWT claims. Default: false
  isAdmin?: boolean;

  // JWT issuer. Should match env.LUMENIZE_AUTH_ISSUER if set. Default: 'https://lumenize.local'
  iss?: string;

  // JWT audience. Should match env.LUMENIZE_AUTH_AUDIENCE if set. Default: 'https://lumenize.local'
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

The returned function can also be called directly to get a raw token (useful for lower-level tests like CORS verification):

```typescript
const refresh = createTestRefreshFunction({ sub: 'cors-test-user' });
const { access_token: accessToken, sub } = await refresh();
// Use accessToken in Sec-WebSocket-Protocol headers, etc.
```

Implementation uses `signJwt` and `importPrivateKey` already exported from `@lumenize/auth`. The function returns a closure that can be called repeatedly (LumenizeClient calls `refresh` on connect and when tokens expire). Default `adminApproved: true` and `emailVerified: true` because the access gate requires `emailVerified && adminApproved` (or `isAdmin`) — most tests need to pass the gate. The `privateKey` defaults to reading `env.JWT_PRIVATE_KEY_BLUE` via `import('cloudflare:test')` — this is fine since `createTestRefreshFunction` only runs in test contexts.

## Phases

### Phase 0: Validate `ctx.getWebSockets()[0].close()` over RPC

**Goal**: Prove that `createTestingClient` can close a Gateway's WebSocket via `ctx.getWebSockets()[0].close(code, reason)` — eliminating the need for .

**Success Criteria**:
- [x] Phase 1 of the security test (`onLoginRequired` callback) passes with `ctx.getWebSockets()[0].close(4403, 'Invalid token signature')` instead of `__testForceClose`
- [x] No other changes to the test (still uses `testLoginWithMagicLink`, still uses test mode)

**Why first**: The entire Phase 2 plan depends on this RPC pattern working. If WebSocket objects don't proxy `.close()` over RPC, we need a different approach before building anything on top of it.

### Phase 1: Implement `createTestRefreshFunction`

**Goal**: Provide the self-minting helper in `@lumenize/mesh`.

**Success Criteria**:
- [x] `createTestRefreshFunction(options)` exported from `@lumenize/mesh`
- [x] Minimal JSDoc without examples but a link to https://lumenize.com/docs/mesh/testing
- [x] Unit tests (sign a JWT, verify it's valid, check claims, verify `expired: true` throws)

**Notes**:
- New file: `packages/mesh/src/create-test-refresh-function.ts`. Lives in `@lumenize/mesh` — the package that owns LumenizeClient — so users already have it. `@lumenize/mesh` already depends on `@lumenize/auth` for `signJwt` and `importPrivateKey`.

### Phase 2: Migrate mesh for-docs tests to self-minting

**Goal**: Replace `testLoginWithMagicLink` with `createTestRefreshFunction` in all 3 for-docs test projects. Remove `LUMENIZE_AUTH_TEST_MODE` from mesh `vitest.config.js`.

**Success Criteria**:
- [x] `getting-started/index.test.ts` uses `createTestRefreshFunction` instead of `testLoginWithMagicLink`
- [x] `calls/index.test.ts` uses `createTestRefreshFunction` instead of `testLoginWithMagicLink`
- [x] `security/index.test.ts` uses `createTestRefreshFunction` instead of `testLoginWithMagicLink`
- [x] CORS test migrated: call `createTestRefreshFunction` once to get raw `accessToken` for header injection (replaces `testLoginWithMagicLink` which was only used for the token)
- [x] Forged-JWT test unchanged (uses hardcoded garbage tokens, no auth helper needed)
- [x] `security/index.test.ts` `__testForceClose` already replaced (Phase 0)
- [x] `__testForceClose` method removed from `LumenizeClientGateway` (grep confirmed no other callers)
- [x] `LUMENIZE_AUTH_TEST_MODE` removed from all 3 miniflare bindings in `vitest.config.js`
- [x] `LUMENIZE_AUTH` DO binding, `createAuthRoutes`, and `LumenizeAuth` export **kept** in entry points and wrangler.jsonc — they represent production code and may be referenced by `@check-example` annotations in `.mdx` files
- [x] All tests pass
- [x] Update comment in security test line 57: "which succeeds because createTestRefreshFunction keeps minting valid tokens" (not "which succeeds in test mode")

**Notes**:
- Tests currently get `sub` from `testLoginWithMagicLink`'s return value. With `createTestRefreshFunction`, the test controls `sub` directly — use `crypto.randomUUID()` (the default when `sub` is omitted) unless the test needs a readable name.
- The `getting-started` test is slightly different from the other two: it uses `sessionStorage` and `BroadcastChannel` via `browser.context()` rather than explicit `instanceName`. The migration pattern is the same (`createTestRefreshFunction` instead of `testLoginWithMagicLink`) but the client construction keeps those context injections.
- The `getting-started` test also has multi-client Bob scenario (lines 81-151) that isn't in the `.mdx`. Backlog item added to split that out later — don't address in this task.

### Phase 3: Rewrite `website/docs/mesh/testing.mdx`

**Goal**: Rewrite the existing `testing.mdx` to document the recommended testing patterns for users. This is a substantial rewrite — the current file is built around `testLoginWithMagicLink` and `LUMENIZE_AUTH_TEST_MODE`.

**Success Criteria**:
- [x] `createTestRefreshFunction` pattern documented as the primary integration testing approach
- [x] `createTestingClient` pattern documented as the complementary approach for isolated DO testing
- [x] Clear testing pyramid: isolated (`createTestingClient`) → integration (`LumenizeClient` + `createTestRefreshFunction`)
- [x] Example showing the full path: `createTestRefreshFunction` → LumenizeClient → Worker → auth hooks → Gateway → DO
- [x] Example: simulating network glitch via `createTestingClient` + `ctx.getWebSockets()[0].close(code)`
- [x] Example: testing `onLoginRequired` via `createTestRefreshFunction({ expired: true })`
- [x] No mention of `LUMENIZE_AUTH_TEST_MODE` in mesh docs
- [x] Note that `iss`/`aud` defaults match the auth system's defaults (`'https://lumenize.local'`); override only if `LUMENIZE_AUTH_ISSUER`/`LUMENIZE_AUTH_AUDIENCE` are set in env

**Notes**:
- `getting-started.mdx` needed one `@check-example` fix: removed literal `refresh: 'https://localhost/auth/refresh-token'` (no longer in test), replaced with `// ...`. No narrative changes needed — auth setup is in Step 5, and testing is documented in `testing.mdx`.
- Discovered `website/docs/utils/cors-support.mdx` was accidentally deleted in commit `842f8ed` ("moved Browser, WebSocketShim, etc. to @lumenize/testing") — collateral damage from bulk file operations. Restored from git history, updated `@check-example` paths from `packages/utils/test/unit/browser.test.ts` → `packages/testing/test/unit/browser.test.ts`, updated `Browser` import from `@lumenize/utils` → `@lumenize/testing`, and fixed sidebar entry (was under Testing, moved to Utils where it belongs).

### Phase 4: Narrow test mode scope

**Goal**: Ensure `LUMENIZE_AUTH_TEST_MODE` is auth-internal only.

**Success Criteria**:
- [x] All mesh tests work without test mode (confirmed in Phase 2)
- [x] `website/docs/auth/testing.mdx` documents test mode as auth-internal only
- [x] No user-facing mesh docs mention test mode

### Phase 5: Test expired refresh → `onLoginRequired` path

**Goal**: Add a test case that exercises the 4401 → refresh fails → `onLoginRequired` flow using `createTestRefreshFunction({ expired: true })`.

**Success Criteria**:
- [x] New test (or new phase within the existing security test) that: connects with a working refresh, force-closes with 4401 via `createTestingClient`, client attempts refresh which throws (expired), `onLoginRequired` fires
- [x] Validates the full path: 4401 close → client calls refresh → refresh throws → `onLoginRequired` callback invoked

**Notes**:
- This is distinct from the existing 4403 test. 4403 skips refresh entirely and fires `onLoginRequired` directly. 4401 triggers a refresh attempt first — this test proves that when refresh *fails*, `onLoginRequired` fires correctly.

### Phase 6: Update `do-conventions` skill

**Goal**: Update `.claude/skills/do-conventions/SKILL.md` to reflect the new testing patterns.

**Success Criteria**:
- [x] Section 3 (Environment Variables): Update the `LUMENIZE_AUTH_TEST_MODE` reference to recommend `createTestRefreshFunction` for mesh projects, noting test mode is auth-internal only
- [x] Section 9 (Testing): Added testing pyramid note (`createTestRefreshFunction` for integration, `createTestingClient` for isolated, with `ctx.getWebSockets()[0].close()` pattern)

## Related

- `tasks/resend-email-for-auth.md` — Origin of the self-minting pattern (Phase 3 architecture)
- `packages/auth/src/jwt.ts` — `signJwt`, `importPrivateKey` (the primitives the pattern uses)
- `packages/auth/src/hooks.ts` — `createRouteDORequestAuthHooks`, `forwardJwtRequest` (what hooks inject)
- `packages/auth/src/test-helpers.ts` — Current `testLoginWithMagicLink` (what this replaces for mesh tests)
- `packages/mesh/vitest.config.js` — Multi-project config with `LUMENIZE_AUTH_TEST_MODE` in 3 of 5 projects
- `packages/mesh/test/for-docs/getting-started/index.test.ts` — Canonical integration test (migration target)
- `website/docs/mesh/testing.mdx` — Existing testing docs (to be rewritten in Phase 3)
- `.claude/skills/do-conventions/SKILL.md` — References `LUMENIZE_AUTH_TEST_MODE` (to be updated in Phase 6)
- `tasks/backlog.md` — Backlog item added: split `getting-started/index.test.ts` for clean 1:1 with `.mdx`
