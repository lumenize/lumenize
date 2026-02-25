# Nebula Auth

## Overview

`@lumenize/nebula-auth` is a multi-tenant authentication package forked from `@lumenize/auth`. It provides magic link login, JWT access tokens, and admin roles scoped to a three-tier hierarchy: Universe > Galaxy > Star.

The package contains two Durable Object classes:

- **`NebulaAuth` (aka "NA")** — Per-instance auth management (subjects, tokens, JWTs). Each tier maps to a separate instance identified by a `universeGalaxyStarId` in the URL.
- **`NebulaAuthRegistry` ("R", "registry")** — Singleton central registry tracking all instances and email-to-scope mappings. Enables slug availability checks, self-signup flows, and email-based discovery.

Nebula is a BSL 1.1 licensed vibe coding platform built on Lumenize Mesh. Auth is the first piece.

## Business Context

### Dual Multi-Tenancy

- **Universe** — A development organization that is a customer of Lumenize Nebula (company, intrapreneur, solopreneur). Example slug: `george-solopreneur`
- **Galaxy** — An application created by a Universe. Galaxies are themselves multi-tenant. Example slug: `george-solopreneur.georges-first-app`
- **Star** — An organization that is a tenant of a Galaxy. Example slug: `george-solopreneur.georges-first-app.acme-corp`

### Revenue Model (Out of Scope but Informing Design)

Monthly usage reports per `galaxy.star` are sent to Universe billing admins. Universe owners provide code (DWL or webhook) to convert usage into per-Star billing. Lumenize retains ~20% after Cloudflare costs. Free tiers may exist at Universe, Galaxy, and/or Star levels.

### Coach Scenario (Key Business Requirement)

Coaches/consultants work with multiple Lumenize clients simultaneously. A coach may have a different email address per client (issued by the client for access control). Revoking the email revokes access after the current access token expires.

Coaches must be able to switch between clients via tab switching without re-login. This is solved by cookie `Path` scoping (see Multi-Session Architecture below).

---

## Architecture Decisions

### Two DO Classes

| DO Class | Instances | Purpose |
|----------|-----------|---------|
| `NebulaAuth` | One per `universeGalaxyStarId` (+ `nebula-platform`) | Token management, magic link flow, JWT issuance, subject CRUD |
| `NebulaAuthRegistry` | Singleton | Instance catalog, email→scope index, slug availability, discovery, self-signup routing |

`NebulaAuth` instances are the source of truth for their own subjects and tokens. The registry is a secondary index maintained via direct DO-to-DO RPC calls from `NebulaAuth` instances. For subject mutation operations (create, delete, role change), the `NebulaAuth` instance calls the registry *first* — if the registry call fails, the request fails without modifying local state, so there is nothing to roll back. Read-path operations (token refresh, JWT validation) do not involve the registry. The Worker's role is limited to routing and gatekeeping (auth, rate limiting, Turnstile).

### NebulaAuth: Single DO Class, Three Tiers

One `NebulaAuth` class serves all three tiers. The tier is determined by the segment count of the DO instance name:

| Segments | Tier | Example Instance Name | Purpose |
|----------|------|----------------------|---------|
| 1 | Universe | `george-solopreneur` | Universe admin management |
| 2 | Galaxy | `george-solopreneur.georges-first-app` | Galaxy admin management |
| 3 | Star | `george-solopreneur.georges-first-app.acme-corp` | User management + auth |

### URL Format

All auth routes share a single public prefix (`{prefix}`, default `/auth`). The `createNebulaAuthRoutes` helper routes internally:

```
https://lumenize.com/{prefix}/{universeGalaxyStarId}/[endpoint]   → NebulaAuth instance
https://lumenize.com/{prefix}/discover                            → NebulaAuthRegistry
https://lumenize.com/{prefix}/claim-universe                      → NebulaAuthRegistry
https://lumenize.com/{prefix}/claim-star                          → NebulaAuthRegistry
https://lumenize.com/{prefix}/create-galaxy                       → NebulaAuthRegistry
```

The router first confirms that prefix matches, then uses `.endsWith()` on the pathname (consistent with `lumenize-auth.ts` routing): paths ending with `/discover`, `/claim-universe`, `/claim-star`, or `/create-galaxy` go to the registry singleton; everything else is treated as a `universeGalaxyStarId` and routes to the corresponding `NebulaAuth` instance.

- `{prefix}` — Single public URL prefix (default: `/auth`), maps to `NEBULA_AUTH` and `NEBULA_AUTH_REGISTRY` bindings internally
- `universeGalaxyStarId` — 1-3 dot-separated slugs; determines the DO instance

---

## Endpoint Reference

### DO Involvement Key

- **NA** = `NebulaAuth` instance only (no registry call)
- **NA→R** = `NebulaAuth` calls registry via RPC first, then writes locally (registry-first mutation pattern)
- **NA (or NA→R)** = Conditional — registry call only when state change requires it (e.g., first email verification)
- **R** = `NebulaAuthRegistry` only
- **R→NA** = Registry validates/records, then calls `NebulaAuth` via internal RPC to complete the flow (e.g., send magic link email)

### Auth Flow Endpoints (except /discover in [Registry Endpoints below](#registry-endpoints))

| Endpoint | Method | Auth | DOs | Description |
|----------|--------|------|-----|-------------|
| `{prefix}/{id}/email-magic-link` | POST | Turnstile | NA | Request magic link email |
| `{prefix}/{id}/magic-link?one_time_token=...` | GET | — | NA (or NA→R) | Validate magic link → issue refresh token; registry RPC only on first verification |
| `{prefix}/{id}/accept-invite?invite_token=...` | GET | — | NA | Accept invite → set emailVerified, issue refresh token |
| `{prefix}/{id}/refresh-token` | POST | Cookie | NA | Exchange refresh token for access token (hot path, no registry) |
| `{prefix}/{id}/logout` | POST | Cookie | NA | Revoke refresh token, clear cookie |

### Subject Management Endpoints

| Endpoint | Method | Auth | DOs | Description |
|----------|--------|------|-----|-------------|
| `{prefix}/{id}/subjects` | GET | Admin | NA | List subjects in this instance |
| `{prefix}/{id}/subject/:sub` | GET | Admin | NA | Get subject |
| `{prefix}/{id}/subject/:sub` | PATCH | Admin | NA→R | Update subject flags (registry notified if role changes) |
| `{prefix}/{id}/subject/:sub` | DELETE | Admin | NA→R | Delete subject (registry notified) |
| `{prefix}/{id}/invite` | POST | Admin | NA→R | Invite subjects → create with adminApproved, send emails |
| `{prefix}/{id}/approve/:sub` | GET | Admin | NA | Approve subject (email link friendly) |

### Delegation Endpoints

| Endpoint | Method | Auth | DOs | Description |
|----------|--------|------|-----|-------------|
| `{prefix}/{id}/subject/:sub/actors` | POST | Admin | NA | Add authorized actor |
| `{prefix}/{id}/subject/:sub/actors/:actorId` | DELETE | Admin | NA | Remove authorized actor |
| `{prefix}/{id}/delegated-token` | POST | Auth | NA | Request token to act on behalf of another subject |

### Registry Endpoints

| Endpoint | Method | Auth | DOs | Description |
|----------|--------|------|-----|-------------|
| `{prefix}/discover` | POST | — | R | Email-based scope discovery |
| `{prefix}/claim-universe` | POST | Turnstile | R→NA | Self-signup: claim universe slug, RPC to NA to send magic link |
| `{prefix}/claim-star` | POST | Turnstile | R→NA | Self-signup: claim star slug, RPC to NA to send magic link |
| `{prefix}/create-galaxy` | POST | Admin | R | Admin creates galaxy (records in registry only) |

---

## Sequence Diagrams

In these diagrams, `{p}` = `{prefix}` (the single public URL prefix, default `/auth`), and `{id}` = `{universeGalaxyStarId}`.

### Token Refresh (Hot Path)

No registry involvement. This is the most frequent operation (~every 15 minutes per active session).

```mermaid
sequenceDiagram
    participant C as Client
    participant W as Worker
    participant NA as NebulaAuth DO

    C->>W: POST /{p}/{id}/refresh-token [cookie]
    W->>NA: Route by universeGalaxyStarId
    NA->>NA: Verify refresh token hash
    NA->>NA: Delete old refresh token
    NA->>NA: Insert rotated refresh token
    NA->>NA: Read subject (role, adminApproved)
    NA->>NA: Sign access token JWT
    NA-->>W: 200 { access_token } + Set-Cookie (rotated refresh)
    W-->>C: Response
```

### Magic Link Login

Registry-first mutation on first verification only: if the subject already exists with `emailVerified=1`, the email→scope mapping is already in the registry and the RPC call is skipped.

**First-user-is-founder:** When a `NebulaAuth` DO instance has zero subjects during magic link completion, the first verified email becomes the founding admin (`isAdmin=1, adminApproved=1, emailVerified=1`). This applies to all tiers — universes, galaxies, and stars — regardless of how the instance was created (self-signup, admin invite, or platform admin). Galaxy authors don't need to handle first-admin bootstrapping — nebula-auth takes care of it.

```mermaid
sequenceDiagram
    participant C as Client
    participant W as Worker
    participant NA as NebulaAuth DO
    participant R as Registry DO

    Note over C: Step 1: Request magic link
    C->>W: POST /{p}/{id}/email-magic-link { email, turnstile }
    W->>NA: Route by universeGalaxyStarId
    NA->>NA: Validate Turnstile
    NA->>NA: Create/find subject (local only, no registry yet)
    NA->>NA: Create magic link token, send email
    NA-->>C: 200 "Check your email"

    Note over C: Step 2: Click magic link
    C->>W: GET /{p}/{id}/magic-link?one_time_token=...
    W->>NA: Route by universeGalaxyStarId
    NA->>NA: Validate one-time token
    alt Subject not yet emailVerified
        NA->>R: RPC: register email→scope mapping
        R->>R: INSERT INTO Emails
        R-->>NA: OK
        NA->>NA: Set emailVerified=1
    end
    NA->>NA: Create refresh token
    NA->>NA: First-user-is-founder check (if zero prior subjects)
    NA-->>C: 302 redirect + Set-Cookie (path-scoped refresh token)
```

### Admin Invite Flow

Simpler than the magic link login for new users: the admin pre-approves the invitee (`adminApproved=1`) and registers the email→scope mapping in the registry upfront. When the invitee clicks the link, there's no conditional registry RPC (already done), no first-user-is-founder check (at least one admin already exists even if they are higher scoped), and no Turnstile (the invite token itself is the proof of legitimacy).

```mermaid
sequenceDiagram
    participant C as Client
    participant W as Worker
    participant NA as NebulaAuth DO
    participant R as Registry DO

    Note over C: Step 1: Admin invites user
    C->>W: POST /{p}/{id}/invite { emails } [admin JWT]
    W->>NA: Route by universeGalaxyStarId
    NA->>R: RPC: register email→scope for each invitee
    R-->>NA: OK
    NA->>NA: Create subjects with adminApproved=1
    NA->>NA: Create invite tokens, send emails
    NA-->>C: 200 { invited, errors }

    Note over C: Step 2: Invitee clicks link
    C->>W: GET /{p}/{id}/accept-invite?invite_token=...
    W->>NA: Route
    NA->>NA: Validate invite token
    NA->>NA: Set emailVerified=1, create refresh token
    NA-->>C: 302 redirect + Set-Cookie
```

### Universe Self-Signup

Registry validates slug availability, records the instance, then calls NebulaAuth via internal RPC to send the magic link email. The client receives a single response — no redirect, no second POST. Anti-squatting is deferred — platform admin can manually revoke claims if abused.

```mermaid
sequenceDiagram
    participant C as Client
    participant W as Worker
    participant R as Registry DO
    participant NA as NebulaAuth DO

    C->>W: POST /{p}/claim-universe { slug, email, turnstile }
    W->>R: Route to registry singleton
    R->>R: Validate Turnstile
    R->>R: Check slug availability
    R->>R: Check not reserved (nebula-platform)
    R->>R: INSERT INTO Instances (slug)
    R->>NA: RPC: create subject + send magic link (DO created on-demand)
    NA->>NA: Create subject (local only, no registry — caller already recorded it)
    NA->>NA: Create magic link token, send email
    NA-->>R: OK
    R-->>C: 200 "Check your email"

    Note over C: User clicks magic link in email
    C->>W: GET /{p}/{slug}/magic-link?one_time_token=...
    W->>NA: Route
    NA->>NA: Validate one-time token
    NA->>R: RPC: register email→scope
    R-->>NA: OK
    NA->>NA: Zero subjects → first-user-is-founder
    NA->>NA: Set isAdmin=1, adminApproved=1, emailVerified=1
    NA->>NA: Create refresh token
    NA-->>C: 302 redirect + Set-Cookie
```

### Star Self-Signup

Same pattern as universe, but registry also validates parent galaxy exists.

### Discovery Flow

Registry-only. No NebulaAuth involvement. After the user picks a scope, the client tries refresh first (in case a valid path-scoped cookie exists), then falls back to magic link. See `tasks/nebula-client.md` for the full login flow.

```mermaid
sequenceDiagram
    participant C as Client
    participant W as Worker
    participant R as Registry DO

    C->>W: POST /{p}/discover { email }
    W->>R: Route to registry singleton
    R->>R: SELECT * FROM Emails WHERE email = ?
    R-->>C: 200 [{ instanceName, isAdmin }, ...]

    Note over C: User picks a scope → client tries refresh, falls back to magic link
```

### Subject Deletion

The remaining endpoints not shown above follow one of two patterns:

**NA→R (same pattern as this diagram)** — `NebulaAuth` calls registry first, then writes locally:
- `PATCH subject/:sub` — update subject flags (registry notified if role changes)

**NA-only (no registry involvement)** — straightforward request→DO→response:
- `logout`, `subjects` GET, `subject/:sub` GET, `approve/:sub`, `subject/:sub/actors` POST/DELETE, `delegated-token`

```mermaid
sequenceDiagram
    participant C as Client
    participant W as Worker
    participant NA as NebulaAuth DO
    participant R as Registry DO

    C->>W: DELETE /{p}/{id}/subject/:sub [admin JWT]
    W->>W: Verify JWT, check admin scope
    W->>NA: Route by universeGalaxyStarId
    NA->>R: RPC: remove email→scope mapping
    R->>R: DELETE FROM Emails WHERE email=? AND instanceName=?
    R-->>NA: OK
    NA->>NA: DELETE subject + cascade (tokens, actors)
    NA-->>C: 204 No Content
```

### Galaxy Creation (Admin Only)

Registry-only. No NebulaAuth DO created until first request routes to it. Most galaxies won't have dedicated galaxy admins — universe admins manage them directly via wildcard access.

```mermaid
sequenceDiagram
    participant C as Client
    participant W as Worker
    participant R as Registry DO

    C->>W: POST /{p}/create-galaxy { universeGalaxyId } [admin JWT]
    W->>W: Verify JWT
    W->>R: Route to registry singleton
    R->>R: Verify access.id grants admin over parent universe
    R->>R: Derive parent universe from slug, check it exists in Instances
    R->>R: Check galaxy slug available
    R->>R: INSERT INTO Instances (universeGalaxyId)
    R-->>C: 201 { instanceName }
```

### Coach Carol Multi-Session

Coach Carol works with multiple clients in separate browser tabs, each with a different email address. Switching tabs must not require re-login. Each DO instance sets its refresh cookie with a `Path` scoped to its `universeGalaxyStarId`, so the browser **automatically** sends the correct cookie to the correct DO instance — no client-side cookie management required.

```mermaid
sequenceDiagram
    participant C as Carol's Browser
    participant W as Worker
    participant S1 as NebulaAuth (acme.crm.acme-corp)
    participant S2 as NebulaAuth (bigco.hr.bigco-hq)

    Note over C: Tab 1: Login to Star A
    C->>W: Magic link flow for carol@acme.com
    W->>S1: Route
    S1-->>C: Set-Cookie (refresh-token=A, Path=/{p}/acme.crm.acme-corp)

    Note over C: Tab 2: Login to Star B
    C->>W: Magic link flow for carol@bigco.com
    W->>S2: Route
    S2-->>C: Set-Cookie (refresh-token=B, Path=/{p}/bigco.hr.bigco-hq)

    Note over C: Tab 1 refreshes (only cookie A sent)
    C->>W: POST /{p}/acme.crm.acme-corp/refresh-token [cookie A]
    W->>S1: Route
    S1-->>C: 200 { access_token: "...acme-corp..." }

    Note over C: Tab 2 refreshes (only cookie B sent)
    C->>W: POST /{p}/bigco.hr.bigco-hq/refresh-token [cookie B]
    W->>S2: Route
    S2-->>C: 200 { access_token: "...bigco-hq..." }
```

**Access revocation is isolated.** When `bigco` revokes `carol@bigco.com`, the current access token expires within the TTL (~15 min), the next refresh fails, and the `NebulaAuth` DO notifies the registry via RPC to remove the email→scope mapping. Other tabs are completely unaffected — different DOs, different cookies, different subjects.

**Admin hierarchy uses JWT wildcards, not separate cookies.** A Universe admin logs in at `{prefix}/george-solopreneur` and gets a JWT with `{ "id": "george-solopreneur.*", "admin": true }`. That JWT grants access to any Star-level endpoint beneath it via the auth hook's wildcard match — no separate Star-level login needed. The refresh cookie is scoped to `Path={prefix}/george-solopreneur`, so it won't be sent to `{prefix}/george-solopreneur.app.tenant/refresh-token` (path doesn't match), but that's fine — the admin refreshes at Universe level only.

---

### `universeGalaxyStarId` Format Constraints

Slugs: lowercase letters, digits, and hyphens only (`[a-z0-9-]+`). No periods within a slug. Universe slugs are globally unique. Galaxy slugs are unique within their Universe. Star slugs are unique within their Galaxy. Convention: domain-based Universe names (e.g., `lumenize-com` for `lumenize.com`).

**Reserved slug** (cannot be used as universe name): `nebula-platform`. The registry endpoint keywords (`discover`, `claim-universe`, `claim-star`, `create-galaxy`) do not need to be reserved because `.endsWith()` routing means a universe named e.g. `discover` would have routes like `{prefix}/discover/refresh-token` — which doesn't end with `/discover`.

### Package Strategy: Fork from `@lumenize/auth`

`@lumenize/nebula-auth` is a fork of `@lumenize/auth`. Individual utility functions will be imported from `@lumenize/auth` where it makes sense:

**Likely imports from `@lumenize/auth`:**
- `signJwt`, `verifyJwt`, `verifyJwtWithRotation`, `importPrivateKey`, `importPublicKey`
- `generateRandomString`, `generateUuid`, `hashString`, `parseJwtUnsafe`
- `verifyTurnstileToken`
- `AuthEmailSenderBase`, `ResendEmailSender`
- `extractWebSocketToken`, `verifyWebSocketToken`, `getTokenTtl`, `WS_CLOSE_CODES`

**Will NOT import (must fork/rewrite):**
- `LumenizeAuth` DO class → becomes `NebulaAuth`
- `createRouteDORequestAuthHooks` → becomes `createRouteDORequestNebulaAuthHooks`
- `createAuthRoutes` → becomes `createNebulaAuthRoutes`
- `createJwtPayload` → new `access` claim structure
- SQL schemas → new schema with `access` claim assembly
- `testLoginWithMagicLink` → new helper supporting multi-star, path-scoped cookies
- Email HTML templates → Nebula default templates (customizable name/logo per tier — see [Follow-On: Email Template Customization](#email-template-customization))
- Types → new `NebulaJwtPayload`, `AccessEntry`, etc.

**New:**
- `NebulaAuthRegistry` DO class
- Self-signup and discovery routes
- DO-to-DO RPC calls from `NebulaAuth` to registry for subject lifecycle events

---

## Data Model

### NebulaAuth: Per-Instance SQLite Schema

Each `NebulaAuth` instance has its own SQLite database. Since each instance represents exactly one `universeGalaxyStarId`, subjects in that instance are members of that tier by definition. No junction table mapping subjects to tiers is needed — DO instance isolation provides that relationship implicitly.

#### Subjects Table

```sql
CREATE TABLE IF NOT EXISTS Subjects (
  sub TEXT PRIMARY KEY,          -- UUID v4
  email TEXT UNIQUE NOT NULL,    -- Lowercase; inline UNIQUE creates the index
  emailVerified INTEGER NOT NULL DEFAULT 0,
  adminApproved INTEGER NOT NULL DEFAULT 0,
  isAdmin INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,    -- Unix timestamp (ms)
  lastLoginAt INTEGER            -- Unix timestamp (ms), nullable
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_Subjects_isAdmin
  ON Subjects(sub) WHERE isAdmin = 1;
```

Notes:
- `UNIQUE` on `email` creates an implicit unique index — same B-tree as `CREATE UNIQUE INDEX`, usable by the query planner, so **no separate email index** is needed (a redundant explicit index would double write cost for zero benefit)
- `idx_Subjects_isAdmin` — partial index; only costs a write when `isAdmin = 1`

Write costs (per operation):
| Operation | `rowsWritten` | Notes |
|-----------|:-------------:|-------|
| INSERT (non-admin) | 2 | 1 table + 1 email UNIQUE index (partial isAdmin index skipped) |
| INSERT (admin) | 3 | 1 table + 1 email + 1 isAdmin partial index |
| UPDATE isAdmin 0→1 | 2 | 1 table + 1 isAdmin index (email unchanged, not rewritten) |
| UPDATE lastLoginAt | 1 | Non-indexed column, only table row rewritten |
| DELETE | 1 | Index cleanup not counted |

#### Token Tables

All three follow the same pattern: hashed token as TEXT PK, lookup by email/subject, check expiry, mark used or revoked. Each DO instance manages its own tokens independently.

```sql
CREATE TABLE IF NOT EXISTS MagicLinks (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_MagicLinks_email ON MagicLinks(email);
```

`InviteTokens` is identical but without the `used` flag (single-use by design — deleted on redemption). `RefreshTokens` is keyed by `tokenHash` (not plaintext), references `subjectId` with `ON DELETE CASCADE`, and uses a `revoked` flag instead of `used`.

#### `AuthorizedActors` Table

Delegation actor relationships, scoped to the DO instance.

### NebulaAuthRegistry: Singleton SQLite Schema

The registry uses pure SQL with portable types to ease future migration to a horizontally scalable database (e.g., Postgres) if the single-DO model is outgrown.

#### Instances Table

```sql
CREATE TABLE IF NOT EXISTS Instances (
  instanceName TEXT PRIMARY KEY,  -- universeGalaxyStarId (e.g., acme-corp.crm.tenant-a)
  createdAt INTEGER NOT NULL      -- Unix timestamp (ms)
) WITHOUT ROWID;
```

Tier and parent are derived from `instanceName`: segment count gives tier (1=universe, 2=galaxy, 3=star), stripping the last segment gives parent.

#### Emails Table

```sql
CREATE TABLE IF NOT EXISTS Emails (
  email TEXT NOT NULL,            -- Lowercase email
  instanceName TEXT NOT NULL,     -- universeGalaxyStarId
  isAdmin INTEGER NOT NULL DEFAULT 0, -- Denormalized from NebulaAuth Subjects — avoids RPC fan-out during discovery
  createdAt INTEGER NOT NULL,     -- Unix timestamp (ms)
  PRIMARY KEY (email, instanceName)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_Emails_instanceName
  ON Emails(instanceName);        -- Reverse lookups: "list all emails in this instance"
```

Notes:
- Compound PK already covers email-first lookups (leftmost prefix) — **no separate email index**
- `idx_Emails_instanceName` costs +1 write per INSERT (2 total)
- UPDATE on `isAdmin` (non-indexed column) costs only 1 write
- DELETE always costs 1 write regardless of index count

Scope is derived at query time: `instanceName` for stars (3 segments), `instanceName + ".*"` for universe/galaxy (1-2 segments).

#### Registry Write Cost Summary

| Operation | `rowsWritten` | Notes |
|-----------|:-------------:|-------|
| INSERT Instances | 1 | `WITHOUT ROWID` — no separate rowid index |
| INSERT Emails | 2 | 1 table + 1 `idx_Emails_instanceName` |
| UPDATE Emails.isAdmin | 1 | `isAdmin` not indexed, only table row rewritten |
| DELETE Emails | 1 | Index cleanup not counted in `rowsWritten` |

---

## JWT Claims

### `NebulaJwtPayload`

```typescript
interface AccessEntry {
  id: string  // universeGalaxyStarId or wildcard pattern (e.g. "george-solopreneur.*")
  admin?: boolean  // true = admin of this scope; omit when false (keeps JWT compact)
}

interface NebulaJwtPayload {
  iss: string            // Issuer
  aud: string            // Audience
  sub: string            // Subject UUID (within the issuing DO instance)
  exp: number            // Expiration (Unix seconds)
  iat: number            // Issued at (Unix seconds)
  jti: string            // JWT ID (UUID)
  adminApproved: boolean
  access: AccessEntry    // Scoped access (one entry per JWT, issued by one DO instance)
  act?: ActClaim         // Delegation chain per RFC 8693 (optional)
}
```

### Access Claim Examples

**Star-level regular user:**
```json
{ "access": { "id": "george-solopreneur.georges-first-app.acme-corp" } }
```

**Star-level admin:**
```json
{ "access": { "id": "george-solopreneur.georges-first-app.acme-corp", "admin": true } }
```

**Galaxy admin (access to all Stars beneath):**
```json
{ "access": { "id": "george-solopreneur.georges-first-app.*", "admin": true } }
```

**Universe admin (access to all Galaxies and Stars beneath):**
```json
{ "access": { "id": "george-solopreneur.*", "admin": true } }
```

**Platform admin (access to everything):**
```json
{ "access": { "id": "*", "admin": true } }
```

### Access Claim Rules

- Each JWT is issued by one DO instance and contains exactly one `access` entry.
- Wildcard `.*` means "this scope and everything beneath it."

### Admin Model

`isAdmin` is contextual to the DO instance that issued the JWT. A Universe admin's JWT carries `{ "id": "george-solopreneur.*", "admin": true }`. The auth hook checks the `access` entry to determine admin status.

For future extensibility, the `AccessEntry` type can grow additional boolean or string fields (e.g., `billing?: boolean`) without breaking the existing format. For now, only `admin` exists.

---

## Auth Hooks: `createRouteDORequestNebulaAuthHooks`

The hook pipeline:

1. Extract JWT from `Authorization: Bearer` header or WebSocket subprotocol
2. Verify JWT signature with key rotation support
3. Validate standard claims: `iss`, `aud`, `exp`
4. Parse `universeGalaxyStarId` from the URL (second path segment)
5. Match `access.id` against URL — exact match or wildcard match
6. Check `admin` flag if the endpoint requires admin access
7. Enforce access gate: `admin || adminApproved` for the matching entry
8. Rate limiting per subject
9. Forward request to downstream DO with verified JWT

### Wildcard Matching Examples

```
matchAccess("*", "george-solopreneur")                                → true (platform admin)
matchAccess("*", "george-solopreneur.app.tenant")                     → true (platform admin)
matchAccess("george-solopreneur.*", "george-solopreneur")             → true (universe-level access)
matchAccess("george-solopreneur.*", "george-solopreneur.app")         → true (galaxy beneath)
matchAccess("george-solopreneur.*", "george-solopreneur.app.tenant")  → true (star beneath)
matchAccess("george-solopreneur.app.*", "george-solopreneur")         → false (galaxy admin can't access universe)
matchAccess("george-solopreneur.app.*", "george-solopreneur.app")     → true
matchAccess("george-solopreneur.app.tenant", "george-solopreneur.app.tenant") → true (exact)
matchAccess("george-solopreneur.app.tenant", "george-solopreneur.app.other")  → false
```

---

## Access Control

### Access Gate

The access gate is: **`admin || adminApproved`**. Invited users pass immediately (the invite flow sets `adminApproved=true` — see [Admin Invite Flow](#admin-invite-flow)). Users who request access via magic link without an invite must be explicitly approved by an admin.

`emailVerified` is not in the JWT because it is always `true` by construction — no refresh token (and therefore no JWT) is ever issued without prior email verification (magic link click or invite acceptance). This invariant holds for future auth methods too (OAuth providers verify email; passkeys require email verification at registration). `emailVerified` is retained in the `Subjects` table to track invite completion state, but it is not a gating claim.

---

## NebulaAuthRegistry

### Purpose

The registry is a singleton DO that maintains a global view of the Nebula auth landscape. Individual `NebulaAuth` instances are self-contained for auth flows, but certain cross-cutting concerns require a central index:

1. **Slug availability** — Is `acme-corp` already claimed as a universe? Is `acme-corp.crm.tenant-x` taken?
2. **Discovery** — User enters email, gets back all `universeGalaxyStarId`s they belong to
3. **Self-signup routing** — Validate and record new universe/star claims before delegating to `NebulaAuth` instances
4. **Platform admin visibility** — List all universes, galaxies, stars without using Cloudflare's DO management APIs

Discovery is unauthenticated — the user doesn't have a JWT yet and is trying to figure out where to log in. The registry reveals only which scopes an email is associated with, not any sensitive data. See the [Discovery Flow](#discovery-flow) and [Subject Deletion](#subject-deletion) sequence diagrams.

---

## Platform Admin (Bootstrap)

### Reserved Instance: `nebula-platform`

`NEBULA_AUTH_BOOTSTRAP_EMAIL` env var designates the platform super-admin (Lumenize operator). This email authenticates at the reserved `nebula-platform` DO instance via standard magic link flow at `{prefix}/nebula-platform`. The one conditional behavior: when the DO recognizes the bootstrap email, it issues a JWT with `{ "access": { "id": "*", "admin": true } }` instead of the normal scope, granting access to all universes, galaxies, and stars. Refresh cookie is scoped to `Path={prefix}/nebula-platform`.

The `nebula-platform` instance goes through the normal magic link flow including the registry RPC on first verification, so it appears in the `Emails` table (`instanceName='nebula-platform'`, `isAdmin=1`). The `Instances` table does not require a corresponding row — `nebula-platform` is a reserved slug that the router always recognizes. Discovery will correctly return it as a scope for the bootstrap email.

The `nebula-platform` slug is safe from collision because we encourage universe names derived from domain names (e.g., `lumenize-com` for `lumenize.com`), and `.platform` is not a valid ICANN TLD.

### Admin Creation Chain

- **Platform admin** creates universe admins (via invite at universe-level DOs)
- **Universe admins** can create other universe admins for their universe, galaxy admins, and star admins
- **Galaxy admins** can create other galaxy admins and star admins beneath them
- **Star admins** manage star users

Each level's invite/approve flow is scoped to its DO instance.

---

## Configuration

Product-level decisions are hardcoded as constants since we control all deployments. Only secrets and operational switches are env vars.

### Environment Variables (secrets + operational)

| Variable | Notes |
|----------|-------|
| `JWT_PRIVATE_KEY_BLUE/GREEN` | Ed25519 signing keys (secret) |
| `JWT_PUBLIC_KEY_BLUE/GREEN` | Ed25519 verification keys (secret) |
| `PRIMARY_JWT_KEY` | Active signing key (`'BLUE'` or `'GREEN'`) |
| `RESEND_API_KEY` | Resend email API key (secret) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret (optional) |
| `NEBULA_AUTH_BOOTSTRAP_EMAIL` | Platform super-admin email (optional) |
| `NEBULA_AUTH_TEST_MODE` | Enable test endpoints (`'false'` default) |

### Hardcoded Constants

| Constant | Value | Notes |
|----------|-------|-------|
| `PLATFORM_INSTANCE_NAME` | `'nebula-platform'` | Reserved DO instance for platform admin |
| `REGISTRY_INSTANCE_NAME` | `'registry'` | Singleton instance name for `NebulaAuthRegistry` |
| `NEBULA_AUTH_PREFIX` | `'/auth'` | Single URL prefix for all auth routes (`{prefix}`) |
| `NEBULA_AUTH_ISSUER` | TBD | JWT `iss` claim |
| `NEBULA_AUTH_AUDIENCE` | TBD | JWT `aud` claim |
| `ACCESS_TOKEN_TTL` | `900` | Access token lifetime (seconds) |
| `REFRESH_TOKEN_TTL` | `2592000` | Refresh token lifetime (seconds) |
| `MAGIC_LINK_TTL` | `1800` | Magic link lifetime (seconds) |
| `INVITE_TTL` | `604800` | Invite token lifetime (seconds) |

### Redirect Logic

Hardcode redirect to `/app` for now. The real redirect target is a NebulaClient/NebulaUI concern — auth's job is validate token → set refresh cookie → redirect *somewhere*. Tests only need to verify the redirect happens and the cookie is set correctly. Revisit when full Nebula e2e testing reveals the actual URL structure.

---

## Validation Plan

### Testing Infrastructure

Two `@lumenize/testing` capabilities are central to these tests:

- **`Browser`** — Cookie-aware fetch and WebSocket. Already scopes cookies by name + domain + path (verified in `cookie-utils.ts` `cookieMatches()`), follows redirects manually to capture `Set-Cookie` headers from intermediate responses. Critical for the Coach Carol multi-session scenario. That said, for every major new use of `@lumenize/testing`, we've had to add/alter functionality, so let's be open to that if the need arises.

- **`createTestingClient`** — RPC client that can read/write DO state directly: `client.ctx.storage.sql.exec(...)` to query tables, `client.ctx.storage.kv.get(...)` to inspect KV, and call any public method on the DO instance. Use this to verify internal state (e.g., confirm `isAdmin=1` in the Subjects table, check that the registry's Emails table has the right rows) instead of adding test-only methods to the DO classes. See `website/docs/testing/usage.mdx` for the full API.

**Test mode vs e2e email** — Most tests should use test mode (`NEBULA_AUTH_TEST_MODE=true`), which returns magic link URLs directly in the response body instead of sending email. This avoids the SMTP round trip for the common case. A small number of e2e tests should exercise real email delivery using the internal `tooling/email-test/` infrastructure: a deployed `email-test` Worker (`EmailTestDO`, a plain `DurableObject` — not LumenizeDO) receives emails via Cloudflare Email Routing and pushes them to test clients over WebSocket (~1.5 seconds round trip). The `waitForEmail()` and `extractMagicLink()` helpers in `packages/auth/test/e2e-email/` wrap this into a simple API. The auth DO runs in-process (no deployment needed) but sends real email via Resend.

**⚠️ Test mode env vars go in `vitest.config.js` only** — never in `.dev.vars` or `wrangler.jsonc`. The vitest config is not deployed, so there is zero risk of test mode leaking to production. This is the pattern `@lumenize/auth` follows (`LUMENIZE_AUTH_TEST_MODE` set at `packages/auth/vitest.config.js:43`). Nebula-auth should follow the same pattern with `NEBULA_AUTH_TEST_MODE`.

### Coach Multi-Session Scenario

#### Test: Single Browser, Multiple Path-Scoped Refresh Cookies

Using a **single `Browser` instance** (simulating one real browser), verify:

1. **Login to Star A** — Magic link flow for `carol@acme.com` at DO instance `acme.crm.acme-corp`. Verify `refresh-token` cookie is set with `Path={prefix}/acme.crm.acme-corp`.
2. **Login to Star B** — Magic link flow for `carol@bigco.com` at DO instance `bigco.hr.bigco-hq`. Verify a **second** `refresh-token` cookie is set with `Path={prefix}/bigco.hr.bigco-hq`. Verify the Star A cookie still exists (not overwritten).
3. **Refresh Star A** — `POST {prefix}/acme.crm.acme-corp/refresh-token`. Verify the browser sends only the Star A cookie (path match). Verify access token is issued with `access: { "id": "acme.crm.acme-corp" }`.
4. **Refresh Star B** — `POST {prefix}/bigco.hr.bigco-hq/refresh-token`. Verify the browser sends only the Star B cookie. Verify access token has `access: { "id": "bigco.hr.bigco-hq" }`.
5. **Revoke Star B** — Delete Carol's subject in the `bigco.hr.bigco-hq` DO. Verify Star B refresh fails. Verify Star A refresh still succeeds.
6. **Cookie isolation** — Verify `browser.getCookiesForRequest('{prefix}/acme.crm.acme-corp/refresh-token')` does NOT include the Star B cookie, and vice versa.

#### Test: Universe Admin Wildcard Access

1. **Login at Universe level** — Admin logs in at `acme` (1-segment instance). Refresh cookie set with `Path={prefix}/acme`.
2. **Access Star-level resource** — Use the Universe-scoped JWT (with `access: { "id": "acme.*", "admin": true }`) to access `/nebula/acme.crm.acme-corp/some-resource`. Verify the auth hook grants access via wildcard match.
3. **Cookie path does not match Star auth path** — Verify that `browser.getCookiesForRequest('{prefix}/acme.crm.acme-corp/refresh-token')` does NOT include the Universe cookie (path `{prefix}/acme` is not a prefix of `{prefix}/acme.crm.acme-corp`). This is correct — the admin refreshes at Universe level only.
4. **Verify upward access is denied** — A Galaxy admin JWT for `acme.crm.*` must be rejected when accessing `{prefix}/acme/admin-panel` (galaxy admin cannot access universe).

**Tab simulation deferred** — The Coach Multi-Session test above already verifies cookie path isolation using a single `Browser` instance (shared cookie jar, path-scoped sends). Multi-tab testing with `browser.context(origin)` and per-tab access token storage (sessionStorage independence) is a NebulaClient concern — defer to `tasks/nebula-client.md` when that dual-scope model is implemented.

### Registry Scenarios

#### Test: Discovery Flow

1. Create two stars with the same email (`carol@acme.com` in both `acme.crm.star-a` and `acme.crm.star-b`)
2. Query `POST {prefix}/discover` with `carol@acme.com`
3. Verify both scopes returned
4. Revoke Carol from `star-b` (delete subject — `NebulaAuth` DO updates registry via RPC)
5. Query discovery again, verify only `star-a` returned

#### Test: Universe Self-Signup

1. Claim universe slug `new-universe` via `POST {prefix}/claim-universe { slug, email, turnstile }` → 200 "Check your email" (registry records instance, RPCs to NA to send magic link)
2. Click magic link → `GET {prefix}/new-universe/magic-link?one_time_token=...`
3. Verify founding admin has `isAdmin=1, adminApproved=1`
4. Verify registry `Instances` table has the universe record
5. Verify registry `Emails` table has the email→scope mapping
6. Attempt to claim same slug again → rejected

#### Test: Star Self-Signup

1. Universe admin creates galaxy `new-universe.my-app` via registry
2. New user claims star via `POST {prefix}/claim-star { universeGalaxyStarId, email, turnstile }` → 200 "Check your email"
3. Click magic link to complete flow
4. Verify founding admin status
5. Verify registry records
6. Attempt to claim star under nonexistent galaxy → rejected

#### Test: Galaxy Creation (Admin Only)

1. Universe admin creates galaxy via `POST {prefix}/create-galaxy`
2. Verify registry records the galaxy
3. Unauthenticated request to create galaxy → rejected
4. Star admin JWT attempting to create galaxy → rejected (insufficient scope)

### Inherited from `@lumenize/auth`

`packages/auth/test/auth.test.ts` (~2,800 lines, ~150 test cases) covers all subject management endpoints, magic link flows, refresh token rotation, invite flows, delegation, and edge cases. Copy this test file into `packages/nebula-auth/test/` as a starting point — don't just import from `@lumenize/auth`. Nebula-auth will diverge over time (multi-tier auth, registry integration, wildcard JWTs), and we need the full suite running locally against the nebula-auth codebase on every change.

---

## Implementation Phases

### Phase 0: Prerequisites

- **Verify `@lumenize/testing` Browser path scoping** — Write a quick test confirming that the Browser class correctly distinguishes cookies by path in `getCookiesForRequest`. If it doesn't, upgrade the Browser class first.
- **Audit `@lumenize/auth` for importable utilities** — Confirm the exports listed in Package Strategy are stable and usable.
- **~~Research DO SQLite index write costs~~** — DONE. Results in `tasks/do-sqlite-write-costs.md`, experiment code in `experiments/do-write-costs/`. Key decisions applied:
  - All tables with TEXT PK or compound text PK use `WITHOUT ROWID` (saves 1 write per INSERT)
  - No redundant leftmost-prefix indexes (compound PK already covers first-column lookups)
  - `UNIQUE` constraint preferred over separate unique index (same cost, enforces uniqueness)
  - Partial index on `isAdmin` saves writes for non-admin inserts
  - Schema sections above updated with per-operation write cost tables
  - Blog post: Phase 3 of `tasks/do-sqlite-write-costs.md` (separate task)

### Phase 1: Package Scaffold + `universeGalaxyStarId` Parsing

- Create `packages/nebula-auth/` with standard package structure
- `universeGalaxyStarId` validation and parsing: slug regex, segment counting, tier detection
- TypeBox schemas for `AccessEntry`, `NebulaJwtPayload`
- TypeScript types
- Unit tests for parsing and validation

**Expected outcome:** `parseUniverseGalaxyStarId("george-solopreneur.app.tenant")` returns `{ universe: "george-solopreneur", galaxy: "app", star: "tenant", tier: "star", raw: "george-solopreneur.app.tenant" }`. Invalid formats throw.

### Phase 2: NebulaAuth Core

- `NebulaAuth` DO class
- SQL schema (Subjects, MagicLinks, InviteTokens, RefreshTokens, AuthorizedActors)
- Lazy schema init, expired token sweep (alarm-based cleanup of expired/used tokens — same pattern as `@lumenize/auth`)
- Magic link login flow with path-scoped `Set-Cookie`
- Refresh token flow with path-scoped cookie
- First-user-is-founder logic: zero subjects → first verified email becomes founding admin
- Platform admin: `nebula-platform` reserved instance, bootstrap email conditional → `{ "id": "*", "admin": true }`
- Tier-aware behavior: the DO knows its tier from its instance name segment count
- JWT `access` claim assembly: `{ id: instanceName, admin: isAdmin }` for Star-level; `{ id: instanceName + ".*", admin: isAdmin }` for Universe/Galaxy-level

**Expected outcome:** Full magic link login, refresh, logout working for a single DO instance. Path-scoped cookies verified. First-user-is-founder tested with an empty DO.

### Phase 3: Auth Hooks

- `createRouteDORequestNebulaAuthHooks` — the hook pipeline described above
- Wildcard matching for `access.id` (including `"*"` for platform admin)
- Admin check from matched `access` entry
- Access gate enforcement: `matchedEntry.admin || adminApproved`
- Rate limiting per subject

**Expected outcome:** A Star-level endpoint correctly accepts JWTs from its own Star DO and from Universe/Galaxy admins. Rejects JWTs from unrelated stars or lower-tier admins trying to access higher tiers.

### Phase 4: Coach Scenario Integration Tests

- All coach multi-session tests from the Validation Plan
- Single Browser, multiple path-scoped cookies
- Universe admin wildcard access
- Revocation isolation

**Expected outcome:** Coach Carol scenario works end-to-end. All validation tests pass. (Tab simulation with Browser contexts deferred to NebulaClient — see `tasks/nebula-client.md`.)

### Phase 5: Admin Endpoints + Invite Flow (Local)

- Subject CRUD (list, get, patch, delete) — scoped to the DO instance, local-only for now
- Invite flow (admin invites users to this specific star/galaxy/universe) — local subject creation + email, no registry call yet
- Delegated tokens (act-on-behalf) — scoped to the DO instance
- Bootstrap admin protection (cannot modify/delete self or bootstrap admin)

**Expected outcome:** Full admin management within a single DO instance. Invite flow sends emails and creates subjects locally. Registry notification (NA→R) deferred to Phase 6.

### Phase 6: NebulaAuthRegistry + NA→R Wiring

- `NebulaAuthRegistry` DO class with singleton SQLite schema (`Instances`, `Emails`)
- RPC interface for `NebulaAuth` instances to call: register/remove email→scope, update role
- Wire up registry-first mutation pattern in `NebulaAuth`: invite, subject delete, and role change now call registry via RPC before local write
- Slug availability check endpoints
- Discovery endpoint (`POST {prefix}/discover`)
- Galaxy creation endpoint (authenticated, validates parent universe exists and JWT scope)
- Self-signup endpoints: `claim-universe`, `claim-star` (validate availability, record in registry, RPC to NebulaAuth instance to send magic link)

**Expected outcome:** Registry tracks all instances and email→scope mappings. NA→R mutation pattern wired up for invite, delete, and role change. Discovery returns correct scopes. Self-signup creates instances and founding admins. Galaxy creation enforced as admin-only. Subject mutations fail cleanly if registry is unreachable.

### Phase 7: Worker Routes + Email Templates

- `createNebulaAuthRoutes` — Worker-level routing to `NebulaAuth` instances and `NebulaAuthRegistry` singleton
- Turnstile validation on public-facing endpoints (magic link, self-signup)
- Nebula-branded email templates (the email sender itself — `ResendEmailSender` imported from `@lumenize/auth` — is already wired in Phase 2 for magic link flows)

**Expected outcome:** Complete Worker + DO stack deployed and working.

### Phase 8: Full Integration Tests

- All registry scenario tests from the Validation Plan
- Universe self-signup end-to-end (registry claim → NebulaAuth magic link → registry-first subject creation)
- Star self-signup end-to-end
- Galaxy creation by universe admin
- Discovery flow with multiple scopes
- Subject revocation updates registry via RPC

**Expected outcome:** All self-signup, discovery, and registry notification flows working end-to-end.

### Phase 9: README

`packages/nebula-auth/README.md` is the living reference — expected to stay current with the implementation (unlike the archived task file which is a snapshot of intent).

**Include in README:**
- Two-DO architecture overview (table + registry-first mutation pattern)
- Sequence diagrams (token refresh, magic link, invite, self-signup, discovery, subject deletion, galaxy creation, coach multi-session)
- Endpoint reference (auth flow, subject management, registry tables)
- JWT claims (`NebulaJwtPayload`, access claim examples, wildcard matching examples)
- Data model (SQL DDL for both DOs)
- Configuration (env vars + hardcoded constants tables)

**Leave in task file only (design-time concerns, not maintenance reference):**
- Business context and revenue model
- Architecture decision rationale (why two DOs, why fork vs import, why discovery-first)
- Write cost analysis (per-operation rowsWritten tables)
- Implementation phases
- Follow-on work and package strategy

No website docs — this is a single-deployment BSL 1.1 package, not a public toolkit. Revisit if Nebula is ever open-sourced.

---

## Follow-On Work (Out of Scope)

The following are important notes for when we finish `@lumenize/nebula-auth` and start on `@lumenize/nebula` proper.

### `callContext` Upgrade

The `starId` will be in the `instanceName` property of `callContext.callChain[0]` if the call originated from a Client. However, you can create a new callChain with `{ newCallChain: true }` and calls might originate from a non-Client, like in an alarm handler, so we need another immutable property in callContext for `starId` that is available in all three node mesh types. A particular mesh DO will keep it in storage and will only ever be part of one `starId`. Same thing for Client/Gateway but it's kept in the WebSocket attachment instead of DO storage. For Workers, the `starId` will come from the caller, and outgoing calls will have to propagate that.

My first thought on how to accomplish this is with NebulaDO, NebulaWorker, NebulaClient, and NebulaClientGateway classes that extend the Lumenize* equivalents and override the default onBeforeCall, callContext, and maybe even call itself so only calls within the same `starId` will be allowed. Remember, users won't be extending these and deploying them.

### NebulaClient Adaptation

`NebulaClient` tracks two scopes: the **auth scope** (for refresh cookie path matching) and the **active scope** (the DO it's connected to). For regular users these are the same; for admins with wildcard JWTs they can differ. See `tasks/nebula-client.md` § Two-Scope Model for details.

### Email Domain Auto-Approval

An admin can configure email domains (e.g., `acme-corp.com`) that are automatically approved — any user who logs in with a matching email gets `adminApproved: true` without manual admin action. This removes the approval step for organizations where email ownership is sufficient proof of membership.

**Design notes:**
- A disallow list prevents adding common public email domains (gmail.com, yahoo.com, outlook.com, etc.)
- No burdensome domain verification (DNS TXT record, etc.) is required. The admin is opening access to their own instance — they are only potentially hurting themselves, so we can trust them until there's a problem.
- Stored in the DO instance's SQLite: an `AutoApprovedDomains` table with `domain TEXT PK` and `createdAt INTEGER`
- The magic link login flow checks auto-approved domains after verifying the email, before the admin approval gate
- Multiple instances can independently list the same domain — each DO is self-contained, so `acme.crm.tenant-a` and `bigco.hr.tenant-b` can both auto-approve `example.com` without conflict

### Email Template Customization

Universe, galaxy, and star admins will need to customize the name and logo shown in auth emails (magic link, invite). Initial implementation ships with Nebula default branding. Customization requires storing per-instance branding config (name, logo URL) in the `NebulaAuth` DO's SQLite and injecting it into email templates at render time. The branding config could cascade: star inherits from galaxy, galaxy from universe, with overrides at each level.

### Billing Infrastructure

Usage tracking per `galaxy.star`, monthly report generation, Universe-level billing formulas via DWL/webhooks.
