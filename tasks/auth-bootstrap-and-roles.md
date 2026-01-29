# Auth Bootstrap and Roles

**Status**: Design Drafted - Awaiting Review
**Design Documents**:
- `/website/docs/auth/index.mdx` - Overview, access flows, bootstrap
- `/website/docs/auth/subjects-and-roles.mdx` - Role system, subject management APIs

## Goal
Make `@lumenize/auth` a complete, bootstrappable auth system with built-in admin roles so developers can start with a working permission model out of the box.

## Context: Mesh Access Control

This task focuses on `@lumenize/auth` in isolation. However, the design decisions here anticipate follow-on work to integrate mesh-level access control into `@lumenize/mesh`. Currently, anyone with a valid email can authenticate and gain access to the Cloudflare-hosted mesh. Authentication dangerously grants access. The follow-on task will have `createRouteDORequestAuthHooks` check `emailVerified && adminApproved` before routing to `LumenizeClientGateway`. See [Follow-on: Mesh Access Control](#follow-on-mesh-access-control) at the end of this document.

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
      - Can promote other subjects to admin
- Lumenize Auth onBeforeConnect/onBeforeRequest hook functions
  - Grants access only to subjects with `emailVerified && adminApproved` (or `isAdmin`)
- Underlying System (Lumenize Mesh for example):
  - Fine-grained access control keying off of `sub` (subject ID)

### Proposed New/Changed Flows

See [Design Decision #2](#2-two-phase-access-subject-confirmation--admin-approval) for the access control model and truth table.

**Self-signup (changed)**: Lumenize Auth currently provides routes for the magic-link self-signup flow. That will now change to only granting `emailVerified`. That should kick off a new email flow to admins that asks them to approve the subject's access by clicking on a link that's carefully worded to warn them to only approve if they know the owner of the email address should have access. Clicking on that grants the subject `adminApproved`.

**Admin-invite (new)**: We will also need additional route(s) for the two flags being set in the reverse order. Admins add a list of email addresses (not just one) and that sets `adminApproved`. The system sends those emails and when the subject clicks the link in that email, it sets `emailVerified`.

## Design Decisions

### 1. Bootstrap via Environment Variable
`LUMENIZE_AUTH_BOOTSTRAP_EMAIL=larry@example.com`
- First login with this email automatically gets `{ isAdmin: true }`
- No database seeding required
- Bootstrap admin can promote others

### 2. Two-Phase Access: Subject Confirmation + Admin Approval

Access requires two independent approvals that can happen in either order:

- `emailVerified` - Subject has clicked an email link (subject confirmation)
- `adminApproved` - Admin has granted access (admin approval)

**Access check:** `emailVerified && adminApproved`

| Scenario | emailVerified | adminApproved | Can Access? |
|----------|---------------|---------------|-------------|
| Admin invites subject, subject hasn't clicked | No | Yes | No |
| Subject self-signs-up, admin hasn't approved | Yes | No | No |
| Admin invited, subject clicked | Yes | Yes | **Yes** |
| Subject self-signed-up, admin approved | Yes | Yes | **Yes** |

**Naming rationale:**
- `emailVerified` / `adminApproved` = past-tense events (things that happened)
- `isAdmin` = identity statement (what the subject *is*)
- Matches industry norms (Firebase, Auth0 use `emailVerified`)

**Rejected alternatives:**
- Status enum (`invited`, `active`, `disabled`) - harder to represent "approved but not verified" vs "verified but not approved"
- Single `isActive` boolean - conflates user action with admin action

### 3. Single Built-in Role Flag
Hardcode into LumenizeAuth:
- `isAdmin` - can manage subjects, promote to admin, delete subjects

Admins implicitly satisfy `adminApproved`. This is a universal pattern. For application-specific roles, use the `metadata` field.

**Bootstrap protection** is orthogonal to the role — the subject matching `LUMENIZE_AUTH_BOOTSTRAP_EMAIL` cannot be demoted or deleted via API, regardless of who tries. This is identity-based, not role-based.

### 4. Subject Data in Auth DO
LumenizeAuth already stores subjects. Extend to store:
- `emailVerified`, `adminApproved` status flags
- `isAdmin` role flag
- `metadata` field for application-specific data (custom roles, preferences, etc.)
- All flows through to JWT claims automatically

### 5. Subject Management APIs
New routes (admin-only), using configurable `prefix` (default: `/auth`):
- `GET {prefix}/subjects` - list subjects
- `GET {prefix}/subject/:id` - get subject
- `PATCH {prefix}/subject/:id` - update subject (roles, metadata)
- `DELETE {prefix}/subject/:id` - delete subject

Also available as RPC methods on the Auth DO (`listSubjects`, `getSubjectById`, `updateSubject`, `deleteSubject`).

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
- **Delegated**: Something acts on subject's behalf → `sub` (principal) + `act.sub` (actor)

The `act` claim records delegation for audit purposes. The system doesn't need to know *what* the actor is (AI agent, service account, another human) - just that delegation occurred and who the actor was.

In Lumenize Mesh, guards and `onBeforeCall` hooks use these claims directly:

```typescript
// In @mesh guard - checks principal's permissions
@mesh({ guard: (auth) => auth.sub === ownerId })

// In onBeforeCall - audit logging
onBeforeCall: (auth) => {
  if (auth.act) {
    console.log(`${auth.act.sub} acting for ${auth.sub}`);
  }
}
```

**Rejected alternatives:**
- Custom naming (`userId`, `subjectId`) - requires translation layer between JWT and app code; anyone familiar with RFCs has to re-learn

### 7. Layered Rate Limiting

Rate limiting is handled at the Worker level using Cloudflare's [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), not in the singleton LumenizeAuth DO. This keeps the DO focused on business logic and leverages Worker horizontal scaling.

**Three layers** (outer to inner):

1. **Cloudflare DDoS/bot protection** (automatic, free) — fingerprint-reputation filtering handles volumetric attacks. No configuration needed.

2. **Turnstile** (optional, recommended) — bot protection on the magic-link endpoint. If `TURNSTILE_SECRET_KEY` is set in environment, `createAuthRoutes` validates the `cf-turnstile-response` token from the request body before forwarding to the DO. No key needed — Turnstile proves the requester is human.

3. **Worker-level rate limiting binding** — two uses:
   - **Unauthenticated** (magic-link requests): `createAuthRoutes` parses the email from the request body and uses it as the rate limit key before forwarding to the DO
   - **Authenticated** (protected routes): `createRouteDORequestAuthHooks` uses `sub` from the decoded JWT as the rate limit key

The rate limiting binding is configured in `wrangler.jsonc`:

```jsonc
{
  "rate_limits": [
    { "binding": "AUTH_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } },
    { "binding": "HOOKS_RATE_LIMITER", "namespace_id": "1002", "simple": { "limit": 100, "period": 60 } }
  ]
}
```

**Fail-fast requirements:**
- `createAuthRoutes` throws at creation time if *neither* `TURNSTILE_SECRET_KEY` (env) nor `rateLimiterBinding` is provided — the unauthenticated magic-link endpoint must have at least one layer of protection against email flooding
- `createRouteDORequestAuthHooks` requires `rateLimiterBinding` — throws at creation time if missing

**Why not in the DO?** The previous implementation used an instance variable (`Map`) in LumenizeAuth. This was acceptable (DOs stay warm under load, so the rate limit wouldn't reset during active attacks), but Worker-level rate limiting is strictly better: it scales horizontally, stops abuse before it reaches the singleton DO, and uses Cloudflare's distributed rate limiting infrastructure.

**Rejected alternatives:**
- IP-based rate limiting — Cloudflare's own docs warn against it (shared IPs on mobile/proxy networks). DDoS protection already handles IP-level abuse.
- DO-level rate limiting — unnecessarily burdens the singleton with work the Worker layer handles better
- `rateLimitPerHour` config on AuthConfig — replaced by the rate limiting binding's `limit`/`period` configuration

### 8. Single Auth Header with Decoded JWT Payload

Currently the middleware passes identity via multiple headers:
- `X-Auth-User-Id` — JWT `sub` (redundant, already in JWT payload)
- `X-Auth-Verified` — literal `'true'` (redundant, header presence implies verification)
- `X-Auth-Token-Exp` — JWT `exp` (redundant, already in JWT payload)
- `X-Auth-Claims` — JSON-encoded additional claims

The gateway then reconstructs `OriginAuth` from these separate pieces.

**New approach**: Replace all four headers with a single `X-Auth` header containing the JSON-encoded decoded JWT payload. If the header is present, the middleware verified it — no separate verification flag needed. `sub`, `exp`, `isAdmin`, `act`, etc. all come along for free.

```
X-Auth: {"sub":"abc-456","isAdmin":true,"emailVerified":true,"adminApproved":true,"exp":1234567890}
```

`OriginAuth` becomes a direct projection of the JWT claims:

```typescript
interface OriginAuth {
  sub: string;
  isAdmin?: boolean;
  emailVerified: boolean;
  adminApproved: boolean;
  act?: ActClaim;
  exp?: number;
}
```

**Rejected alternatives:**
- Keep separate headers — redundant data split across multiple headers that must be recombined; `userId` was a custom name for what the JWT already calls `sub`

## Implementation Deltas

Changes needed from current state:

### Types (`types.ts`)
- [ ] Add `ActClaim` interface (recursive: `{ sub: string; act?: ActClaim }`)
- [ ] Update `JwtPayload` to include `act?: ActClaim` per RFC 8693
- [ ] Add `emailVerified`, `adminApproved` status flags to claims
- [ ] Add `isAdmin` role flag to claims
- [ ] Update `Subject` interface with flags, authorizedActors, and metadata

### LumenizeAuth DO
- [ ] Add `emailVerified`, `adminApproved` status flags to subject record
- [ ] Add `isAdmin` role flag to subject record
- [ ] Add `authorizedActors` to subject record (list of actor IDs pre-authorized to request delegated tokens for this subject)
- [ ] Bootstrap check: if email matches `LUMENIZE_AUTH_BOOTSTRAP_EMAIL`, set `isAdmin: true` and `adminApproved: true` on first login
- [ ] Set `emailVerified: true` when subject clicks magic link
- [ ] Embed subject flags in JWT claims at token creation
- [ ] Support `act` claim for delegation (actor acting for principal)
- [ ] Add subject management methods (list, get, update, delete)
- [ ] Add flag management (approve subject, promote to admin, demote)
- [ ] Add actor authorization methods (authorizeActor, revokeActor)
- [x] **Bug fix**: Use `config.prefix` when generating URLs (was hardcoded as `/auth`)
- [ ] Remove `#rateLimits` instance variable and `#checkRateLimit()` method (rate limiting moves to Worker level)
- [ ] Remove `rateLimitPerHour` from `AuthConfig` (replaced by Worker-level rate limiting binding)

### createAuthRoutes
- [ ] Add subject management routes
- [ ] Add admin-only guards to new routes
- [ ] Add admin notification as side effect of `{prefix}/magic-link`: when a subject self-signs-up and has `emailVerified: true` but `adminApproved: false`, email admins with a link to `{prefix}/approve/:id`
- [ ] Add bulk invite route: `POST {prefix}/invite` accepts array of emails, sets `adminApproved`, sends invite emails. With `?_test=true`, returns invite links in response instead of sending emails (same pattern as magic link test mode)
- [ ] Add invite acceptance route: clicking invite link sets `emailVerified`
- [ ] Accept optional `rateLimiterBinding` — if provided, parse email from request body and call `binding.limit({ key: email })` before forwarding magic-link requests to DO. Return 429 on failure.
- [ ] If `env.TURNSTILE_SECRET_KEY` is present, validate `cf-turnstile-response` token from request body via Cloudflare siteverify API before forwarding magic-link requests to DO. Return 403 on failure.
- [ ] Fail fast: throw at creation time if neither `env.TURNSTILE_SECRET_KEY` nor `rateLimiterBinding` is provided

### createRouteDORequestAuthHooks
- [ ] Rename from `createAuthMiddleware`/`createWebSocketAuthMiddleware` to single `createRouteDORequestAuthHooks`
- [ ] Return `{ onBeforeRequest, onBeforeConnect }` for destructuring
- [ ] Check `emailVerified && adminApproved` (admins pass implicitly)
- [ ] Replace `X-Auth-User-Id`, `X-Auth-Verified`, `X-Auth-Token-Exp`, `X-Auth-Claims` with single `X-Auth` header (JSON-encoded decoded JWT payload)
- [ ] Update `OriginAuth` type: replace `{ userId, claims? }` with JWT claims shape (`{ sub, isAdmin?, act?, ... }`)
- [ ] Require `rateLimiterBinding` — use `sub` from decoded JWT as key and call `binding.limit({ key: sub })`. Return 429 on failure. Throw at creation time if missing.

### testLoginWithMagicLink
- [x] Accept optional `prefix` to match configured auth prefix
- [ ] Accept optional `subjectData` for setting roles/metadata during test
- [ ] Accept optional `actAs` to simulate delegated access
- [ ] Works with real auth flow (data goes in storage, flows to JWT)

### Documentation
- [x] Draft `website/docs/auth/index.mdx` (overview, access flows, bootstrap)
- [ ] Reviewed and approved by maintainer `website/docs/auth/index.mdx` 
- [x] Draft `website/docs/auth/subjects-and-roles.mdx` (roles, subject management)
- [ ] Reviewed and approved by maintainer `website/docs/auth/subjects-and-roles.mdx` 
- [x] Update `website/sidebars.ts` to include new pages
- [ ] Update `security.mdx` examples once claims work

## Prerequisites
- [x] Design/APIs drafted in MDX (reads as final docs)
- [ ] Design/APIs reviewed and approved by maintainer

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

Currently, Lumenize Mesh has a security gap: anyone who can authenticate (has a valid email) automatically gains access to the mesh. Authentication ≠ authorization. The Worker routes all authenticated requests to `LumenizeClientGateway` without checking if the subject is actually allowed to use the mesh.

### Solution

With the new `emailVerified` + `adminApproved` model in `@lumenize/auth`, the middleware (to be renamed hooks) can now gate access properly:

1. **Access check**: `emailVerified && adminApproved` (or `isAdmin`)
   - Both subject confirmation AND admin approval required
   - Admins implicitly pass the check

2. **Default hook behavior**: `createRouteDORequestAuthHooks` checks both flags before allowing WebSocket upgrade or HTTP routing to mesh DOs

### Implementation Scope

#### @lumenize/mesh changes
- [ ] `LumenizeClientGateway`: read single `X-Auth` header instead of `X-Auth-User-Id` + `X-Auth-Claims` + `X-Auth-Token-Exp`
- [ ] `LumenizeClientGateway`: update `OriginAuth` construction — replace `{ userId, claims }` with decoded JWT shape (`{ sub, isAdmin, act, ... }`)
- [ ] `LumenizeClientGateway`: update WebSocket attachment to use new `OriginAuth` shape
- [ ] `LumenizeClient`: update any client-side references from `userId` to `sub` in `OriginAuth`
- [ ] Update `CallContext.originAuth` type across the mesh
- [ ] Update all guards and `onBeforeCall` hooks that reference `originAuth.userId` → `originAuth.sub`

#### Documentation updates
- [ ] `website/docs/mesh/security.mdx` - Major updates for access control, update guard examples from `originAuth.userId` to `originAuth.sub`
- [ ] `website/docs/mesh/getting-started.mdx` - Mention access control in setup
- [ ] Audit all code examples across docs for `userId` → `sub` in auth contexts, onBeforeCall, and @mesh(guard)
