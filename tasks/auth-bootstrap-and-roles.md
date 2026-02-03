# Lumenize Auth Upgrade (Bootstrap, Admin, Flow)

**Status**: Design Complete
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

Changes needed from current state:

### Types (`types.ts`)
- [ ] Add `ActClaim` interface (recursive: `{ sub: string; act?: ActClaim }`)
- [ ] Update `JwtPayload` to include `act?: ActClaim` per RFC 8693
- [ ] Add `emailVerified`, `adminApproved` status flags to claims
- [ ] Add `isAdmin` role flag to claims
- [ ] Update `Subject` interface with flags and authorizedActors

### LumenizeAuth DO
- [ ] Remove `configure()` RPC method, `#config` instance variable, and `DEFAULT_CONFIG` constant
- [ ] Read all config from `this.env` with inline defaults: `this.env.LUMENIZE_AUTH_ISSUER || 'https://lumenize.local'`, etc.
- [ ] Validate `this.env.LUMENIZE_AUTH_REDIRECT` at top of `fetch` handler — return `500 { error: 'server_error', error_description: 'LUMENIZE_AUTH_REDIRECT not set' }` if missing (required, no default)
- [ ] Add `emailVerified`, `adminApproved` status flags to subject record
- [ ] Add `isAdmin` role flag to subject record
- [ ] Add `authorizedActors` to subject record (list of subject IDs — must correspond to existing subjects — pre-authorized to request delegated tokens for this subject)
- [ ] Bootstrap check: if email matches `LUMENIZE_AUTH_BOOTSTRAP_EMAIL`, set `isAdmin: true`, `adminApproved: true`, and `emailVerified: true` on first login (all three flags in one step — the bootstrap admin gets immediate access without waiting for the magic link handler to set `emailVerified` separately)
- [ ] Set `emailVerified: true` when subject clicks magic link
- [ ] **Admin notification**: after magic link validation, if subject has `emailVerified: true` but `adminApproved: false`, email all admins with a link to `{prefix}/approve/:id` (the DO sends the email — it has the email service and the subject list)
- [ ] Embed subject flags in JWT claims at token creation
- [ ] Support `act` claim for delegation (authenticated subject acting for principal)
- [ ] Verify `act.sub` corresponds to an existing subject when issuing delegated tokens
- [ ] Admins bypass `authorizedActors` check — can delegate as any subject
- [ ] Non-admin actors must be in principal's `authorizedActors` list
- [ ] Add `POST {prefix}/delegated-token` route: actor provides own access token + `actFor` (target subject ID), returns delegated token with `sub` = target, `act.sub` = actor
- [ ] Add `#private` subject management handlers (list, get, update, delete) — called by the `fetch` handler, not exposed as public RPC
- [ ] Add `#private` flag management handlers (approve subject, promote to admin, demote)
- [ ] Add `#private` actor authorization handlers (authorizeActor, revokeActor) — validates that actor IDs are existing subject IDs
- [ ] **Dual auth**: all authenticated LumenizeAuth endpoints accept Bearer token or refresh token cookie (Design Decision #12)
- [ ] **Lazy token cleanup**: on any rejected token (expired or revoked), delete it and sweep all expired tokens: `DELETE FROM refresh_tokens WHERE expires_at < ?`
- [ ] **Revoke-all on status change**: when `adminApproved` is set to `false` or a subject is deleted, revoke all their refresh tokens: `UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?`
- [ ] **Logging**: Use `@lumenize/debug` for all logging (audit trail, errors, diagnostics). Namespace: `auth.*` (e.g., `auth.subject-management`, `auth.delegation`, `auth.token`)
- [ ] Remove `#rateLimits` instance variable and `#checkRateLimit()` method (rate limiting moves to Worker level)
- [ ] Remove `rateLimitPerHour` from `AuthConfig` (replaced by Worker-level rate limiting binding)

### createAuthRoutes
- [ ] Remove `redirect`, `issuer`, `audience`, `accessTokenTtl`, `refreshTokenTtl`, `magicLinkTtl`, `prefix` from options — these are now env vars
- [ ] Remove the 503 lazy-init retry and `configure()` RPC call
- [ ] Read `prefix` from `env.LUMENIZE_AUTH_PREFIX || '/auth'` for route matching
- [ ] Rename `instanceName` to `authInstanceName` for clarity
- [ ] New signature: `createAuthRoutes(env, options?)` where options is `{ cors?, authBindingName?, authInstanceName? }`
- [ ] Add subject management routes
- [ ] Add admin-only guards to new routes
- [ ] Route `{prefix}/magic-link` to DO — admin notification is handled by the DO (see LumenizeAuth DO section)
- [ ] Add bulk invite route: `POST {prefix}/invite` accepts array of emails, sets `adminApproved`, sends invite emails. With `?_test=true`, returns invite links in response instead of sending emails (same pattern as magic link test mode)
- [ ] Add invite acceptance route: clicking invite link sets `emailVerified`
- [ ] Validate `cf-turnstile-response` token from request body via Cloudflare siteverify API before forwarding magic-link requests to DO. Return 403 on failure.
- [ ] Fail fast: throw at creation time if `env.TURNSTILE_SECRET_KEY` is not set

### createRouteDORequestAuthHooks
- [ ] Rename from `createAuthMiddleware`/`createWebSocketAuthMiddleware` to single `createRouteDORequestAuthHooks`
- [ ] Change signature to `createRouteDORequestAuthHooks(env, options?)` — options object is entirely optional
- [ ] Remove `issuer`/`audience` options — read from `env.LUMENIZE_AUTH_ISSUER` / `env.LUMENIZE_AUTH_AUDIENCE` (same source of truth as the DO)
- [ ] Return `{ onBeforeRequest, onBeforeConnect }` for destructuring
- [ ] Check `emailVerified && adminApproved` (admins pass implicitly)
- [ ] Public keys: read from `[env.JWT_PUBLIC_KEY_BLUE, env.JWT_PUBLIC_KEY_GREEN].filter(Boolean)` — same convention the DO uses for signing. No override option (the names are a shared convention). Throw at creation time if no keys available.
- [ ] Replace `X-Auth-User-Id`, `X-Auth-Verified`, `X-Auth-Token-Exp`, `X-Auth-Claims` headers — forward the original verified JWT in the standard `Authorization: Bearer <jwt>` header instead
- [ ] For WebSocket upgrades: extract token from subprotocol list, verify, set `Authorization: Bearer <jwt>` on the upgrade request before forwarding to DO
- [ ] Rate limiting: default to `env.LUMENIZE_AUTH_RATE_LIMITER`, allow override via `rateLimiterBinding` option. Use `sub` from decoded JWT as key and call `binding.limit({ key: sub })`. Return 429 on failure. Throw at creation time if no binding available.

### testLoginWithMagicLink
Signature: `testLoginWithMagicLink(browser: Browser, email: string, options?): Promise<{ accessToken: string, claims: JwtClaims, sub: string }>`. The `browser` parameter (cookie jar) is required — the login flow spans 3 HTTP calls that share cookies. Return type expands from bare `string` (userId) to `{ accessToken, claims, sub }`.
- [x] Accept optional `prefix` to match configured auth prefix
- [ ] Expand return type from `string` to `{ accessToken, claims, sub }`
- [ ] Accept optional `subjectData` for setting roles during test
- [ ] Accept optional `actorSub` to simulate delegated access
- [ ] Works with real auth flow (data goes in storage, flows to JWT)

### LUMENIZE_AUTH_TEST_MODE safety
- [x] Move `LUMENIZE_AUTH_TEST_MODE` from `packages/auth/wrangler.jsonc` vars to `vitest.config.js` `miniflare.bindings` (never accidentally deployable)
- [ ] Remove `LUMENIZE_AUTH_TEST_MODE` from all `wrangler.jsonc` files under `packages/mesh/test/` — move to each test's `vitest.config.js` `miniflare.bindings`
- [ ] Remove `LUMENIZE_AUTH_TEST_MODE` from `website/docs/mesh/testing.mdx` `.dev.vars` example — update to show `vitest.config.js` pattern

### Documentation
- [x] Draft `website/docs/auth/index.mdx` (overview, access flows, bootstrap)
- [x] Reviewed and approved by maintainer `website/docs/auth/index.mdx`
- [x] Draft `website/docs/auth/api-reference.mdx` (roles, subject management)
- [x] Reviewed and approved by maintainer `website/docs/auth/api-reference.mdx` 
- [x] Update `website/sidebars.ts` to include new pages
- [ ] Update `security.mdx` examples once claims work

## Prerequisites
- [x] Design/APIs drafted in MDX (reads as final docs)
- [x] Design/APIs reviewed and approved by maintainer

## Implementation Phases

TBD after design is approved.

## Notes

This unblocks `security.mdx` testing:
- `@skip-check` at lines 127, 155 can become `@check-example`
- Guards checking `originAuth.isAdmin` will be testable
- `requireRole()` pattern will be testable

### Terminology Note

This design uses RFC 7519/8693 terminology consistently:
- **`sub`** (subject) - The principal whose permissions apply. Could be a user, agent, system, or any authenticated entity.
- **`act`** (actor) - Who is making the call on behalf of the subject (for delegated access).

We avoid "user" except as an example alongside "agent", "system", etc. The abstract "subject" terminology is more precise and doesn't imply the subject is human.

---

## Follow-on: Mesh Access Control Integration

**Status**: Not Started (blocked by this task)

### Problem

Once this task ships, `createRouteDORequestAuthHooks` will verify JWTs and enforce `emailVerified && adminApproved` at the Worker level, forwarding the verified JWT in the standard `Authorization: Bearer <jwt>` header. Lumenize Mesh currently reads identity from the old `X-Auth-*` headers and constructs `OriginAuth` with `userId` instead of `sub`. The mesh needs to be updated to consume the new JWT-based identity.

### Architecture: LumenizeClientGateway as Trust Boundary

All Lumenize Mesh client access goes through `LumenizeClientGateway` via WebSocket. The gateway is the **second layer of defense-in-depth** (after the Worker hooks) and the **DMZ boundary** for the mesh:

1. **Worker hooks** verify the JWT and forward it in `Authorization: Bearer <jwt>` to the gateway
2. **LumenizeClientGateway** re-verifies/decodes the JWT (cheap — sub-millisecond Ed25519 via `crypto.subtle`) and translates claims into `CallContext.originAuth`
3. **Downstream mesh nodes** trust `callContext` — they do NOT need to decode the JWT themselves

This means `originAuth` is the internal identity format within the mesh. The JWT is the external format at the Worker→DO boundary.

### Implementation Scope

#### @lumenize/mesh changes
- [ ] `LumenizeClientGateway`: read JWT from `Authorization: Bearer <jwt>` header instead of `X-Auth-User-Id` + `X-Auth-Claims` + `X-Auth-Token-Exp`
- [ ] `LumenizeClientGateway`: verify/decode JWT and construct `OriginAuth` from claims — replace `{ userId, claims }` with `{ sub, isAdmin, act, ... }`
- [ ] `LumenizeClientGateway`: update WebSocket attachment to use new `OriginAuth` shape
- [ ] `LumenizeClient`: update any client-side references from `userId` to `sub` in `OriginAuth`
- [ ] Update `CallContext.originAuth` type across the mesh
- [ ] Update all guards and `onBeforeCall` hooks that reference `originAuth.userId` → `originAuth.sub`

#### Documentation updates
- [ ] `website/docs/mesh/security.mdx` - Major updates for access control, update guard examples from `originAuth.userId` to `originAuth.sub`
- [ ] `website/docs/mesh/getting-started.mdx` - Mention access control in setup
- [ ] Audit all code examples across docs for `userId` → `sub` in auth contexts, onBeforeCall, and @mesh(guard)
