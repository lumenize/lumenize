# Nebula Auth Security Hardening

**Phase**: 1.9
**Status**: Pending
**Package**: `packages/nebula-auth/`
**Depends on**: Phase 1.8 (JWT Active Scope in `aud` — complete)
**Master task file**: `tasks/nebula.md`

## Goal

Harden `@lumenize/nebula-auth` against vulnerabilities identified during security review. All fixes are in `packages/nebula-auth/` — no changes to `apps/nebula/` or other packages.

---

## Findings and Fixes

### Fix 1: Invite Token Replay (HIGH)

**Problem:** `#handleAcceptInvite` validates the invite token but never deletes it from the `InviteTokens` table. An intercepted invite URL can be replayed for up to 7 days (`INVITE_TTL`), generating unlimited new sessions. Compare with `#handleMagicLink` which correctly deletes after use.

**Fix:** Add `this.#sql\`DELETE FROM InviteTokens WHERE token = ${token}\`` after successful validation in `#handleAcceptInvite`.

**Test:** Add a test that accepts an invite, then attempts to accept the same invite again — second attempt must return 400/401.

**File:** `src/nebula-auth.ts` — `#handleAcceptInvite`

---

### Fix 2: `discover` Endpoint Missing Turnstile (MEDIUM)

**Problem:** The `discover` endpoint is not in the `TURNSTILE_ENDPOINTS` set and has no rate limiting. An attacker can enumerate email-to-organization mappings by brute-forcing the endpoint.

**Fix:** Add `'discover'` to the `TURNSTILE_ENDPOINTS` set in `src/router.ts`.

**Test:** Add a test that calls `discover` without a Turnstile token and expects rejection (matching the pattern of existing Turnstile tests).

**File:** `src/router.ts` — `TURNSTILE_ENDPOINTS`

---

### Fix 3: Registry Uses `parseJwtUnsafe` (MEDIUM)

**Problem:** The registry's `create-galaxy` handler re-extracts the JWT payload using `parseJwtUnsafe` (no signature check), trusting the router already verified it. If the registry DO is ever reached via RPC bypassing the router, a crafted JWT with `access.admin: true` would grant platform admin access.

**Fix:** Pass the verified `NebulaJwtPayload` from the router to the registry as an RPC parameter or request body field, instead of re-extracting from the raw `Authorization` header inside the registry. The registry should never import or call `parseJwtUnsafe`.

**Design consideration:** The router already verifies the JWT and has the payload. The cleanest approach is to pass the verified payload in the request body (JSON) when the router forwards to the registry's `fetch()`. This keeps the registry's `fetch()` handler self-contained — it reads the trusted payload from the body rather than the header. Name the field `verifiedPayload` (or `verifiedAccess` if only the access claim is needed) to make the trust boundary explicit at the call site and in the registry handler.

**Test:** Existing `create-galaxy` tests should continue to pass. Add a test (or assertion) confirming the registry no longer reads `Authorization` header for `create-galaxy`.

**Files:** `src/router.ts` (pass payload in body), `src/nebula-auth-registry.ts` (read from body, remove `parseJwtUnsafe` import)

---

### Fix 4: Remove Public Key Cache (MEDIUM)

**Problem:** The module-level `_publicKeysCache` in the router caches imported `CryptoKey` objects indefinitely. During key rotation or compromise, revoked keys persist until the Worker cold-starts.

**Fix:** Remove the `_publicKeysCache` variable and always import keys fresh from env in `getPublicKeys`. Ed25519 `crypto.subtle.importKey` completes in microseconds — the cache saves negligible time while creating a stale-key risk during rotation. Workers reuse isolates across requests, so the module-level cache persists longer than expected.

**Test:** Existing JWT verification tests should continue to pass. No new test needed — this is a simplification, not a behavioral change.

**File:** `src/router.ts` — `getPublicKeys` (remove `_publicKeysCache`, import fresh each call)

---

### Fix 5: DO-Level `adminApproved` Check (MEDIUM)

**Problem:** The router checks `adminApproved` before forwarding to the DO, but the DO's `#authenticateRequest` / `#verifyRefreshTokenIdentity` does not. If the DO is accessed via Workers RPC (bypassing router), an unapproved user with a valid refresh token could authenticate.

**Fix:** Add an `adminApproved` check in `#verifyRefreshTokenIdentity`. If the subject exists but `adminApproved` is false, return an error rather than a valid identity.

**Test:** Add a test that creates an unapproved subject, issues a refresh token, then attempts to use it directly against the DO — should be rejected.

**File:** `src/nebula-auth.ts` — `#verifyRefreshTokenIdentity`

---

### Fix 6: Email Validation on Registry Claim Paths (LOW)

**Problem:** Registry's `claimUniverse` and `claimStar` pass emails directly to `createSubjectAndSendMagicLink` via RPC without validating format. The NebulaAuth DO validates emails in `#handleEmailMagicLink`, but the RPC path from the registry bypasses this.

**Fix:** Add email format validation (basic regex: contains `@` with non-empty local and domain parts) in the registry's `claimUniverse` and `claimStar` methods before calling the NA DO.

**Test:** Call `claimUniverse` with an invalid email — should return 400.

**File:** `src/nebula-auth-registry.ts` — `claimUniverse`, `claimStar`

---

### Fix 7: Instance Name Validation in Router (LOW)

**Problem:** The `parsePath` function passes the instance name directly to `env.NEBULA_AUTH.getByName()` without validating it matches the expected `universeGalaxyStarId` format. While Cloudflare handles arbitrary strings safely, validation prevents misuse.

**Fix:** Validate instance name format in `parsePath` using `parseId()` from `parse-id.ts` — it splits on dots, validates each segment via `isValidSlug`, and enforces the 1-3 tier structure. Return 400 if `parseId()` throws. Note: `isValidSlug` alone rejects dots, so it cannot be used directly on composite instance names like `acme.crm.tenant`.

**Test:** Request with a malformed instance name (e.g., containing `../`, special chars, or more than 3 tiers) — should return 400.

**File:** `src/router.ts` — `parsePath` (add import of `parseId` from `./parse-id`)

---

## Out of Scope

- **`createSubjectAndSendMagicLink` RPC caller validation** (was Fix 6) — `ctx.id.name` is unreliable in Cloudflare (known platform issue). The `origin` parameter comes from `url.origin` of the incoming request, which Cloudflare's edge validates against configured routes — not caller-controlled. The `instanceName` parameter is only passed by the registry, which already validates slugs. Defense-in-depth benefit doesn't justify the constraint on deployment flexibility or reliance on an unreliable API.
- **Delegated token inheriting admin privileges** (Info) — standard RFC 8693 behavior; document in Phase 2 docs.
- **CSRF beyond SameSite=Strict** (Info) — adequate for the deployment model; revisit if shared-domain hosting becomes a requirement.
- **Test mode safeguards** (Low) — already mitigated by router JWT check on non-auth-flow endpoints; the env var gate is sufficient.

---

## Implementation Order

Fixes are ordered by severity and dependency:

1. Fix 1 (invite replay) — one-line fix, highest severity
2. Fix 5 (adminApproved in DO) — defense-in-depth, standalone
3. Fix 3 (registry parseJwtUnsafe) — touches router + registry
4. Fix 2 (discover Turnstile) — one-line fix, needs test update
5. Fix 4 (remove public key cache) — router simplification
6. Fix 6 (email validation in registry) — small addition
7. Fix 7 (instance name validation) — small addition

---

## Success Criteria

- [ ] Invite tokens are single-use (deleted before processing, matching `#handleMagicLink` pattern)
- [ ] `discover` endpoint requires Turnstile verification
- [ ] Registry never uses `parseJwtUnsafe` — verified payload passed from router
- [ ] Public key cache removed — keys imported fresh each request
- [ ] DO-level auth rejects unapproved subjects (return `null` from `#verifyRefreshTokenIdentity`)
- [ ] Registry validates email format before RPC calls
- [ ] Router rejects malformed instance names (via `parseId()`)
- [ ] All existing tests continue to pass
- [ ] New tests cover each fix's specific scenario
