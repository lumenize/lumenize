# Nebula Phase 1.96: `verifyNebulaAccessToken`

**Phase**: 1.96
**Status**: Pending
**Package**: `@lumenize/nebula-auth`
**Depends on**: Phase 1.8 (JWT Active Scope in `aud` — complete, `tasks/archive/nebula-jwt-active-scope.md`)
**Master task file**: `tasks/nebula.md`

## Goal

Create a single `verifyNebulaAccessToken(token, env)` export from `@lumenize/nebula-auth` that encapsulates the full JWT verification pipeline: key loading (blue/green rotation), signature verification, standard claims validation (`aud`, `iss`, `sub`, `access.authScopePattern`), and the internal-consistency check `matchAccess(authScopePattern, aud)`. Returns `NebulaJwtPayload | null`.

Then consolidate the three existing verification sites in nebula-auth to call this new function as their foundation, layering their site-specific checks on top.

**Why:** Phase 2's entrypoint needs JWT verification for `onBeforeConnect`. Without this function, the entrypoint would import `getPublicKeys`, `verifyJwt`, `verifyJwtWithRotation`, `importPublicKey`, and `matchAccess` — duplicating the same key-loading and signature-verification plumbing that already exists in three places inside nebula-auth. That's too much coupling and implementation exposure. The higher-level helper lets Phase 2 import one function and pass a token.

**Why the internal consolidation:** The same key-loading → signature-verification → claims-validation sequence is copy-pasted across `verifyAndGateJwt`, `checkJwtForRegistry`, and `#verifyBearerToken`. Extracting the shared foundation into `verifyNebulaAccessToken` eliminates ~40 lines of duplication and ensures all three sites benefit from any future verification changes (e.g., adding `nbf` support, changing key rotation logic).

---

## Current State — Three Verification Sites

All three sites in `packages/nebula-auth/src/` duplicate the same core sequence:

1. **`verifyAndGateJwt`** (`router.ts` lines 273–319) — Called by `checkJwtForInstance` for instance-scoped routes. Core sequence + `matchAccess(authScopePattern, targetInstanceName)` + admin gate (`access.admin || adminApproved`).

2. **`checkJwtForRegistry`** (`router.ts` lines 365–413) — Called for registry routes. Core sequence + rate limiting. Does NOT check `access.authScopePattern` against a target (the registry handles its own authorization).

3. **`#verifyBearerToken`** (`nebula-auth.ts` lines 1142–1185) — Called by `#authenticateRequest` inside the NebulaAuth DO. Core sequence + local Subjects table lookup + wildcard fallback (`matchAccess(authScopePattern, instanceName)`). Returns `{ sub, isAdmin, email }` not `NebulaJwtPayload`.

### Shared core sequence (duplicated in all three)

```
1. Load public keys from env (JWT_PUBLIC_KEY_BLUE, JWT_PUBLIC_KEY_GREEN)
2. Import PEM → CryptoKey
3. Verify signature (single key or rotation)
4. Cast to NebulaJwtPayload
5. Validate standard claims (aud non-empty, iss === NEBULA_AUTH_ISSUER, sub present)
```

Steps 1–5 are identical across all three sites (modulo slight ordering differences and the fact that `#verifyBearerToken` skips the `aud`/`iss` checks — a gap this task also fixes).

---

## Changes

### 1. New function: `verifyNebulaAccessToken` (`router.ts`)

Place it in `router.ts` alongside the existing verification functions, since it uses the same imports (`verifyJwt`, `verifyJwtWithRotation`, `importPublicKey` from `@lumenize/auth`).

```typescript
/**
 * Verify a Nebula access token: signature, standard claims, and
 * matchAccess(authScopePattern, aud) internal-consistency check.
 *
 * Returns the decoded payload if valid, null if invalid/expired.
 *
 */
export async function verifyNebulaAccessToken(
  token: string,
  env: object,
): Promise<NebulaJwtPayload | null> {
  const publicKeys = await getPublicKeys(env as Env);

  const rawPayload = publicKeys.length === 1
    ? await verifyJwt(token, publicKeys[0]!)
    : await verifyJwtWithRotation(token, publicKeys);

  if (!rawPayload) return null;

  const payload = rawPayload as unknown as NebulaJwtPayload;

  // Standard claims validation
  if (!payload.aud || typeof payload.aud !== 'string') return null;
  if (payload.iss !== NEBULA_AUTH_ISSUER) return null;
  if (!payload.sub) return null;
  if (!payload.access?.authScopePattern) return null;

  // Internal consistency: the active scope (aud) must be covered by the auth scope pattern.
  // Phase 1.8's refresh handler already prevents minting tokens that violate this, but
  // belt-and-suspenders at verification time catches tampered or stale tokens.
  if (!matchAccess(payload.access.authScopePattern, payload.aud)) return null;

  return payload;
}
```

**`env: object` not `env: Env`.** The global `Env` type is generated per-package by `wrangler types`. Since `verifyNebulaAccessToken` is exported for use by other packages (e.g., `apps/nebula/`), the parameter type must be `object`. Internally it casts to the local `Env` to access `JWT_PUBLIC_KEY_BLUE`/`JWT_PUBLIC_KEY_GREEN`. This follows the pattern documented in CLAUDE.md: "Only for code in shared packages whose functions are called by multiple packages, each with a different generated `Env`."

**Returns `null` not error responses.** The three existing sites each wrap failures differently (`{ error: Response }`, `Response`, `null`). The new function returns `null` for any failure — callers construct their own error responses. This keeps the function transport-agnostic and usable from both the router (HTTP responses) and the DO (`#verifyBearerToken` returns `{ sub, isAdmin, email } | null`).

### 2. Refactor `verifyAndGateJwt` to use `verifyNebulaAccessToken`

```typescript
async function verifyAndGateJwt(
  token: string,
  env: Env,
  targetInstanceName: string,
): Promise<{ payload: NebulaJwtPayload } | { error: Response }> {
  const payload = await verifyNebulaAccessToken(token, env);
  if (!payload) {
    return { error: json401('invalid_token', 'Token is invalid or expired') };
  }

  // Target-specific check: does the auth scope pattern cover this specific instance?
  // This is a DIFFERENT check from verifyNebulaAccessToken's matchAccess(authScopePattern, aud).
  // That check validates internal consistency (aud within auth scope).
  // This check validates the token grants access to the target instance.
  if (!matchAccess(payload.access.authScopePattern, targetInstanceName)) {
    return {
      error: jsonError(403, 'insufficient_scope',
        `Token access "${payload.access.authScopePattern}" does not grant access to "${targetInstanceName}"`),
    };
  }

  // Access gate: admin || adminApproved
  if (!payload.access.admin && !payload.adminApproved) {
    return { error: jsonError(403, 'access_denied', 'Account not yet approved') };
  }

  return { payload };
}
```

**Signature change:** Drops `publicKeys: CryptoKey[]` parameter, adds `env: Env`. The caller (`checkJwtForInstance`) no longer calls `getPublicKeys` — `verifyNebulaAccessToken` handles it internally.

### 3. Refactor `checkJwtForInstance` — remove `getPublicKeys` call

```typescript
async function checkJwtForInstance(
  request: Request,
  env: Env,
  instanceName: string,
): Promise<Response | null> {
  // ... existing token extraction (Bearer header or WebSocket subprotocol) ...

  // Was: const publicKeys = await getPublicKeys(env);
  // Was: const result = await verifyAndGateJwt(token, publicKeys, instanceName);
  const result = await verifyAndGateJwt(token, env, instanceName);
  if ('error' in result) return result.error;

  // ... existing rate limiting ...
  return null;
}
```

### 4. Refactor `checkJwtForRegistry` to use `verifyNebulaAccessToken`

```typescript
async function checkJwtForRegistry(
  request: Request,
  env: Env,
): Promise<{ payload: NebulaJwtPayload } | { error: Response }> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: json401('invalid_request', 'Missing Authorization header with Bearer token') };
  }

  const token = authHeader.slice(7);
  const payload = await verifyNebulaAccessToken(token, env);
  if (!payload) {
    return { error: json401('invalid_token', 'Token is invalid or expired') };
  }

  // Rate limiting (registry-specific — not part of verifyNebulaAccessToken)
  const rateLimiter = env.NEBULA_AUTH_RATE_LIMITER;
  if (rateLimiter) {
    const { success } = await rateLimiter.limit({ key: payload.sub });
    if (!success) {
      return { error: jsonError(429, 'rate_limited', 'Too many requests. Please try again later.') };
    }
  }

  return { payload };
}
```

**Key change:** Two checks that were previously absent from `checkJwtForRegistry` are now included via `verifyNebulaAccessToken`: (1) `access.authScopePattern` presence validation, and (2) `matchAccess(authScopePattern, aud)` internal consistency. Before, the registry relied solely on its own authorization logic (`#hasAdminOverUniverse`). This is a free belt-and-suspenders improvement — existing tests use properly-minted tokens that satisfy both checks.

### 5. Refactor `#verifyBearerToken` in NebulaAuth DO

```typescript
async #verifyBearerToken(token: string): Promise<
  { sub: string; isAdmin: boolean; email: string } | null
> {
  const payload = await verifyNebulaAccessToken(token, this.env);
  if (!payload) return null;

  // Local subject lookup — does this subject exist in THIS NebulaAuth instance?
  const rows = this.#sql`
    SELECT email, isAdmin FROM Subjects WHERE sub = ${payload.sub}
  ` as any[];

  if (rows.length > 0) {
    return {
      sub: payload.sub,
      isAdmin: Boolean(rows[0].isAdmin),
      email: rows[0].email,
    };
  }

  // Wildcard fallback: cross-scope admin access (e.g., universe admin → star DO)
  // verifyNebulaAccessToken already validated matchAccess(authScopePattern, aud).
  // Here we check if the auth scope pattern also covers THIS instance specifically.
  if (payload.email && payload.access.admin) {
    if (matchAccess(payload.access.authScopePattern, this.#instanceName)) {
      return {
        sub: payload.sub,
        isAdmin: payload.access.admin,
        email: payload.email,
      };
    }
  }

  return null;
}
```

**Key improvement:** The old `#verifyBearerToken` skipped `aud`/`iss`/`authScopePattern` validation — it only checked signature + `sub`. Now those standard claims are validated by `verifyNebulaAccessToken`. This closes a gap where the DO would accept tokens with invalid `aud` or `iss` if the signature was valid and the `sub` existed locally.

**Import needed:** `verifyNebulaAccessToken` must be importable from within the same package. Since it lives in `router.ts` and `#verifyBearerToken` lives in `nebula-auth.ts`, use a relative import: `import { verifyNebulaAccessToken } from './router'`. See "Circular Dependency Risk" section below — if a circular dependency exists, extract to `verify.ts` instead.

### 6. Export from `index.ts`

```typescript
// JWT verification — primary export for consuming packages (Phase 2 entrypoint)
export { verifyNebulaAccessToken } from './router';
```

**What stays exported:** `matchAccess` (Phase 2's router layers its own `matchAccess(authScopePattern, targetInstanceName)` on top, and it's useful for downstream access control), `buildAuthScopePattern` (used by Phase 2 tests that construct JWTs). `getPublicKeys` is not currently exported and should stay that way — verify after refactoring that it remains a private implementation detail of `router.ts`.

---

## Circular Dependency Risk

`nebula-auth.ts` (DO class) currently does NOT import from `router.ts`. Adding `import { verifyNebulaAccessToken } from './router'` could create a circular dependency if `router.ts` imports from `nebula-auth.ts` (it currently imports the DO class for type references, but check).

**Mitigation if circular:** Extract `verifyNebulaAccessToken` and `getPublicKeys` into a new `verify.ts` file. Both `router.ts` and `nebula-auth.ts` import from `verify.ts`. This is the cleanest approach since the verification logic is genuinely shared infrastructure, not specific to the router.

Check during implementation:
1. Does `router.ts` import from `nebula-auth.ts`?
2. If yes, extract to `verify.ts`
3. If no, the relative import from `router.ts` is fine

---

## Test Updates

### Existing tests — no behavioral changes expected

All existing tests should continue to pass. The refactoring doesn't change any behavior:

- `verifyAndGateJwt` still validates the same claims in the same order and produces the same error responses
- `checkJwtForRegistry` gains `authScopePattern` presence validation AND `matchAccess(authScopePattern, aud)` internal consistency (both previously absent), but existing tests use properly-minted tokens where both checks pass
- `#verifyBearerToken` gains `aud`/`iss`/`authScopePattern` validation (previously absent), but existing tests use properly-minted tokens where these checks pass

If any existing test constructs a token with an invalid `aud`, `iss`, or missing `authScopePattern` that previously passed through `checkJwtForRegistry` or `#verifyBearerToken`, that test will now fail (correctly — the gap is fixed).

### New tests for `verifyNebulaAccessToken`

Add a new test file `test/verify-access-token.test.ts` (or add a describe block to an existing test file):

**Valid tokens:**
- Token with matching `authScopePattern` and `aud` (exact match) → returns `NebulaJwtPayload`
- Token with wildcard `authScopePattern` covering `aud` (e.g., `"acme.*"` covering `"acme.app.tenant-a"`) → returns payload
- Universe-level token (`aud: "acme"`, `authScopePattern: "acme.*"`) → returns payload

**Invalid tokens:**
- Expired token → `null`
- Bad signature → `null`
- Missing `aud` → `null`
- Missing `sub` → `null`
- Wrong `iss` → `null`
- Missing `access.authScopePattern` → `null`
- `aud` NOT covered by `authScopePattern` (e.g., `aud: "acme.app.tenant-a"`, `authScopePattern: "acme.app.tenant-b"`) → `null`
- Empty string token → `null`

**Key rotation:**
- Token signed with blue key when both blue and green are present → returns payload
- Token signed with green key when both are present → returns payload
- Token signed with an unknown key → `null`

### Test helper for signing test tokens

Tests need to mint JWTs with specific claims. Either reuse nebula-auth's test-mode login flow (slower, more realistic) or create a lightweight helper that signs JWTs with the test private keys. The existing test infrastructure already has test keys in `.dev.vars` — reuse those.

---

## Implementation Order

1. **Check for circular dependency** between `router.ts` and `nebula-auth.ts`. If exists, create `verify.ts`.
2. **Create `verifyNebulaAccessToken`** in `router.ts` (or `verify.ts`).
3. **Refactor `verifyAndGateJwt`** to call `verifyNebulaAccessToken`. Run existing tests — should all pass.
4. **Refactor `checkJwtForInstance`** to drop `getPublicKeys` call. Run existing tests.
5. **Refactor `checkJwtForRegistry`** to call `verifyNebulaAccessToken`. Run existing tests.
6. **Refactor `#verifyBearerToken`** to call `verifyNebulaAccessToken`. Run existing tests — watch for tokens that now fail due to stricter validation.
7. **Add export** to `index.ts`.
8. **Write new tests** for `verifyNebulaAccessToken` directly.
9. **Verify all existing tests pass** (264 tests across all nebula-auth test files).

---

## Non-Goals

- **Rate limiting inside `verifyNebulaAccessToken`**: Rate limiting is site-specific (some callers don't need it, rate limiter binding may not exist). Callers add their own rate limiting after verification.
- **Error response construction**: The function returns `null`, not HTTP responses. Callers construct responses appropriate to their context.
- **Changing `matchAccess` behavior**: The function uses `matchAccess` as-is.
- **Admin gate**: The `admin || adminApproved` check in `verifyAndGateJwt` is specific to instance routes — not part of the general verification function.
- **Token extraction**: The function takes a raw token string, not a `Request`. Token extraction (from Bearer header, WebSocket subprotocol, cookie) is the caller's responsibility.
- **`email` field in payload**: `verifyNebulaAccessToken` validates standard claims but doesn't require `email` (it's not in every token). The DO's `#verifyBearerToken` checks `email` for its wildcard fallback path.

## Success Criteria

- [ ] `verifyNebulaAccessToken(token, env)` exported from `@lumenize/nebula-auth`
- [ ] Returns `NebulaJwtPayload | null` — `null` for any verification failure
- [ ] Validates: signature (with key rotation), `aud` (non-empty string), `iss` (matches `NEBULA_AUTH_ISSUER`), `sub` (present), `access.authScopePattern` (present), `matchAccess(authScopePattern, aud)` (internal consistency)
- [ ] `env` parameter typed as `object` (usable from any package's `Env`)
- [ ] `verifyAndGateJwt` refactored to call `verifyNebulaAccessToken` + target-specific `matchAccess` + admin gate
- [ ] `checkJwtForInstance` no longer calls `getPublicKeys` directly
- [ ] `checkJwtForRegistry` refactored to call `verifyNebulaAccessToken` + rate limiting
- [ ] `#verifyBearerToken` refactored to call `verifyNebulaAccessToken` + local subject lookup + wildcard fallback
- [ ] `#verifyBearerToken` now validates `aud`, `iss`, `authScopePattern` (gap closed)
- [ ] No circular dependencies between `router.ts` and `nebula-auth.ts` (extract to `verify.ts` if needed)
- [ ] New tests cover valid tokens, invalid tokens, and key rotation scenarios
- [ ] All existing nebula-auth tests pass (264 tests)
- [ ] `getPublicKeys` remains unexported (internal implementation detail)
- [ ] `matchAccess` and `buildAuthScopePattern` remain exported (used by Phase 2)
