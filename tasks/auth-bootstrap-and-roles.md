# Auth Bootstrap and Roles

**Status**: Design Complete - Awaiting Review
**Design Documents**:
- `/website/docs/auth/index.mdx` - Overview, login flow, bootstrap
- `/website/docs/auth/users-and-roles.mdx` - Role system, user management APIs
- `/website/docs/auth/extending.mdx` - Subclassing for custom fields/routes

## Goal
Make `@lumenize/auth` a complete, bootstrappable auth system with built-in admin roles so developers can start with a working permission model out of the box.

## Context: Mesh Access Control

This task focuses on `@lumenize/auth` in isolation. However, the design decisions here anticipate follow-on work to integrate mesh-level access control into `@lumenize/mesh`. Currently, anyone with a valid email can authenticate and gain access to the Cloudflare-hosted mesh—authentication implies authorization. The follow-on task will add a `hasMeshAccess` claim that the Worker's `onBeforeConnect`/`onBeforeRequest` hooks check before routing to `LumenizeClientGateway`. See [Follow-on: Mesh Access Control](#follow-on-mesh-access-control) at the end of this document.

## Problem Statement

Currently `@lumenize/auth` handles authentication (magic link login, JWT tokens) but not authorization. There's no:
- User management (list users, update user data)
- Role system (admin, regular user)
- Bootstrap mechanism (who creates the first admin?)
- Way to store user metadata that flows into JWT claims

This means guards like `originAuth.claims.isAdmin` can't work without external systems.

## Design Decisions

### 1. Bootstrap via Environment Variable
`AUTH_SUPER_ADMIN_EMAIL=larry@example.com`
- First login with this email automatically gets `{ isSuperAdmin: true }`
- No database seeding required
- Super-admin can promote others

### 2. Built-in Flags
Hardcode into LumenizeAuth:
- `isSuperAdmin` - can do everything, including promote admins and delete users
- `isAdmin` - can manage users, promote to admin (implies mesh access)
- `hasMeshAccess` - required for regular users to connect to mesh

Super-admins and admins implicitly have mesh access. These are universal patterns. Users extend with finer-grained roles via subclassing.

### 3. User Data in Auth DO
LumenizeAuth already stores users. Extend to store:
- `isAdmin`, `isSuperAdmin` flags
- Extensible `metadata` field for user-defined data
- All flows through to JWT claims automatically

### 4. Subclassing for Extension
Users can extend LumenizeAuth to:
- Add custom user fields/schema
- Add custom routes/methods
- Override behavior

```typescript
export class MyAuth extends LumenizeAuth {
  // Custom user fields flow into claims
}
```

### 5. User Management APIs
New routes (admin-only):
- `GET /auth/users` - list users
- `GET /auth/user/:userId` - get user
- `PATCH /auth/user/:userId` - update user (roles, metadata)
- `DELETE /auth/user/:userId` - delete user

Or mesh methods - TBD based on docs design.

### 6. JWT Claims Follow RFC 8693

JWT claims use standard OAuth 2.0 Token Exchange terminology from [RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693):

```typescript
interface JwtClaims {
  sub: string;                    // Subject: whose permissions apply (the user)
  act?: { sub: string };          // Actor: who is making the call (optional: agent/system)
  isSuperAdmin?: boolean;
  isAdmin?: boolean;
  // ... other standard JWT claims (iss, aud, exp, iat, jti)
}
```

Guards and `onBeforeCall` hooks use these claims directly:

```typescript
// In @mesh guard
@mesh({ guard: (auth) => auth.sub === ownerId })

// In onBeforeCall
onBeforeCall: (auth) => {
  if (auth.act) {
    console.log(`Agent ${auth.act.sub} acting for user ${auth.sub}`);
  }
}
```

**Rejected alternatives:**
- Custom naming (`userId`, `impersonatedBy`) - requires translation layer between JWT and app code; anyone familiar with RFC 8693 has to re-learn
- Flattened actor (`act?: string`) - loses ability to represent delegation chains if needed later

## Implementation Deltas

Changes needed from current state:

### Types (`types.ts`)
- [ ] Update `JwtPayload` to include `act?: { sub: string }` per RFC 8693
- [ ] Add `isSuperAdmin`, `isAdmin`, `hasMeshAccess` to claims
- [ ] Update `User` interface with flags, authorizedActors, and metadata

### LumenizeAuth DO
- [ ] Add `isSuperAdmin`, `isAdmin`, `hasMeshAccess` to user record
- [ ] Add `authorizedActors` to user record for delegation
- [ ] Bootstrap check: if email matches `AUTH_SUPER_ADMIN_EMAIL`, set `isSuperAdmin: true` on first login
- [ ] Embed user flags in JWT claims at token creation
- [ ] Support `act` claim for delegation (agent acting for user)
- [ ] Add user management methods (list, get, update, delete)
- [ ] Add flag management (promote to admin, grant mesh access, demote)
- [ ] Add actor authorization methods (authorizeActor, revokeActor)
- [ ] Make extensible via subclassing

### createAuthRoutes
- [ ] Add user management routes
- [ ] Add admin-only guards to new routes
- [ ] Support custom routes from subclass

### Middleware
- [ ] Expose parsed claims including `sub` and `act` to guards
- [ ] Update `OriginAuth` type to use RFC 8693 structure

### testLoginWithMagicLink
- [ ] Accept optional `userData` for setting roles/metadata during test
- [ ] Accept optional `actAs` to simulate agent delegation
- [ ] Works with real auth flow (data goes in storage, flows to JWT)

### Documentation
- [x] Draft `website/docs/auth/index.mdx` (overview, login, bootstrap)
- [x] Draft `website/docs/auth/users-and-roles.mdx` (roles, user management)
- [x] Draft `website/docs/auth/extending.mdx` (subclassing)
- [x] Update `website/sidebars.ts` to include new pages
- [ ] Update `security.mdx` examples once claims work

## Prerequisites
- [x] Design documented in MDX (reads as final docs)
- [ ] API finalized with maintainer

## Implementation Phases

TBD after design is approved.

## Notes

This unblocks `security.mdx` testing:
- `@skip-check` at lines 127, 155 can become `@check-example`
- Guards checking `originAuth.claims.isAdmin` will be testable
- `requireRole()` pattern will be testable

---

## Follow-on: Mesh Access Control

**Status**: Not Started (blocked by this task)

### Problem

Currently, Lumenize Mesh has a security gap: anyone who can authenticate (has a valid email) automatically gains access to the mesh. Authentication ≠ authorization. The Worker routes all authenticated requests to `LumenizeClientGateway` without checking if the user is actually allowed to use the mesh.

### Solution

Add a `hasMeshAccess` claim to `@lumenize/auth` that gates access at the Worker level:

1. **New claim in LumenizeAuth**: `hasMeshAccess: boolean`
   - Admins and super-admins implicitly have mesh access
   - Regular users must be explicitly granted access
   - Bootstrap super-admin gets `hasMeshAccess: true` automatically

2. **Default middleware behavior**: `createAuthMiddleware` checks `hasMeshAccess` before allowing WebSocket upgrade or HTTP routing to mesh DOs
   - Configurable: `requireMeshAccess: true` (default) or `false` for open meshes

3. **User management**: Admins can grant/revoke mesh access via user management APIs

### Implementation Scope

#### @lumenize/auth changes
- [ ] Add `hasMeshAccess` to user record and JWT claims
- [ ] Bootstrap super-admin gets `hasMeshAccess: true`
- [ ] Admins/super-admins implicitly have mesh access (or explicit, TBD)
- [ ] User management APIs support granting/revoking mesh access

#### @lumenize/mesh changes
- [ ] Update default `onBeforeConnect` to check `hasMeshAccess`
- [ ] Update default `onBeforeRequest` to check `hasMeshAccess`
- [ ] Make behavior configurable for open vs gated meshes

#### Documentation updates
- [ ] `website/docs/mesh/security.mdx` - Major updates for access control
- [ ] `website/docs/mesh/getting-started.mdx` - Mention access control in setup
- [ ] `website/docs/auth/index.mdx` - Add `hasMeshAccess` to claims
- [ ] `website/docs/auth/users-and-roles.mdx` - Document mesh access management
- [ ] Audit all code examples across docs for `hasMeshAccess` where relevant

### Open Questions

1. **Naming**: `hasMeshAccess` vs `isMeshUser` vs `canAccessMesh`?
2. **Implicit vs explicit for admins**: Do admins automatically have mesh access, or must it be explicitly granted?
3. **Open mesh mode**: Should there be a config option to skip this check entirely for fully open meshes?
