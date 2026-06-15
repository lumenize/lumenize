# Nebula Branches

**Status**: Active — critical path for the demo
**Depends on**: `tasks/nebula-5.5-branch-migrations.md` (in-place lazy / copy-on-read migrations within a branch)
**Companion**: `tasks/nebula-studio.md` (each chat session pins to a non-main branch — `.dev` by default)

## Goal

Make branches a **first-class concept at the URL level**. A Star's main timeline lives at `/{universe}.{galaxy}.{star}/...`; any other branch lives at `/{universe}.{galaxy}.{star}.{branch}/...`. Each branch is an independent Star instance with its own SQLite, DAG tree, ontology version pointer, and subscriptions. Branches are uniformly handled by the platform — there is no separate "dev mode" code path. "Dev" is just the slug of a pre-created branch.

This is the foundation that lets Studio's iteration loop run safely (user-developer changes ontology mid-session without blowing away the running prototype) AND positions the platform for real branching post-demo (cross-branch data copy, "promote to main," etc.) without a back-end rearchitecture.

## URL and identity model

| Concept | Format | Example |
|---|---|---|
| Production URL | `/{u}.{g}.{s}/...` | `lumenize.com/acme.crm.tenant-a/resources/...` |
| Branch URL | `/{u}.{g}.{s}.{branch}/...` | `lumenize.com/acme.crm.tenant-a.dev/resources/...` |
| Auth scope (cookie path) | `{u}.{g}.{s}` (3-tuple, branch-agnostic) | one cookie per auth scope |
| JWT `aud` claim (active scope) | `{u}.{g}.{s}.{branch}` (4-tuple) | one JWT per active branch |

**Key invariants:**

- **`main` never appears in the URL.** A URL without a branch slug normalizes to `.main` at the entrypoint. This keeps end-user URLs short and gives us URL-level access gating (see below).
- **Auth scope stays 3-tuple; active scope is 4-tuple.** Auth scope is an identity-and-permission concern (which Star you're admin of); branch is a runtime-routing concern (which timeline you're acting on). Asymmetric by design.
- **Cookie at `/{u}.{g}.{s}/auth/refresh-token` (no branch).** One login per auth scope; refresh produces JWTs for any branch the user has rights to. Don't need per-branch logins.
- **URL-level admin gating.** Because `main` never appears in the URL, the entrypoint can require admin claims for *any* URL containing a 4th-level slug. End users of a user-developer-built product see only `/{u}.{g}.{s}/...` (main); the user-developer's Studio session sees `/{u}.{g}.{s}.dev/...` and only they can reach it. Permission and routing align cleanly without extra ACL plumbing.

## Storage model

Each branch is an **independent Star DO instance**, addressed by the 4-tuple. `{u}.{g}.{s}.main` and `{u}.{g}.{s}.dev` are two different DO instances with separate SQLite, separate DAG trees, separate subscribers. They share nothing at the storage layer.

For the demo: branches start empty (the `origin: null` case below). Cross-branch data copy is post-demo work that doesn't change this storage model — it just adds a one-time copy step at branch creation.

## Galaxy methods (day-one surface)

```typescript
// Galaxy gains these @mesh() methods:

createBranch(name: string, origin: string | null): void
// origin === null  → branch starts empty (the only mode for the demo)
// origin === <parent branch slug> → post-demo: copy code + data from origin into the new branch

listBranches(): string[]
// Returns the slugs of all branches that exist for this Galaxy's stars.
// Studio uses this to render "which branch are you on?" UI.
```

**Deferred for post-demo**: `updateBranch(name, newName)` (rename), `deleteBranch(name)` (destructive). Trivial to add later; not on the demo path.

**Default branch.** Galaxy carries a `defaultBranch` field, **hardcoded to `'main'` for the demo**. The override knob isn't built — but the field exists so the future capability is non-disruptive. Changing the default branch has subtle semantics (cookie scope? URL routing during the change? what about in-flight subscriptions?) we don't want to think about until we have a use case.

## Auto-creation on Star birth

Every Star, when it comes into existence, **automatically creates `.main` and `.dev` branches**. No explicit `createBranch` call is needed for these two — they're guaranteed to exist for any Star.

Why both? `.main` is the production timeline (always needed). `.dev` is what Studio's iteration loop binds to (always needed for any user-developer). Auto-creating both means Studio can assume `.dev` exists without first calling `createBranch`.

`createBranch` is for *additional* branches (post-demo).

## Slug constraints

Branch slugs follow the same rules as universe/galaxy/star slugs: URL-safe, no dots (since `.` is the 4-tuple separator). Validate on `createBranch`. Reserved slugs: `main` (used internally — auto-created on Star birth, never appears in URLs).

## NebulaClient impact

`NebulaClientConfig` becomes:

```typescript
{
  authScope: string;     // 3-tuple, e.g., 'acme.crm.tenant-a' — determines refresh cookie path
  activeScope: string;   // 4-tuple, e.g., 'acme.crm.tenant-a.dev' — baked into JWT aud
  // ...
}
```

For production access, `activeScope` is `${authScope}.main`. For Studio sessions, `activeScope` is `${authScope}.dev`. Switching branches mid-session means a refresh with a different `activeScope` — same mechanism that already exists for switching active scope today (Phase 1.8 / 1.96 work).

## NebulaDO impact

`NebulaDO.onBeforeCall` already binds `__nebula_universeGalaxyStarId` on first call. Becomes `__nebula_universeGalaxyStarBranchId` (or, for backward-compat parsing, the existing 3-tuple key normalizes to `.main`). The base class's job is unchanged — verify the active scope matches the DO instance — just done against a 4-tuple.

## Entrypoint impact

URL parsing splits the first segment on `.` — 3 parts means `branch = 'main'`; 4 parts means `branch = parts[3]`. The 4-tuple goes into `verifyNebulaAccessToken`'s scope check. If a 4th slug is present in the URL (i.e., the request is for a non-main branch), the entrypoint additionally requires admin claims before routing to the DO.

## What we're NOT doing for the demo

- **Cross-branch data copy** (`origin !== null` semantics). Branches start empty. Post-demo work; the API shape is in place from day one so adding this is implementation, not redesign.
- **`updateBranch` and `deleteBranch`** on Galaxy. Trivial additions when needed.
- **`defaultBranch` override.** Field exists, value is hardcoded.
- **Branches-of-branches.** No nesting; a branch's `origin` is always either `null` or the Galaxy's default branch (`main`). This is a forever simplification — the URL only ever has 4 segments.

## Open considerations to pin down during implementation

- **Star creation trigger.** Currently a Star comes into existence on first call. Does that first call create both `.main` and `.dev`? Or does Galaxy expose an explicit "register Star" method that does the auto-create? Probably the former — Star's first-call init writes its own `.main`/`.dev` registration to Galaxy in the same step that creates `__nebula_universeGalaxyStarBranchId`.
- **Subscription routing across branches.** A subscription is to a specific branch's Star instance. NebulaClient subscribes against the URL it's connected to (which has the branch). Verify the existing subscribe wiring (Phase 5.3) doesn't assume a single Star instance per `{u}.{g}.{s}`.
- **Auto-refresh signal** when the DWL bundle changes (Studio's `deploy_to_dev`). Pushed from the branch's Star to the connected Studio preview client. See `nebula-studio.md` § Editor / Preview.
- **NebulaAuth `aud` migration story.** Existing JWTs (none in production yet — we haven't shipped) would have 3-tuple `aud`; new ones are 4-tuple. Just adopt 4-tuple from day one; treat absent branch as a parsing convenience that maps to `.main` at the entrypoint.

## Notes

- This file used to be `tasks/dev-mode-branching.md` and described a single dev-mode Star as a special back-end concept. Renamed and rewritten 2026-05-07 after we realized branches as a first-class URL/identity feature is no harder to build than a dev-mode carve-out and gives us forward capability for free.
- The "hard part" of branching (cross-Star copy-on-write, prod→branch data migration) stays explicitly out of scope. The URL/identity model accommodates it; the storage model doesn't have to do anything new for the demo.
