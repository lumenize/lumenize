# JWT Active Scope in `aud` Claim

**Phase**: 1.8
**Status**: Pending
**Package**: `@lumenize/nebula-auth`
**Depends on**: Phase 1.7 (Mesh Gateway Fix — complete)
**Master task file**: `tasks/nebula.md`

## Goal

Put the active scope (universeGalaxyStarId) into the JWT `aud` claim. The refresh endpoint requires an `activeScope` field in the JSON request body; the server validates the requested scope is covered by the user's `access` pattern, then mints the access token with `aud` set to that scope.

This eliminates the `~`-delimited Gateway instanceName from Phase 2's design. NebulaClient goes back to standard `${sub}.${tabId}` format. All active-scope information lives in the JWT itself.

## Why `aud`

Per RFC 7519, `aud` identifies the intended recipient of the token. The active universeGalaxyStarId IS the intended recipient — "this token is for the `acme.crm.tenant-a` service." This is semantically correct and enables standard JWT audience validation at the Nebula app entrypoint.

A custom JWT claim (e.g., `activeScope`) was considered but rejected: it wouldn't participate in standard JWT `aud` validation, and having both `aud` and a custom claim would be redundant. The active scope goes in `aud`; the request body field is named `activeScope` to pair with `authScope`.

## Impact on Phase 2

This phase simplifies Phase 2 significantly:

- **instanceName goes back to standard** `${sub}.${tabId}` (Lumenize Mesh default). No `~` delimiter, no custom parsing, no injection surface.
- **NebulaClientGateway simplifies** — `onBeforeAccept` reads the active scope from `connectionInfo.claims.aud` (JWT claims are auto-included after Phase 1.7) instead of parsing it from instanceName.
- **Entrypoint simplifies** — `onBeforeConnect` checks the JWT's `aud` claim instead of parsing `~` from the instanceName.
- **Access token is single-scope** — switching active scope requires a new access token (refresh call with different `activeScope` in the body). The refresh token stays multi-scope.

## Changes

### 0. Rename `access.id` → `access.authScopePattern` and `buildAccessId` → `buildAuthScopePattern`

The field and function names are updated to reflect their purpose — they represent a wildcard-decorated auth scope pattern (e.g., `"acme.*"`), not an ID. This rename touches:

- **`AccessEntry.id` → `AccessEntry.authScopePattern`** in `types.ts`
- **`buildAccessId()` → `buildAuthScopePattern()`** in `parse-id.ts` and its export in `index.ts`
- **All references in `nebula-auth.ts`**: `#generateAccessToken` (builds the access claim), `#verifyBearerToken` (wildcard fallback check)
- **All references in `router.ts`**: `verifyAndGateJwt` (checks `payload.access.authScopePattern`), error messages
- **All references in `nebula-auth-registry.ts`**: `#isUniverseAdmin` checks `access.authScopePattern` against `'*'`, `${universe}.*`, and exact universe match
- **All test files**: manually-constructed JWTs and assertions that reference `access.id`

```typescript
// types.ts
export interface AccessEntry {
  /** Auth scope pattern — universeGalaxyStarId or wildcard (e.g. "george-solopreneur.*") */
  authScopePattern: string;
  /** true = admin of this scope; omitted when false (keeps JWT compact) */
  admin?: boolean;
}
```

### 1. `#generateAccessToken` — require `activeScope`

The `activeScope` parameter is required — callers must always be explicit about what scope they're minting for. Since `actorSub` is truly optional but comes before `activeScope` positionally, use an options object:

```typescript
async #generateAccessToken(
  subject: Subject,
  opts: { activeScope: string; actorSub?: string },
): Promise<string> {
  // ... existing key setup ...

  // Defense-in-depth: callers (#handleRefreshToken, #handleDelegatedToken) already
  // validate this, but the private method re-checks so future callers can't skip it.
  const authScopePattern = buildAuthScopePattern(this.#instanceName);
  if (!matchAccess(authScopePattern, opts.activeScope)) {
    throw new Error(`Requested scope "${opts.activeScope}" not covered by access pattern "${authScopePattern}"`);
  }

  const payload: NebulaJwtPayload = {
    iss: NEBULA_AUTH_ISSUER,
    aud: opts.activeScope,      // was: NEBULA_AUTH_AUDIENCE (static)
    sub: subject.sub,
    // ... rest unchanged ...
    ...(opts.actorSub ? { act: { sub: opts.actorSub } } : {}),
  };

  return signJwt(payload as any, privateKey, activeKey);
}
```

### 2. `#handleRefreshToken` — require `activeScope` in request body

The refresh endpoint is already a POST. The `activeScope` field is required in the JSON body. The body also provides extensibility for future fields (e.g., `requested_claims`, `token_lifetime`).

```typescript
async #handleRefreshToken(request: Request): Promise<Response> {
  // ... existing refresh token cookie validation first (authenticate before parsing body) ...

  // Parse activeScope from JSON body (required)
  const contentType = request.headers.get('Content-Type');
  if (!contentType?.includes('application/json')) {
    return this.#errorResponse(400, 'invalid_request', 'Content-Type must be application/json');
  }

  const body = await request.json() as { activeScope?: string };
  if (!body.activeScope) {
    return this.#errorResponse(400, 'invalid_request', 'Missing required "activeScope" field');
  }

  // Validate activeScope against access pattern
  const authScopePattern = buildAuthScopePattern(this.#instanceName);
  if (!matchAccess(authScopePattern, body.activeScope)) {
    return this.#errorResponse(403, 'insufficient_scope',
      `Requested scope "${body.activeScope}" not covered by access pattern "${authScopePattern}"`);
  }

  const newAccessToken = await this.#generateAccessToken(subject, { activeScope: body.activeScope });
  // ... rest unchanged ...
}
```

**Request format:**

```
POST /auth/acme/refresh-token
Content-Type: application/json
Cookie: refresh-token=...

{ "activeScope": "acme.crm.tenant-a" }
```

### 3. Delegated token endpoint — require `activeScope` in request body

Same pattern as refresh. The delegating user specifies which scope the delegated token targets. The server validates the principal's access pattern covers the requested scope.

```typescript
// In #handleDelegatedToken — body already parsed for actFor
// activeScope is now also required:
const { actFor, activeScope } = body as { actFor: string; activeScope: string };

if (!activeScope) {
  return this.#errorResponse(400, 'invalid_request', 'Missing required "activeScope" field');
}

const authScopePattern = buildAuthScopePattern(this.#instanceName);
if (!matchAccess(authScopePattern, activeScope)) {
  return this.#errorResponse(403, 'insufficient_scope', '...');
}

const accessToken = await this.#generateAccessToken(principal, { activeScope, actorSub: auth.sub });
```

### 4. `verifyAndGateJwt` — remove static audience check

The router's JWT verification no longer checks `aud` against `NEBULA_AUTH_AUDIENCE`. Authorization is handled by `matchAccess(payload.access.authScopePattern, targetInstanceName)` which is already present (field renamed in Change 0). The `aud` field is consumed by the Nebula app layer (entrypoint + Gateway), not by nebula-auth's router.

```typescript
// Remove:
if (payload.aud !== NEBULA_AUTH_AUDIENCE) {
  return { error: json401('invalid_token', 'Token audience mismatch') };
}

// Keep:
if (payload.iss !== NEBULA_AUTH_ISSUER) { ... }
if (!payload.sub) { ... }
if (!payload.access?.authScopePattern) { ... }
if (!matchAccess(payload.access.authScopePattern, targetInstanceName)) { ... }
```

Add a basic sanity check that `aud` is a non-empty string:

```typescript
if (!payload.aud || typeof payload.aud !== 'string') {
  return { error: json401('invalid_token', 'Token missing audience claim') };
}
```

### 5. `checkJwtForRegistry` — same audience change

Remove static `NEBULA_AUTH_AUDIENCE` check. Add non-empty string check. Note: this function returns `Response | null` directly (not `{ error }` like `verifyAndGateJwt`):

```typescript
// Remove:
if (payload.aud !== NEBULA_AUTH_AUDIENCE) {
  return json401('invalid_token', 'Token audience mismatch');
}

// Add:
if (!payload.aud || typeof payload.aud !== 'string') {
  return json401('invalid_token', 'Token missing audience claim');
}
```

Also update `#isUniverseAdmin` in `nebula-auth-registry.ts` — it checks `access.authScopePattern` (was `access.id`) against `'*'`, `${universe}.*`, and exact universe match.

### 6. Remove `NEBULA_AUTH_AUDIENCE` constant

Delete `NEBULA_AUTH_AUDIENCE` from `types.ts` and all imports. It's no longer used anywhere.

### 7. Update `NebulaJwtPayload` JSDoc

```typescript
export interface NebulaJwtPayload {
  /** Issuer — always NEBULA_AUTH_ISSUER */
  iss: string;
  /** Audience — the active universeGalaxyStarId this token is scoped to.
   *  Set from the required `activeScope` field in the refresh/delegation request body. */
  aud: string;
  // ... rest unchanged ...
}
```

### 8. Export `matchAccess` and `buildAuthScopePattern`

`matchAccess` is already exported. `buildAuthScopePattern` replaces the existing `buildAccessId` export (Change 0). Phase 2 imports both for the entrypoint's defense-in-depth check.

## Test Updates

### Tests that reference `access.id` or `buildAccessId`

All manually-constructed JWTs and assertions that reference `access.id` must be updated to `access.authScopePattern` (Change 0). Similarly, any test imports of `buildAccessId` become `buildAuthScopePattern`.

### Tests that check `aud === NEBULA_AUTH_AUDIENCE`

- `nebula-auth.test.ts` line 359: `expect(parsed.aud).toBe('https://nebula.lumenize.com')` → `expect(parsed.aud).toBe(activeScope)` (whatever activeScope was passed in the refresh body)
- All manually-constructed JWTs in `nebula-auth-routes.test.ts` that set `aud: NEBULA_AUTH_AUDIENCE` → set `aud: instanceName` (the specific scope being tested)

### Tests that check "wrong audience" rejection

- `nebula-auth-routes.test.ts` "rejects JWT with wrong audience" → Remove or repurpose. The router no longer rejects on audience mismatch. Could become "rejects JWT with missing audience claim" (empty string or missing).

### Existing refresh tests must send `activeScope` in body

All existing tests that call `POST /refresh-token` must now send `Content-Type: application/json` with `{ "activeScope": "..." }`. For star-level tests, the activeScope is the instanceName (auth scope = active scope). This is explicit, not a default.

### New tests for `activeScope` in refresh body

- Refresh with `{ "activeScope": "..." }` matching access pattern → access token has `aud = activeScope`
- Refresh without body → 400 `invalid_request` (missing activeScope)
- Refresh with `{}` (no activeScope field) → 400 `invalid_request` (missing activeScope)
- Refresh with `activeScope` NOT covered by access pattern → 403 `insufficient_scope`
- Universe admin refresh with `{ "activeScope": "acme.crm.tenant-a" }` → access token has `aud = "acme.crm.tenant-a"`
- Refresh with `activeScope` on star-level instance where activeScope = instanceName → works (identity case)

### New tests for `activeScope` in delegated token body

- Same scope validation pattern as refresh
- Delegated token with explicit activeScope → `aud = activeScope`, `act.sub` present
- Delegated token without activeScope → 400

## Non-Goals

- **`iss` claim change**: Currently static `NEBULA_AUTH_ISSUER`. Could be changed to identify the minting NebulaAuth DO instance (e.g., `"https://nebula.lumenize.com/auth/acme.crm.tenant-a"`). Deferred — `iss` should align with the signing key strategy, and all NebulaAuth DOs currently share the same key rotation scheme. Revisit if we ever need per-instance signing keys.
- **`nbf` (not before) claim**: Not needed currently. Could enforce a delay on freshly-minted tokens if ever needed.
- **Array `aud` support**: RFC 7519 allows `aud` to be an array. Single string is sufficient — the token is single-scoped by design.

## Success Criteria

- [ ] `#generateAccessToken` requires `activeScope` via options object; `aud = opts.activeScope`; validates with `matchAccess`
- [ ] `#handleRefreshToken` requires `activeScope` in JSON request body; 400 if missing, 403 if not covered
- [ ] Delegated token endpoint requires `activeScope` in request body with same validation
- [ ] `verifyAndGateJwt` no longer checks `aud` against static constant; checks `aud` is non-empty string
- [ ] `checkJwtForRegistry` updated similarly
- [ ] `NEBULA_AUTH_AUDIENCE` constant removed
- [ ] `NebulaJwtPayload.aud` JSDoc updated
- [ ] All existing tests updated to send `activeScope` in refresh body
- [ ] New tests for missing/invalid activeScope (400, 403)
- [ ] New tests for `activeScope` in delegated token body
- [ ] `AccessEntry.id` renamed to `AccessEntry.authScopePattern`; `buildAccessId` renamed to `buildAuthScopePattern`
- [ ] Registry's `#isUniverseAdmin` updated to use `access.authScopePattern`
- [ ] All existing nebula-auth tests pass
