# Nebula Branches (True URL-Level Branching)

**Status**: On-hold — deferred post-demo. The demo's dev-sandbox need is met by a reserved Star slug instead (`tasks/dev-star.md`); this file is the general branching capability, parked until there's a product reason to build it.

**Companion**: `tasks/dev-star.md` (the demo-critical dev sandbox — a reserved Star slug, **not** a branch).

## Why this is deferred (and why the dev Star is not a branch)

This file originally made branches first-class to give Studio an isolated dev timeline. That conflated two concerns: Studio needs **a sandbox**, and the platform **might** want **general branching**. The sandbox is met for free by a reserved Star slug (`{u}.{g}.dev`) flowing through every existing Star mechanism — see `tasks/dev-star.md`. True branching (multiple independent timelines per Star, cross-branch copy-on-write, promote-to-main) is a separate, more general capability with real design cost (4-tuple routing, auth/active-scope asymmetry, `defaultBranch` semantics) and **no demo consumer**. So it's parked here.

Notably, the most-requested branching-adjacent feature — "fork a production Star into a sandbox to test a migration" — does **not** need this design either: clone the prod Star DO into a dev Star via Cloudflare's forthcoming DO-duplication primitive (copies SQLite *including* permission grants), then test there. See `tasks/dev-star.md` § *What we're NOT doing*. That further lowers the urgency of true branching.

**Un-defer when** "branch this Star," "promote dev to main," or cross-branch data movement becomes part of the product story. The reserved-slug dev Star and this 4-tuple model can coexist — adding a 4th URL segment later is an orthogonal entrypoint/routing change that doesn't conflict with the dev Star.

---

*The remainder is the original design, preserved as the post-demo spec.*

## Goal

Make branches a **first-class concept at the URL level**. A Star's main timeline lives at `/{universe}.{galaxy}.{star}/...`; any other branch lives at `/{universe}.{galaxy}.{star}.{branch}/...`. Each branch is an independent Star instance with its own SQLite, DAG tree, ontology version pointer, and subscriptions. Branches are uniformly handled by the platform — there is no separate "dev mode" code path.

## URL and identity model

| Concept | Format | Example |
|---|---|---|
| Production URL | `/{u}.{g}.{s}/...` | `lumenize.com/acme.crm.tenant-a/resources/...` |
| Branch URL | `/{u}.{g}.{s}.{branch}/...` | `lumenize.com/acme.crm.tenant-a.feature-x/resources/...` |
| Auth scope (cookie path) | `{u}.{g}.{s}` (3-tuple, branch-agnostic) | one cookie per auth scope |
| JWT `aud` claim (active scope) | `{u}.{g}.{s}.{branch}` (4-tuple) | one JWT per active branch |

**Key invariants:**

- **`main` never appears in the URL.** A URL without a branch slug normalizes to `.main` at the entrypoint. This keeps end-user URLs short and gives URL-level access gating (below).
- **Auth scope stays 3-tuple; active scope is 4-tuple.** Auth scope is an identity-and-permission concern (which Star you're admin of); branch is a runtime-routing concern (which timeline you're acting on). Asymmetric by design.
- **Cookie at `/{u}.{g}.{s}/auth/refresh-token` (no branch).** One login per auth scope; refresh produces JWTs for any branch the user has rights to.
- **URL-level admin gating.** Because `main` never appears in the URL, the entrypoint can require admin claims for *any* URL containing a 4th-level slug. Permission and routing align without extra ACL plumbing.

## Storage model

Each branch is an **independent Star DO instance**, addressed by the 4-tuple. `{u}.{g}.{s}.main` and `{u}.{g}.{s}.feature-x` are two different DO instances with separate SQLite, DAG trees, subscribers. They share nothing at the storage layer. Cross-branch data copy adds a one-time copy step at branch creation; it does not change this storage model.

## Galaxy methods

```typescript
createBranch(name: string, origin: string | null): void
// origin === null  → branch starts empty
// origin === <parent branch slug> → copy code + data from origin into the new branch

listBranches(): string[]
// Returns the slugs of all branches that exist for this Galaxy's stars.

updateBranch(name: string, newName: string): void  // rename
deleteBranch(name: string): void                    // destructive
```

**Default branch.** Galaxy carries a `defaultBranch` field. Changing the default branch has subtle semantics (cookie scope? URL routing during the change? in-flight subscriptions?) that need design before it's exposed.

## Slug constraints

Branch slugs follow the same rules as universe/galaxy/star slugs: URL-safe, no dots (since `.` is the 4-tuple separator). Validate on `createBranch`. Reserved slug: `main` (used internally — never appears in URLs).

## NebulaClient impact

`NebulaClientConfig` gains a 4-tuple `activeScope` (baked into the JWT `aud`) alongside the 3-tuple `authScope` (refresh cookie path). Switching branches mid-session is a refresh with a different `activeScope`.

## NebulaDO impact

`NebulaDO.onBeforeCall` binds the 4-tuple `__nebula_universeGalaxyStarBranchId` (the existing 3-tuple key normalizes to `.main` for backward-compat parsing). The base class's job is unchanged — verify the active scope matches the DO instance — just done against a 4-tuple.

## Entrypoint impact

URL parsing splits the first segment on `.` — 3 parts means `branch = 'main'`; 4 parts means `branch = parts[3]`. The 4-tuple goes into `verifyNebulaAccessToken`'s scope check. If a 4th slug is present, the entrypoint additionally requires admin claims before routing to the DO.

## Open considerations

- **Subscription routing across branches.** A subscription is to a specific branch's Star instance. Verify subscribe wiring (Phase 5.3) doesn't assume a single Star instance per `{u}.{g}.{s}`.
- **Branches-of-branches.** No nesting; a branch's `origin` is always `null` or the default branch (`main`). The URL only ever has 4 segments.
- **`aud` migration.** New JWTs are 4-tuple; absent branch maps to `.main` at the entrypoint.

## Notes

- This file used to be `tasks/dev-mode-branching.md` (a single dev-mode Star as a special back-end concept). Renamed and rewritten 2026-05-07 to make branches a first-class URL/identity feature.
- Split 2026-06-15: the demo-critical dev-sandbox need was extracted to `tasks/dev-star.md` (a reserved Star slug, not a branch) and this file moved to `on-hold/` as the deferred general-branching capability. The in-dev data-lifecycle behavior (additive preserved / breaking resets) lives with the dev Star now.
- The "hard part" of branching (cross-Star copy-on-write, prod→branch data migration) was always out of scope for the demo; the reserved-slug dev Star sidesteps it entirely.
