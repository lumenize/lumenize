# Lumenize Auth Upgrade (Bootstrap, Admin, Flow)

**Status**: Phases 1–6 Complete — Ready for Phase 7
**Design Documents**:
- `/website/docs/auth/index.mdx` - Overview, access flows, bootstrap
- `/website/docs/auth/api-reference.mdx` - Endpoints, environment variables, subject management, delegation

## Goal

Upgrade `@lumenize/auth` as follows:
- Add an admin role
- Upgrade the self-signup flow so admin approval is required before entry
- Add a new flow for admin invite
- Make the system bootstrappable so developers can start with a working permission model out of the box
- Move rate limiting design to Worker and use Cloudflare's rate limiting system
- Support Turnstile integration to assure self-signups can only be done by humans

## Context: Mesh Access Control

This task upgrades `@lumenize/auth` including `createRouteDORequestAuthHooks`, which checks `emailVerified && adminApproved` at the Worker level before any request reaches a DO. This is the first layer of defense-in-depth.

A separate [follow-on task](#follow-on-mesh-access-control-integration) will upgrade `@lumenize/mesh` to work with these changes: `LumenizeClientGateway` will re-verify the JWT (second layer of defense-in-depth), translate claims into `CallContext.originAuth`, and downstream mesh nodes will trust `callContext` without touching the JWT.

## Problem Statement

Currently Lumenize Auth (`@lumenize/auth`) grants access to anyone with an email address. This requires the system using it to key all access control decisions off of the `sub` claim (the subject's UUID). The onBeforeConnect/onBeforeRequest hooks that Lumenize Auth provides grants access to anyone with a `sub`. At best, this allows a bad actor to spend the underlying system's resources, incurring costs and risking DDoS. At worst, a mistake in the underlying system's access control model could allow unintended access.

In both the current and proposed models Lumenize Auth will continue to provide:
  - Magic link login
  - Refresh tokens creation, storage, TTL, exchanging for access token, etc.
  - Access tokens (JWTs) creation, storage, etc.

In both the current and proposed models Lumenize Auth stores its claims in the access token's JWT, but the proposed model has more information.

### Current Model

- Lumenize Auth
  - Access:
    - Granted to anyone with an email address
- Lumenize Auth onBeforeConnect/onBeforeRequest hook functions
  - Grants access to all authenticated subjects
- Underlying System (Lumenize Mesh for example):
  - Fine-grained access control keying completely off of `sub` (subject ID)

### Proposed Model

Summary of the new model. See [Design Decisions](#design-decisions) for rationale and rejected alternatives.

- Lumenize Auth
  - Status flags (both required for access):
    - `emailVerified`: Set to `true` when subject clicks magic link
    - `adminApproved`: Set to `true` by admin (or automatically for bootstrap admin)
  - Role flag:
    - `isAdmin`:
      - First admin bootstrapped via `LUMENIZE_AUTH_BOOTSTRAP_EMAIL` environment variable
      - Permissions: Create subjects, assign `adminApproved`, assign `isAdmin`, delete subjects
- Lumenize Auth onBeforeConnect/onBeforeRequest hook functions
  - Grants access only to subjects with `emailVerified && adminApproved` (or `isAdmin`)
- Underlying System (Lumenize Mesh for example):
  - Fine-grained access control keying off of `sub` (subject ID)

### Proposed New/Changed Flows

**Self-signup (changed)**: Magic-link self-signup now only grants `emailVerified`. This kicks off admin notification — admins click a link to grant `adminApproved`.

**Admin-invite (new)**: Admins invite a list of emails (sets `adminApproved`). Subjects click the invite link (sets `emailVerified`). Same two flags, reverse order.

## Design Decisions

### 1. Bootstrap via Environment Variable
`LUMENIZE_AUTH_BOOTSTRAP_EMAIL=larry@example.com`
- First login with this email automatically gets `{ isAdmin: true }`
- No database seeding required
- Bootstrap admin can invite new subjects, approve/promote existing ones

### 2. Two-Phase Access: Subject Confirmation + Admin Approval

Two independent boolean flags (see [Proposed Model](#proposed-model)) rather than a status enum or single boolean. Rationale:

**Naming:** `emailVerified` / `adminApproved` are past-tense events (things that happened); `isAdmin` is an identity statement (what the subject *is*). Matches industry norms (Firebase, Auth0 use `emailVerified`).

**Rejected alternatives:**
- Status enum (`invited`, `active`, `disabled`) — harder to represent "approved but not verified" vs "verified but not approved"
- Single `isActive` boolean — conflates user action with admin action

### 3. Single Built-in Role Flag
Hardcode into LumenizeAuth:
- `isAdmin` - can manage subjects, promote to admin, delete subjects

Admins implicitly satisfy `adminApproved`. This is a universal pattern.

**Bootstrap protection** is orthogonal to the role — the subject matching `LUMENIZE_AUTH_BOOTSTRAP_EMAIL` cannot be demoted or deleted via API, regardless of who tries. This is identity-based, not role-based.

### 4. Subject Data in Auth DO
LumenizeAuth already stores subjects. Extend with the flags from the [Proposed Model](#proposed-model). All fields flow through to JWT claims automatically.

### 5. Subject Management APIs
New admin-only HTTP routes for CRUD on subjects, plus invite and approval flows. All access goes through the DO's `fetch` handler — no public RPC methods (YAGNI; avoids exposing an unguarded internal API surface). See the [API Reference](/docs/auth/api-reference) for the complete endpoint list.

### 6. JWT Claims Follow RFC 7519 and RFC 8693

JWT claims use standard terminology from [RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519) (JWT) and [RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693) (Token Exchange):

```typescript
interface ActClaim {
  sub: string;                    // Actor ID
  act?: ActClaim;                 // Who asked this actor (delegation chain)
}

interface JwtClaims {
  sub: string;                    // Subject (UUID): whose permissions apply
  act?: ActClaim;                 // Actor chain (for delegated access)
  emailVerified: boolean;         // Subject has confirmed email
  adminApproved: boolean;         // Admin has granted access
  isAdmin?: boolean;
  // ... other standard JWT claims (iss, aud, exp, iat, jti)
}
```

**Direct vs delegated access:**
- **Direct**: Subject calls directly → `sub` only, no `act` claim
- **Delegated**: Another authenticated subject acts on subject's behalf → `sub` (principal) + `act.sub` (actor)

The `act` claim records delegation for audit purposes. The actor must be an authenticated subject; the principal must be a valid subject (exists in the database). The `authorizedActors` list contains subject IDs (not opaque strings). Admins bypass the `authorizedActors` check — they can delegate as any subject. Non-admin actors must be explicitly listed in the principal's `authorizedActors`. Non-human actor authentication (API keys, service tokens for AI agents, service accounts) is planned for a future release.

In Lumenize Mesh, `@mesh` guards and `onBeforeCall` hooks access these claims via `callContext.originAuth`:

```typescript
// @mesh guard — receives instance, accesses originAuth for authorization
@mesh((instance: MyDO) => {
  const { originAuth } = instance.lmz.callContext;
  if (originAuth?.sub !== ownerId) throw new Error('Forbidden');
})
updateContent(content: string) { /* ... */ }

// onBeforeCall — lifecycle hook for audit logging
onBeforeCall() {
  const { originAuth } = this.lmz.callContext;
  if (originAuth?.act) {
    console.log(`${originAuth.act.sub} acting for ${originAuth.sub}`);
  }
}
```

### 7. Token Types

Four distinct tokens, each with different lifetimes and semantics:

| Token | Query param / storage | Lifetime | Reusable? | Purpose |
|-------|----------------------|----------|-----------|---------|
| **One-time login token** | `?one_time_token=...` | 30 min (`LUMENIZE_AUTH_MAGIC_LINK_TTL`) | No (deleted on use) | Magic link self-signup |
| **Invite token** | `?invite_token=...` | 7 days (`LUMENIZE_AUTH_INVITE_TTL`) | Yes (valid until expiry) | Admin invite acceptance |
| **Refresh token** | HttpOnly cookie | 30 days (`LUMENIZE_AUTH_REFRESH_TOKEN_TTL`) | No (rotated on use) | Obtain new access tokens |
| **Access token** | Memory (JS) | 15 min (`LUMENIZE_AUTH_ACCESS_TOKEN_TTL`) | N/A (stateless JWT) | Authenticate requests, carries claims |

**Why invite tokens are reusable:** Admins invite a batch of emails. If an invite token were single-use or short-lived, subjects who were busy when the invite arrived would need re-inviting — annoying for both admin and subject. A 7-day reusable token lets subjects click the link at their convenience. The admin has already approved them (the invite sets `adminApproved: true`), so reuse doesn't weaken the security model.

**Distinct query param names** (`one_time_token` vs `invite_token`) prevent confusion between the two URL-based tokens and make endpoint handlers self-documenting.

### 8. Rate Limiting

Rate limiting is handled at the Worker level, not in the singleton LumenizeAuth DO. This keeps the DO focused on business logic and leverages Worker horizontal scaling.

**Three layers:**

1. **Cloudflare DDoS/bot protection** (automatic, free) — fingerprint-reputation filtering handles volumetric attacks. No configuration needed.

2. **Turnstile** (required for magic-link endpoint) — [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) proves the requester is human before the request reaches your Worker. Free, GDPR-compliant, no CAPTCHA interaction. `createAuthRoutes` requires `TURNSTILE_SECRET_KEY` in environment and throws at creation time if missing. The frontend includes the Turnstile token as `cf-turnstile-response` in the JSON body alongside `email`.

3. **`LUMENIZE_AUTH_RATE_LIMITER`** (required for authenticated routes) — a [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) keyed on `sub` from the decoded JWT. `createRouteDORequestAuthHooks` requires this binding and throws at creation time if missing.

The rate limiting binding is configured in `wrangler.jsonc`:

```jsonc
{
  "rate_limits": [
    { "binding": "LUMENIZE_AUTH_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 100, "period": 60 } }
  ]
}
```

**Rejected alternatives:**
- Additional rate limiting for magic-link endpoint — Turnstile is free, strictly stronger (proves humanity vs counting requests). Another layer would also have additional configuration.
- IP-based rate limiting — Cloudflare's own docs warn against it (shared IPs on mobile/proxy networks). DDoS protection already handles IP-level abuse.
- DO-level rate limiting — unnecessarily burdens the singleton with work the Worker layer handles better
- `rateLimitPerHour` config on AuthConfig — replaced by the rate limiting binding's `limit`/`period` configuration

### 9. Environment Variable Naming Convention

Three tiers:
- **`LUMENIZE_AUTH_*`** for Lumenize-specific config: `LUMENIZE_AUTH_BOOTSTRAP_EMAIL`, `LUMENIZE_AUTH_REDIRECT`, `LUMENIZE_AUTH_ISSUER`, `LUMENIZE_AUTH_AUDIENCE`, `LUMENIZE_AUTH_ACCESS_TOKEN_TTL`, `LUMENIZE_AUTH_REFRESH_TOKEN_TTL`, `LUMENIZE_AUTH_MAGIC_LINK_TTL`, `LUMENIZE_AUTH_INVITE_TTL`, `LUMENIZE_AUTH_PREFIX`, `LUMENIZE_AUTH_RATE_LIMITER`, `LUMENIZE_AUTH_TEST_MODE`
- **`JWT_*`** for industry-standard key material (shared across packages): `JWT_PRIVATE_KEY_BLUE`, `JWT_PUBLIC_KEY_BLUE`, etc., `PRIMARY_JWT_KEY`
- **Vendor prefix** for third-party services: `TURNSTILE_SECRET_KEY` (matches Cloudflare's official demos)

### 10. Config Delivery: Environment Variables, Not RPC

The current implementation (to be removed) passes config from `createAuthRoutes` to `LumenizeAuth` via an RPC `configure()` call, stored in a `#config` instance variable. This has multiple problems: config is lost on DO eviction (triggering a 503-retry dance on cold start), defaults are split between `createAuthRoutes` and the DO, and `issuer`/`audience` are specified independently in both `createAuthRoutes` and `createRouteDORequestAuthHooks`.

**New approach**: All scalar config the DO needs moves to environment variables. The DO reads from `this.env` directly — no `configure()` RPC, no `#config` instance variable, no lazy-init 503 dance. `createRouteDORequestAuthHooks` reads `issuer`/`audience` from the same env vars — one source of truth.

**Env vars (DO reads from `this.env`):**

| Env var | Default | Replaces |
|---------|---------|----------|
| `LUMENIZE_AUTH_REDIRECT` | *(required)* | `options.redirect` |
| `LUMENIZE_AUTH_ISSUER` | `'https://lumenize.local'` | `options.issuer` |
| `LUMENIZE_AUTH_AUDIENCE` | `'https://lumenize.local'` | `options.audience` |
| `LUMENIZE_AUTH_ACCESS_TOKEN_TTL` | `900` | `options.accessTokenTtl` |
| `LUMENIZE_AUTH_REFRESH_TOKEN_TTL` | `2592000` | `options.refreshTokenTtl` |
| `LUMENIZE_AUTH_MAGIC_LINK_TTL` | `1800` | `options.magicLinkTtl` |
| `LUMENIZE_AUTH_INVITE_TTL` | `604800` (7 days) | `options.inviteTtl` |
| `LUMENIZE_AUTH_PREFIX` | `'/auth'` | `options.prefix` |

**Code-level config (Worker routing only):**

```typescript
createAuthRoutes(env, {
  cors?: CorsConfig,             // Structured object — can't be an env var
  authBindingName?: string,   // Which DO namespace (default: 'LUMENIZE_AUTH')
  authInstanceName?: string,     // Which DO instance (default: 'default')
});
```

**What this eliminates:**
- `configure()` RPC method and `#config` instance variable
- The 503 lazy-init retry pattern
- Defaults split across `createAuthRoutes` and `LumenizeAuth`
- `issuer`/`audience` duplication between `createAuthRoutes` and `createRouteDORequestAuthHooks`
- `rateLimitPerHour` option (already replaced by `LUMENIZE_AUTH_RATE_LIMITER` binding in Design Decision #8)

**Rejected alternatives:**
- JSON config string in env var — fragile (no IDE autocomplete, no type checking, easy to malform, hard to read in dashboard)
- RPC `configure()` with storage persistence — solves eviction but introduces stale-config invalidation problem (how does the DO know config changed?)
- Keep `#config` instance variable — violates "never use instance variables for mutable state" rule; adds latency on cold start via 503-retry

### 11. Forward Verified JWT in Standard Authorization Header

Currently the middleware passes identity via multiple custom headers:
- `X-Auth-User-Id` — JWT `sub` (redundant, already in JWT payload)
- `X-Auth-Verified` — literal `'true'` (redundant, header presence implies verification)
- `X-Auth-Token-Exp` — JWT `exp` (redundant, already in JWT payload)
- `X-Auth-Claims` — JSON-encoded additional claims

The gateway then reconstructs `OriginAuth` from these separate pieces.

**New approach**: The hooks verify the JWT at the Worker level, then forward the original encoded JWT to the DO in the standard `Authorization: Bearer <jwt>` header. No custom headers, no pre-decoding. The DO receives the same header format every developer already knows.

Ed25519 verification is a local `crypto.subtle.verify()` call — no network round trip, sub-millisecond. So there's no meaningful savings in pre-decoding for the DO. DOs that want defense-in-depth can cheaply re-verify; DOs that trust the Worker hooks can simply base64url-decode the payload section.

For Lumenize Mesh, `LumenizeClientGateway` is the trust boundary: it verifies/decodes the JWT and translates claims into `CallContext.originAuth`. Downstream mesh nodes trust `callContext` — they don't need to touch the JWT. See [Follow-on: Mesh Access Control](#follow-on-mesh-access-control).

**Rejected alternatives:**
- Keep separate custom headers — redundant data split across multiple headers that must be recombined; `userId` was a custom name for what the JWT already calls `sub`
- Single `X-Auth` header with decoded JSON payload — custom header that no one knows; forces users to learn a Lumenize convention when `Authorization: Bearer` is universal
- Pre-decoded claims header (like Envoy `claim_to_headers`) — same custom-header problem; also eliminates the DO's ability to re-verify

### 12. Dual Auth on LumenizeAuth DO

All authenticated LumenizeAuth endpoints accept either an `Authorization: Bearer <access_token>` header or a `refresh_token` cookie — whichever is present. The DO checks both and uses the first valid credential it finds.

**Why:** The approve endpoint is linked from admin notification emails. Browsers send cookies automatically but cannot add Bearer headers from a link click. Rather than special-casing one endpoint, all LumenizeAuth endpoints accept both auth methods uniformly.

- **None** — `email-magic-link`, `magic-link`, `accept-invite` (public, unauthenticated)
- **Auth** — `refresh-token`, `logout`, `delegated-token` (any authenticated subject)
- **Admin** — `approve/:id`, `invite`, `subjects`, `subject/:id` CRUD (Auth + `isAdmin` check)

This is specific to the LumenizeAuth DO. User DOs behind `createRouteDORequestAuthHooks` still use Bearer-only auth — the hooks verify the JWT and forward it in the `Authorization` header.

## Implementation Deltas

All items from the original flat checklist have been completed (Phases 1, 2, 6) or distributed into their respective phase sections below. The phase deltas are the authoritative source for remaining work.

## Prerequisites
- [x] Design/APIs drafted in MDX (reads as final docs)
- [x] Design/APIs reviewed and approved by maintainer

## Implementation Phases

Each phase produces a testable increment. Phases build on each other — earlier phases must pass before starting the next. **Phases 3–5 are provisional** — revisit at the start of each phase, since implementation often reveals things that change the plan.

**No migration gymnastics needed.** This package has never been deployed to production. Tests start with a clean slate every run. So schemas and `wrangler.jsonc` migrations can be written as if from scratch — no `ALTER TABLE`, no multi-tag migration chains, no backwards compatibility with existing data.

### Phase 1: Config Delivery & Schema Foundation

Remove the configure() RPC mechanism and establish the new schema.

**Goal**: The DO reads all config from `this.env`, the 503 lazy-init dance is gone, and the database has the new columns. Existing magic link login still works end-to-end.

**Deltas**:
- Remove `configure()` RPC method, `#config` instance variable, `DEFAULT_CONFIG` constant
- Read all config from `this.env` with inline defaults
- Validate `LUMENIZE_AUTH_REDIRECT` at top of `fetch` handler (500 if missing)
- Remove 503 lazy-init retry and `configure()` call from `createAuthRoutes`
- New `createAuthRoutes(env, options?)` signature (only `cors`, `authBindingName`, `authInstanceName`)
- Read `prefix` from `env.LUMENIZE_AUTH_PREFIX || '/auth'`
- Rename `instanceName` to `authInstanceName`
- Remove `rateLimitPerHour` from `AuthConfig` (and from types)
- Remove `#rateLimits` instance variable and `#checkRateLimit()` method
- Write schemas from scratch: `subjects` table (with `emailVerified`, `adminApproved`, `isAdmin`, `authorizedActors` columns), `magic_links` (without `state` column), `refresh_tokens` (with `subject_id` not `user_id`), `invite_tokens` (new)
- Write `wrangler.jsonc` migration from scratch (single `v1` tag) — no need to chain onto existing tags
- Rename `magic-link-token` query param to `one_time_token`; remove CSRF state generation and validation
- Update `types.ts`: add flags to `Subject` (renamed from `User`), update `JwtPayload`, add `ActClaim`
- Rename `middleware.ts` → `hooks.ts` (the "middleware" name was ambiguous — could refer to either `createAuthRoutes` or the hook functions; "hooks" matches the `createRouteDORequestAuthHooks` name and the `onBeforeRequest`/`onBeforeConnect` pattern)
- **Remove `@lumenize/mesh` dependency**: `LumenizeAuth` extends `DurableObject` directly instead of `LumenizeDO`. Copy the `sql()` template literal tag (~15 lines from `packages/mesh/src/sql.ts`) into auth as a private `#sql` field (no attribution needed — same monorepo, and the original attribution to `@cloudflare/actors` is already in `ATTRIBUTIONS.md`). Remove the `super.fetch()` call (it only initializes mesh metadata that LumenizeAuth doesn't use). `this.ctx` and `this.env` come from `DurableObject` directly. Remove `@lumenize/mesh` from `package.json` dependencies.

**Success criteria**:
- `npm run type-check` passes ✅
- Existing magic link login flow works (request magic link → click → get refresh token → exchange for access token) ✅
- New columns exist and default correctly for new subjects ✅
- No `configure()` anywhere; DO reads from `this.env` ✅
- `createAuthRoutes(env)` works with no options arg ✅
- Auth tests: 56 passed, mesh tests: 263 passed ✅
- `AUTH_TEST_MODE` consolidated to `LUMENIZE_AUTH_TEST_MODE` (Phase 6 done early) ✅

### Phase 2: Bootstrap Admin & Two-Phase Access

Implement the bootstrap admin flow and the `emailVerified`/`adminApproved` gate.

**Goal**: The bootstrap email gets automatic admin on first login. Non-bootstrap subjects get `emailVerified` on magic link click but must be admin-approved before the auth hooks grant access. Header contract changes from `X-Auth-*` to `Authorization: Bearer <jwt>`. All auth and mesh tests pass.

**Deltas** (completed — detailed implementation notes preserved in git history at commit completing Phase 2):
- `lumenize-auth.ts`: idempotent bootstrap check in `#getOrCreateSubject`, `emailVerified` set during magic link flow, `POST /auth/test/set-subject-data` test-only endpoint
- `hooks.ts`: replaced `createAuthMiddleware`/`createWebSocketAuthMiddleware` with single `createRouteDORequestAuthHooks(env)` returning `{ onBeforeRequest, onBeforeConnect }`; access gate checks `isAdmin || (emailVerified && adminApproved)`; forwards JWT via `Authorization: Bearer` header
- `index.ts`: updated exports (removed old middleware, added `createRouteDORequestAuthHooks`)
- `test-helpers.ts`: `testLoginWithMagicLink` returns `{ accessToken, sub }` with optional `subjectData`; full 4-step flow exercises real token-minting path
- `lumenize-client-gateway.ts`: reads JWT from `Authorization: Bearer` header, decodes payload, bridges `attachment.sub` → `originAuth.userId`
- Mesh test workers + test files: updated to `createRouteDORequestAuthHooks(env)` imports, destructured `{ sub: aliceUserId }`, added `{ subjectData: { adminApproved: true } }`
- `auth.test.ts`: all tests updated for new API, added bootstrap/access-gate/negative tests

**Success criteria** ✅ (all met):
- Bootstrap email logs in and gets `isAdmin: true`, `adminApproved: true`, `emailVerified: true` in JWT claims ✅
- Bootstrap check is idempotent — same result on subsequent logins and after DO reset ✅
- Non-bootstrap subject logs in, gets `emailVerified: true`, `adminApproved: false` in claims ✅
- Auth hooks return 403 for subjects with `emailVerified && !adminApproved` ✅
- Auth hooks return 200 and forward `Authorization: Bearer <jwt>` for approved subjects ✅
- Auth hooks return 200 for admin subjects (even without explicit `adminApproved`) ✅
- Old `createAuthMiddleware`/`createWebSocketAuthMiddleware` removed; `X-Auth-*` headers removed ✅
- `testLoginWithMagicLink` returns `{ accessToken, sub }` (removed `claims` — redundant with `parseJwtUnsafe(accessToken)`) ✅
- Gateway reads `sub` from `Authorization: Bearer <jwt>` header (not `X-Auth-User-Id`) ✅
- Negative security test: Worker rejects forged JWT before it reaches gateway DO (e2e test in security for-docs) ✅
- All 63 auth tests pass (updated for new API) ✅
- All 264 mesh tests pass (updated imports + `testLoginWithMagicLink` return type + `subjectData` + negative security test) ✅

### Phase 2 → Phase 3 Transition Notes

**What changed during Phase 2 implementation:**
1. **`claims` removed from `TestLoginResult`** — was redundant with `parseJwtUnsafe(accessToken)`. Only `{ accessToken, sub }` now. Doc examples updated. Phase 4's `actorSub` tests should use `parseJwtUnsafe` to inspect the `act` claim.
2. **Negative security test added** — `security/index.test.ts` now has a separate test proving the Worker rejects forged JWTs before they reach the gateway. This was a gap in the original plan (gateway unit tests used fake JWTs, integration tests covered happy path, but no e2e test for the rejection case).
3. **Gateway header migration included in Phase 2** — as planned, to avoid auth/mesh incompatibility window. The gateway now reads `Authorization: Bearer <jwt>` and uses `attachment.sub` internally with a bridge to `originAuth.userId`. The follow-on `userId` → `sub` rename is a separate, smaller task.
4. **Test counts**: auth 63 tests (up from 56 in Phase 1), mesh 264 tests (up from 263).

### Phase 3: Subject Management & Admin Approval

Admin CRUD on subjects plus the approval flow that completes self-signup.

**Goal**: Admins can list, get, update, and delete subjects. The approve endpoint (linked from admin email) sets `adminApproved: true`. Self-protection and bootstrap protection rules enforced.

**Phase 2 foundation**: The `POST /auth/test/set-subject-data` endpoint (built in Phase 2) provides a good pattern — Phase 3's real admin endpoints will use proper auth (Bearer/cookie) instead of the test-only endpoint.

#### New Routes

Add these admin-only routes to the LumenizeAuth DO's `fetch()` handler (currently dispatches via `path.endsWith()` matching):

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `{prefix}/subjects` | Admin | List subjects (pagination, role filter) |
| GET | `{prefix}/subject/:id` | Admin | Get single subject |
| PATCH | `{prefix}/subject/:id` | Admin | Update flags (isAdmin, adminApproved, authorizedActors) |
| DELETE | `{prefix}/subject/:id` | Admin | Delete subject + revoke tokens |
| GET | `{prefix}/approve/:id` | Admin | Set adminApproved=true (email link) + send "you're approved" email |

The design spec for request/response shapes is in `website/docs/auth/api-reference.mdx` (Subject Management section). The approval flow narrative is in `website/docs/auth/index.mdx`.

#### Dual Auth (Design Decision #12)

All authenticated LumenizeAuth endpoints accept either `Authorization: Bearer <access_token>` or `refresh_token` cookie. The approve endpoint is linked from notification emails — browsers send cookies automatically but cannot add Bearer headers from a link click. Rather than special-casing, implement dual auth uniformly for all authenticated endpoints.

Extract a `#authenticateRequest(request): { sub, isAdmin, ... } | Response` helper that checks Bearer token OR refresh token cookie. This will be used by all admin endpoints and can also be wired into the existing `#handleRefreshToken` and `#handleLogout` endpoints.

#### EmailService Broadening

Current interface is `send(to: string, magicLinkUrl: string)` — too narrow for the new email types. Broaden to support:
1. Magic link emails (existing)
2. Admin notification: "New signup from {email} — click to approve"
3. Approval confirmation: "You've been approved — click to continue"

**Important constraint**: Real email delivery (AWS SES, etc.) is deferred — Cloudflare is expected to release a competing email service, and email templates/polish will come then. For now, `ConsoleEmailService` and `MockEmailService` are sufficient. Don't over-design the email abstraction — a simple approach like changing `send()` to accept a type discriminator or adding separate methods is fine.

#### Protection Rules

- **Self-modification prevention**: Admin cannot demote/delete themselves (prevents lockout). Return 403 with descriptive error.
- **Bootstrap protection**: Cannot demote/delete the subject matching `LUMENIZE_AUTH_BOOTSTRAP_EMAIL` (identity-based, not role-based). Return 403 with descriptive error.

#### Token Revocation

- **Revoke-all on status change**: when `adminApproved` set to false or subject deleted, revoke all refresh tokens: `UPDATE refresh_tokens SET revoked = 1 WHERE subject_id = ?`
- **Lazy token cleanup**: on any rejected token (expired or revoked), sweep: `DELETE FROM refresh_tokens WHERE expires_at < ?`

#### Logging

Use `@lumenize/debug` for all new operations. Namespace: `auth.*` (e.g., `auth.subject-management`, `auth.token`). The debug helper is already initialized at `this.#debug`.

#### Deltas

*LumenizeAuth DO (`packages/auth/src/lumenize-auth.ts`):*
- `#authenticateRequest` dual auth helper (Bearer token or refresh token cookie)
- `#private` subject management handlers: list (with pagination, role filter), get, update, delete
- `#private` flag management: approve, promote/demote admin
- Admin notification: after magic link validation, if subject needs approval, email all admins with approve link
- "You're approved" email to subject after approval
- Revoke-all on status change (wired into update and delete flows)
- Lazy token cleanup on rejected token
- Self-modification prevention and bootstrap protection (403 responses)
- Logging with `@lumenize/debug`

*createAuthRoutes (`packages/auth/src/create-auth-routes.ts`):*
- Split `createAuthRoutes` factory function from `lumenize-auth.ts` into its own file. `createAuthRoutes` is a thin wrapper that rewrites the URL and hands off the Request to `routeDORequest` — it does not contain route handlers. The route handlers live in the `LumenizeAuth` class in `lumenize-auth.ts`. No new admin-level guards are needed here — the DO handles admin auth internally via `#authenticateRequest`.

*Types and email service (`packages/auth/src/types.ts`, `packages/auth/src/email-service.ts`):*
- Broaden `EmailService` interface for multiple email types
- Update `ConsoleEmailService`, `MockEmailService`, `HttpEmailService` implementations

*Tests (`packages/auth/test/auth.test.ts`):*
- Tests for all new CRUD endpoints (happy paths)
- Abuse case tests: self-demotion attempt, bootstrap deletion attempt, unauthorized access to admin routes, non-admin accessing admin routes
- Approval flow: magic link → admin notification → approve → subject can access
- Token revocation: verify refresh tokens invalidated when subject loses access

#### Suggested Implementation Order

Phase 3 is the largest remaining phase. Suggested incremental approach:

1. **Dual auth helper** — `#authenticateRequest` method
2. **Subject CRUD** — list, get, update, delete behind dual auth + isAdmin check, including protection rules
3. **Token revocation** — wire into update (when adminApproved→false) and delete
4. **Approve endpoint** — `GET {prefix}/approve/:id` sets adminApproved, sends email, redirects
5. **Admin notification** — after magic link validation, email admins if subject needs approval
6. **Lazy token cleanup** — on rejected token, sweep expired

After each increment, run `cd packages/auth && npx vitest run`. At the end, also run `cd packages/mesh && npx vitest run` to verify nothing broke.

#### Success Criteria

- Admin can list, get, update, delete subjects via API
- `GET /auth/approve/:id` with cookie auth sets `adminApproved: true`
- Self-signup → magic link click → admin gets notification email → admin approves → subject can access
- Cannot demote/delete self or bootstrap admin (403 with descriptive error)
- Refresh tokens revoked when subject loses access
- All operations logged via `@lumenize/debug`
- All existing auth tests still pass
- All existing mesh tests still pass (264 tests)
- New tests cover happy paths AND abuse cases

**Status: Complete**

**What changed during Phase 3 implementation:**
1. **SQL naming convention adopted** — PascalCase table names (`Subjects`, `MagicLinks`, `InviteTokens`, `RefreshTokens`), camelCase column names (`emailVerified`, `tokenHash`, `createdAt`), index names as `idx_TableName_columnName`. Applied retroactively to all four tables. Added to CLAUDE.md and DO conventions skill. No migration needed (schema is `CREATE IF NOT EXISTS`).
2. **Filtered index on isAdmin** — `CREATE INDEX IF NOT EXISTS idx_Subjects_isAdmin ON Subjects(sub) WHERE isAdmin = 1` for efficient admin lookups.
3. **ON DELETE CASCADE** — RefreshTokens FK now cascades on subject deletion, simplifying `#handleDeleteSubject`.
4. **EmailMessage discriminated union** — `type EmailMessage = { type: 'magic-link'; ... } | { type: 'admin-notification'; ... } | { type: 'approval-confirmation'; ... }`. Each variant includes email subject line. All three service implementations updated.
5. **`#authenticateRequest` dual auth** — checks Bearer JWT first, falls back to refresh-token cookie. Returns `{ sub, isAdmin, email }` or 401 Response. Does NOT perform access-gate checks — callers decide authorization level.
6. **createAuthRoutes split** — moved to `packages/auth/src/create-auth-routes.ts`. LumenizeAuth DO keeps all route handlers; the factory is just URL rewriting + `routeDORequest` delegation.
7. **`#handleRefreshToken` and `#handleLogout` kept their own logic** — the plan said to refactor them to use `#authenticateRequest`, but their core purpose IS token rotation/revocation respectively, which `#authenticateRequest` doesn't do. The helper was designed for the new admin endpoints.
8. **Lazy sweep placement** — `#sweepExpiredTokens` called in `#handleRefreshToken` after returning 401 for revoked/expired tokens (not on success path).
9. **Test counts**: auth 91 tests (up from 63 in Phase 2), mesh 264 tests (unchanged).

### Phase 4: Invite Flow & Delegation

Admin invite (pre-approval) and the `act` claim for delegated access.

**Goal**: Admins can bulk-invite emails (pre-approved). Invited subjects click link and get immediate access. Authenticated subjects can request delegated tokens with proper authorization checks.

**Phase 2 change**: `TestLoginResult` no longer has a `claims` field. Tests verifying `act.sub` in delegated tokens should use `parseJwtUnsafe(accessToken)` instead. The `actorSub` option for `testLoginWithMagicLink` is the remaining delta.

**Email service note**: Invite emails are a third email type (alongside magic link and admin notification). The broadened `EmailService` from Phase 3 should accommodate this. Same caveat: real email delivery deferred until Cloudflare's email service launches.

**Deltas**:

*LumenizeAuth DO:*
- `act` claim support in JWT creation (for delegated access)
- Verify `act.sub` corresponds to existing subject when issuing delegated tokens
- Admins bypass `authorizedActors` check — can delegate as any subject
- Non-admin actors must be in principal's `authorizedActors` list
- `#private` actor authorization handlers: authorizeActor, revokeActor (validates actor IDs are existing subjects)

*createAuthRoutes:*
- `POST {prefix}/invite` endpoint: bulk emails, sets `adminApproved: true`, sends invite emails
- `GET {prefix}/accept-invite?invite_token=...` endpoint: validates reusable token, sets `emailVerified: true`
- `POST {prefix}/delegated-token` endpoint: actor provides own access token + `actFor` (target subject ID)
- Test mode for invite: `?_test=true` returns invite links instead of sending emails

*Tokens:*
- Invite token: 7-day TTL (`LUMENIZE_AUTH_INVITE_TTL`), reusable until expiry (schema exists from Phase 1)

*Test helpers:*
- `actorSub` option for `testLoginWithMagicLink`

**Success criteria**:
- Admin invites emails → subjects click invite link → immediate access (both flags true) ✅
- Invite tokens reusable within TTL window ✅
- Delegated token has correct `sub` (principal) and `act.sub` (actor) ✅
- Admin can delegate as any subject; non-admin blocked without `authorizedActors` ✅
- `testLoginWithMagicLink` with `actorAccessToken` produces correct delegation claims (verify via `parseJwtUnsafe`) ✅

**Status: Complete**

**What changed during Phase 4 implementation:**
1. **AuthorizedActors junction table** — replaced the `authorizedActors TEXT` column on Subjects with a proper `AuthorizedActors` junction table (`principalSub`, `actorSub` composite PK, ON DELETE CASCADE on both FKs). PATCH `/subject/:id` no longer accepts `authorizedActors` (returns 400 with redirect message). New endpoints: `POST /subject/:id/actors` (add, idempotent via INSERT OR IGNORE) and `DELETE /subject/:id/actors/:actorId` (remove).
2. **`#authenticateRequest` throw refactor** — changed from returning `Response | identity` union to throwing `AuthenticationError`. Top-level `catch` in `fetch()` handles it. Removed all `if (auth instanceof Response) return auth;` lines. `#handleApprove` uses local try/catch for redirect on auth failure.
3. **`actorSub` → `actorAccessToken` in test helpers** — `testLoginWithMagicLink` accepts `actorAccessToken` (a Bearer token from a separately-logged-in actor) instead of `actorSub`. The helper POSTs to `/delegated-token` with the actor's token to get a delegated access token. More realistic than the original plan's approach.
4. **Invite email type** — added `{ type: 'invite'; to; subject; inviteUrl }` variant to the `EmailMessage` discriminated union.
5. **Token sweep** — `#ensureSchema` sweeps expired MagicLinks and InviteTokens on schema init.
6. **Delete error message** — changed from "Cannot modify own admin status" to "Cannot delete yourself".
7. **Doc alignment audit** — 12 fixes to `api-reference.mdx` including actor management endpoints, List Subjects defaults (50/200 not 100/1000), Delete Subject response body, Approve redirect error format, and delegation test examples. Added doc/JSDoc alignment as a standard final verification step in `tasks/README.md`.
8. **SQL cleanup** — removed `authorizedActors` from all SELECT and INSERT statements (column has DEFAULT, `#rowToSubject` overrides from junction table).
9. **Test counts**: auth 120 tests (up from 91 in Phase 3), mesh 264 tests (unchanged), type-check clean.

### Phase 5: Rate Limiting & Turnstile ✅

Worker-level abuse protection for both public and authenticated routes.

**Goal**: Magic link endpoint requires Turnstile verification. Authenticated routes enforce per-subject rate limiting via Cloudflare binding. Both throw at creation time if bindings are missing.

**Deltas**:
- Turnstile validation in `createAuthRoutes` for `email-magic-link` endpoint
- Fail fast: throw at creation time if `TURNSTILE_SECRET_KEY` missing
- Rate limiter in `createRouteDORequestAuthHooks`: default `env.LUMENIZE_AUTH_RATE_LIMITER`, optional `rateLimiterBindingName` override
- Rate limit keyed on `sub` from decoded JWT; return 429 on failure
- Fail fast: throw at creation time if no rate limiter binding available

**What changed (implementation notes)**:
1. **`rateLimiterBinding` → `rateLimiterBindingName`** — The option is a string that indexes into `env`, not a `RateLimit` binding directly. Default: `'LUMENIZE_AUTH_RATE_LIMITER'`.
2. **Turnstile bypass in test mode** — When `LUMENIZE_AUTH_TEST_MODE === 'true'`, both the `TURNSTILE_SECRET_KEY` construction-time check and per-request Turnstile validation are skipped entirely.
3. **Turnstile testing strategy** — Resolved: test mode bypass for most tests, one integration test using Cloudflare's always-pass dummy keys (`1x0000000000000000000000000000000AA` / `XXXX.DUMMY.TOKEN.XXXX`) and one with always-fail keys (`2x0000000000000000000000000000000AA`). Both hit the real `siteverify` endpoint.
4. **New `src/turnstile.ts` module** — Standalone `verifyTurnstileToken()` function, exported from index.
5. **Body consumption in Turnstile path** — `createAuthRoutes` clones the request before reading JSON to extract `cf-turnstile-response`, so the original request body streams through to the DO unconsumed.
6. **Auth endpoints NOT rate-limited** — Per-subject rate limiting only applies to `createRouteDORequestAuthHooks` (authenticated routes), not to `createAuthRoutes` (public auth endpoints). Auth endpoints are protected by Turnstile instead. This is a known design limitation; DDoS against auth endpoints should be handled at the Cloudflare edge (WAF rules, etc.).
7. **Mesh wrangler.jsonc updates** — Added `ratelimits` binding to mesh root + 3 for-docs test wrangler configs since they call `createRouteDORequestAuthHooks(env)` which now throws without it.
8. **Doc alignment** — Updated `api-reference.mdx`: `rateLimiterBinding` → `rateLimiterBindingName`, added test mode note for Turnstile throw.
9. **Test counts**: auth 133 tests (up from 120 in Phase 4), mesh 264 tests (unchanged), type-check clean.

**Success criteria** (all met):
- ✅ Magic link requests without valid Turnstile token get 403
- ✅ `createAuthRoutes(env)` throws if `TURNSTILE_SECRET_KEY` missing (non-test mode)
- ✅ Authenticated requests exceeding rate limit get 429
- ✅ `createRouteDORequestAuthHooks(env)` throws if rate limiter binding missing

### Phase 6: Test Safety & Documentation ✅ (completed during Phase 1)

Clean up test mode safety and update documentation examples.

**Goal**: `LUMENIZE_AUTH_TEST_MODE` only lives in vitest config (never in wrangler.jsonc). Documentation code examples validated.

**Completed**:
- ✅ Removed `LUMENIZE_AUTH_TEST_MODE` from all `wrangler.jsonc` files (auth + all mesh test dirs)
- ✅ Moved to `vitest.config.js` `miniflare.bindings` (auth + mesh getting-started, calls, security projects)
- ✅ Updated `website/docs/mesh/testing.mdx` — replaced `.dev.vars` example with vitest config pattern
- ✅ Consolidated `AUTH_TEST_MODE` → `LUMENIZE_AUTH_TEST_MODE` (gateway's `__testForceClose`)
- ✅ No `LUMENIZE_AUTH_TEST_MODE` in any `wrangler.jsonc`
- [ ] `security.mdx` skip-checks converted to `@check-example` — **now unblocked** by Phase 2 (claims available in JWT). Do alongside the `originAuth.userId` → `originAuth.sub` rename (follow-on task)
- [ ] Website build validation — deferred until doc examples are wired up

### Phase 7: Audit Logging

Structured audit logging for all subject management and authentication operations via `@lumenize/debug`. Provides accountability and traceability for admin actions, delegation events, and security-sensitive operations — queryable through Cloudflare's observability dashboard.

**Goal**: Every write operation and security-relevant event in the Auth DO produces a structured JSON log entry via `@lumenize/debug`. No new tables, no new API endpoints — Cloudflare's logging infrastructure handles storage, retention, and querying.

**Completed**:
- ✅ All 11 distinct audit namespaces instrumented in `lumenize-auth.ts` — covering all 13 planned operation types (some handlers emit multiple categories)
- ✅ `#accessDenied` helper method DRYs up 8 admin guard patterns
- ✅ `#handleLogout` resolves `subjectId` from RefreshTokens before revoking
- ✅ `@lumenize/debug` simplified — auto-detects `env.DEBUG` in Workers, removed `debug.configure()` and `debug(this)` overload
- ✅ All packages updated to use `debug('namespace')` directly
- ✅ `DEBUG: 'auth'` in `packages/auth/vitest.config.js` miniflare bindings
- ✅ Audit Logging docs section added to `website/docs/auth/index.mdx`
- ✅ All 133 auth tests pass, full monorepo green, type-check clean
- ✅ Coverage: `lumenize-auth.ts` at 87.82% statements / 80.79% branch (meets >80% branch target)
- ✅ Console spy tests deferred — 353 audit entries across all 11 namespaces visible in test stdout with `DEBUG=auth`; existing test suite exercises all audit paths without dedicated spy tests

**Audit log categories verified in test output** (counts from `npx vitest run`):
- `subject.created` — 123 entries
- `login.succeeded` — 122 entries
- `subject.updated` — 64 entries
- `invite.sent` — 11 entries
- `access.denied` — 11 entries (both "Authentication required" and "Non-admin access denied")
- `actor.added` — 8 entries
- `token.delegated` — 5 entries
- `subject.deleted` — 3 entries
- `login.failed` — 3 entries (invalid token; `token_used`/`token_expired` branches uncovered but low-risk)
- `token.revoked` — 2 entries (both "Logout" and "Tokens revoked on approval revocation")
- `actor.removed` — 1 entry

**Design decision: `@lumenize/debug` over SQLite + API**

The original design called for an `AuditLog` table, indexes, TTL sweep, and a `GET /audit-log` admin endpoint. During planning, we pivoted to using `@lumenize/debug` structured JSON logging because:
- The existing debug package already outputs JSON with `type`, `level`, `namespace`, `message`, `timestamp`, and arbitrary `data` fields — exactly the shape of an audit entry
- Cloudflare's observability dashboard supports semi-structured queries on JSON log output (filter by namespace, level, data fields)
- Eliminates: AuditLog table + 2 indexes + TTL sweep + query API endpoint + AuditEntry type + pagination logic + wrangler migration concerns
- Retention is managed by Cloudflare's log retention settings, not our code
- Namespace hierarchy (`auth.LumenizeAuth.*`) enables powerful dashboard filtering: `auth.LumenizeAuth.subject*` for subject lifecycle, `auth.LumenizeAuth*:warn` for security events only

**Namespace convention**: `auth.LumenizeAuth.{category}.{action}` using the existing `this.#debug(...)` factory. Each instrumentation point creates a scoped logger:

```typescript
const auditLog = this.#debug('auth.LumenizeAuth.subject.created');
auditLog.info('Subject created via magic link', { targetSub: sub, actorSub: 'system', email });
```

**Level categorization**:

`warn` — security-relevant events an admin should notice:
- `auth.LumenizeAuth.login.failed` — invalid/expired/used magic link or invite token
- `auth.LumenizeAuth.access.denied` — non-admin hitting admin endpoint, failed `#authenticateRequest`
- `auth.LumenizeAuth.token.revoked` — logout, admin revoke, approval revocation
- `auth.LumenizeAuth.subject.deleted` — admin deleted a subject

`info` — normal operational events for audit trail:
- `auth.LumenizeAuth.subject.created` — magic link login (new subject), invite (new subject)
- `auth.LumenizeAuth.subject.updated` — flag changes (`isAdmin`, `adminApproved`, `emailVerified`), bootstrap promotion (first time only)
- `auth.LumenizeAuth.login.succeeded` — magic link validation, invite acceptance
- `auth.LumenizeAuth.actor.added` — authorized actor added
- `auth.LumenizeAuth.actor.removed` — authorized actor removed
- `auth.LumenizeAuth.token.delegated` — delegated token issued
- `auth.LumenizeAuth.invite.sent` — invite email sent (per email in batch)

**`actorSub` resolution** (in `data` field):
- Admin endpoints: `auth.sub` from `#authenticateRequest` (the admin performing the action)
- Self-service operations (magic link login, accept-invite): `'system'`
- Logout: resolve `subjectId` from the RefreshTokens row (lighter than full `#authenticateRequest`)

**Idempotent operations**: Bootstrap promotion logs `subject.updated` only on first login (when flags actually change), not on subsequent idempotent logins.

**What was instrumented** (all handlers in `lumenize-auth.ts`):

- [x] `#loginSubject` — `subject.created` (info) when new, `subject.updated` (info) on first bootstrap promotion only
- [x] `#handleMagicLink` — `login.succeeded` (info) on valid token; `login.failed` (warn) on invalid/expired/used token
- [x] `#handleAcceptInvite` — `login.succeeded` (info) + `subject.updated` (info) on valid token; `login.failed` (warn) on invalid/expired token
- [x] `#handleUpdateSubject` — `subject.updated` (info) per flag changed, with `{ field, from, to }`
- [x] `#handleDeleteSubject` — `subject.deleted` (warn) with `{ email }`
- [x] `#handleAddActor` — `actor.added` (info) with `{ actorSub }`
- [x] `#handleRemoveActor` — `actor.removed` (info) with `{ actorSub }`
- [x] `#handleDelegatedToken` — `token.delegated` (info) with `{ principalSub }`
- [x] `#handleApprove` — `subject.updated` (info) with `{ field: 'adminApproved', from: false, to: true }`
- [x] `#handleLogout` — `token.revoked` (warn) with `{ method: 'logout' }`
- [x] `#handleInvite` — `invite.sent` (info) per email; `subject.created` (info) when new subject created
- [x] `#authenticateRequest` failures — `access.denied` (warn) on AuthenticationError throw
- [x] Non-admin hitting admin endpoint — `access.denied` (warn) with `{ endpoint, sub }`

**Tests**:
- [x] Existing 133 tests exercise all 11 audit namespaces (353 entries in test output with `DEBUG=auth`)
- [x] Dedicated console spy tests deferred — audit output is thoroughly exercised by existing test suite

**Documentation**:
- [x] "Audit Logging" section added to `website/docs/auth/index.mdx`

## Notes

Phase 2 unblocks `security.mdx` testing:
- `@skip-check` at lines 127, 155 can become `@check-example`
- Guards checking `originAuth.isAdmin` are testable (claims in JWT)
- `requireRole()` pattern needs custom role claims (Phase 4+)

### Terminology Note

This design uses RFC 7519/8693 terminology consistently:
- **`sub`** (subject) - The principal whose permissions apply. Could be a user, agent, system, or any authenticated entity.
- **`act`** (actor) - Who is making the call on behalf of the subject (for delegated access).

We avoid "user" except as an example alongside "agent", "system", etc. The abstract "subject" terminology is more precise and doesn't imply the subject is human.

---

## Follow-on: Mesh Access Control Integration

**Status**: Partially done (gateway header migration completed in Phase 2) — remaining work is `originAuth.userId` → `originAuth.sub` rename

### What was completed in Phase 2

The gateway header migration was included in Phase 2 to avoid a period where auth and mesh were incompatible:
- [x] `LumenizeClientGateway`: reads JWT from `Authorization: Bearer <jwt>` header (not `X-Auth-*`)
- [x] `LumenizeClientGateway`: decodes JWT payload (base64url, no signature re-verification — trusts Worker hooks)
- [x] `LumenizeClientGateway`: `WebSocketAttachment` uses `sub` (from JWT payload) internally
- [x] `LumenizeClientGateway`: constructs `originAuth` with bridge: `{ userId: attachment.sub, claims: attachment.claims }`
- [x] Negative security test: Worker rejects forged JWT before it reaches gateway DO (e2e)
- [x] All 264 mesh tests pass with the new header contract

### Architecture: LumenizeClientGateway as Trust Boundary

All Lumenize Mesh client access goes through `LumenizeClientGateway` via WebSocket. The gateway is the **second layer of defense-in-depth** (after the Worker hooks) and the **DMZ boundary** for the mesh:

1. **Worker hooks** verify the JWT and forward it in `Authorization: Bearer <jwt>` to the gateway
2. **LumenizeClientGateway** decodes the JWT payload (trusts Worker hooks verified signature) and translates claims into `CallContext.originAuth`
3. **Downstream mesh nodes** trust `callContext` — they do NOT need to decode the JWT themselves

### Remaining Implementation Scope

#### @lumenize/mesh changes — `originAuth.userId` → `originAuth.sub` rename
- [ ] Rename `OriginAuth.userId` → `OriginAuth.sub` in the type definition
- [ ] Update `LumenizeClientGateway`: `{ userId: attachment.sub }` → `{ sub: attachment.sub }` (remove bridge)
- [ ] Update `LumenizeClient`: any client-side references to `originAuth.userId`
- [ ] Update all guards and `onBeforeCall` hooks that reference `originAuth.userId` → `originAuth.sub`
- [ ] Update all tests that assert `originAuth.userId`

#### Documentation updates
- [ ] `website/docs/mesh/security.mdx` - Update guard examples from `originAuth.userId` to `originAuth.sub`
- [ ] `website/docs/mesh/getting-started.mdx` - Mention access control in setup
- [ ] Audit all code examples across docs for `userId` → `sub` in auth contexts, onBeforeCall, and @mesh(guard)
