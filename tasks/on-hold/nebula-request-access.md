# Nebula request-access workflow

**Status**: not started; referenced across the docs as the access-acquisition flow but unspecced. Stub created 2026-06-15 to home the dead-admin design note below. On 2026-09-16 it took two more pieces from the removed `nebula-dataplane-root-admin.md`, because [nebula-scope-moves-to-subdomain.md](../nebula-scope-moves-to-subdomain.md) deletes the Star's root-admin seed: the question of where a climb ends when root holds no admin grant, and the last-admin guard, whose reason depends on the answer.

## What it is (from the docs)

Every user starts with **zero** grants and acquires access via **request-access**: from a node they can't reach, climb the orgTree to the nearest ancestor carrying an `admin` grant and ask that admin to grant them. The whole tree — structure **and** the full permissions table (`sub → tier` per node) — is **universally visible** ([resources.md](../../website/docs/nebula/resources.md)), specifically so the client can resolve *who to ask* locally with no server round-trip. The flow is driven by `'permission-denied'` transaction outcomes: a per-op `'permission-denied'` in `outcome.resources` tells the client to climb to the nearest admin and request access ([api-reference.md](../../website/docs/nebula/api-reference.md), [nebula-frontend.md](../archive/nebula-frontend.md) § conflict-outcome). The grant itself is `dagTree.setPermission(node, requesterSub, tier)`, performed by an admin who holds `admin` at or above that node.

The **notify/request transport** — how the ask actually reaches the admin (in-app inbox, email, …) and how the admin approves/denies — is the unspecced part. To be designed.

## Open question — where a climb ends when root holds no admin grant

**The Star's root-admin seed made sure one existed, and it is being deleted.** `Star.onBeforeCall` wrote an `admin` grant on `ROOT_NODE_ID` for the first star-scoped admin to touch a Star. [nebula-scope-moves-to-subdomain.md](../nebula-scope-moves-to-subdomain.md) deletes it: once a session's `authScope` is its host, every `scopeAdmin` session on a Star host satisfies the seed's gate, and the grant buys no capability, since `requirePermission`'s bypass already admits a star-level admin. A founder then acts through the bypass alone, which is not in the permissions map, so a member climbing from a denied node finds nobody at root unless someone wrote a grant there.

Two candidates, neither chosen:

- **A scope admin the Registry knows about.** A climb that reaches root without finding a grant asks the Registry for the accepted `scopeAdmin` memberships that reach the Star. It costs a Registry read per such climb, which [ADR-018](../../docs/adr/018-singleton-is-the-scarce-resource.md) prices, and [ADR-008](../../docs/adr/008-full-org-tree-visibility.md) makes grantee identity visible to every member — whether that covers an admin who holds no grant is part of this question.
- **Explicit grants only.** A Star admin who wants to be asked writes a grant on root, and a climb that finds none says there is no one to ask. It needs no Registry read, and it asks admins to do something a founder never had to.

## Design note — dead/dangling admin at climb termination

This is the right home for the last-admin **liveness** check (the grant-count guard in § *Last-admin protection — re-derive before building* deliberately does *not* check liveness — see "Why not in the mutator" below).

**The problem.** Star DAG permission grants (`Permissions` rows: `sub → tier`) and the subjects those `sub`s name live in **different DOs with no foreign key** — grants are in each Star's DagTree; subjects are in `nebula-auth`, a lower-level package that must not depend on Nebula's permission model. So a grant can outlive its subject: if an admin's subject is deleted in nebula-auth, the grant row **dangles** — it still counts toward the last-root-admin invariant but points at a `sub` that can never authenticate, so the org can be effectively adminless while the invariant reads "held." Two ways it bites:

- **P1 — direct subject deletion** of a grant-holder (the *primary* path). It never goes through `revokePermission`, so the Star never learns of it.
- **P2 — revoking down to survivors who are already deleted.** This *does* go through `revokePermission`, but the in-memory grant-count guard can't see liveness, so it allows the revoke.

**Why NOT check liveness in `revokePermission` / `setPermission`** (considered + rejected 2026-06-15). Those are **synchronous** mutators, and a cross-DO liveness call to nebula-auth is `await` — which reopens the DO input gate and reintroduces the exact last-one-out race the synchronous design eliminates:

> revoke(A): read cache → sees admins {A, B} → `await auth.isLive(B)` → ✅ live → *(gate open — a concurrent revoke(B) runs to completion)* → DELETE A → **root is now adminless.**

It is also **TOCTOU** — liveness is non-monotonic across two DOs, so "B was live at the instant of revoke" is a snapshot, not an invariant (B can be deleted a millisecond later) — and it only covers **P2, not P1**. Note: Star → nebula-auth is the *correct* dependency direction (down), and the `NEBULA_AUTH` binding already exists in `apps/nebula/wrangler.jsonc`, so direction and wiring are **not** the blockers — the synchronous-mutator invariant is.

**Where it belongs instead — climb termination, here.** When the client (or server) resolves the nearest-admin set at the top of a request-access climb, it is **already doing async, user-facing work** (deciding whom to notify). That is the natural, non-racy place to filter for *live, reachable* admins:

1. Resolve the terminal admin `sub`s from the (universally visible) permissions table by climbing to the nearest ancestor with an `admin` grant.
2. Ask nebula-auth which of those `sub`s still exist (async, and this is `apps/nebula` → `nebula-auth`, the allowed direction).
3. Route the request only to **live** admins.
4. If **none** are live, surface "this org has no reachable admin — contact support" (and, for an operator, the recovery below).

This catches **both P1 and P2** at the moment the dangling grant actually causes harm, with zero disruption to the synchronous permission path.

**Recovery (independent of the above).** A Galaxy/Universe scope-admin can always re-seed a live root admin via `setPermission(ROOT, liveSub, 'admin')` through the `claims.access.admin` bypass — so an adminless org is never *permanently* bricked. The liveness filter is about **detecting and routing around** a dead-admin terminus gracefully, not about recovery.

**Relation to the consistency sweep.** A future cross-DO data-consistency sweep ([backlog.md](../backlog.md) § Other Nebula backlog) is the broad janitor — reconcile *all* grants against live subjects, strip orphans, flag adminless Stars. This request-access filter is the targeted, user-facing handling at the one point the problem is observed. Either can land without the other; the filter is cheaper and higher-value first.

## Last-admin protection — re-derive before building

Mined 2026-09-16 from the removed `nebula-dataplane-root-admin.md` Part 2, which a review on 2026-06-15 had marked ready to build. **Its reason was the seed:** the grant on root was the only admin the climb could find, so the guard kept root from losing its last one. With the seed deleted, root holds an admin grant only when someone writes one. So re-derive whether the guard earns its place once § *Open question* is answered: under "explicit grants only" it protects the grant the climb relies on, and under "a scope admin the Registry knows about" it protects nothing the climb needs.

The design, if it survives:

- **The invariant:** once `ROOT_NODE_ID` holds an in-tree `admin` grant, it keeps at least one. The guard stops dropping the last and never requires one to exist. It lives in `DagTree`, inside the shared `ResourceDataPlane`, so it covers every host, and the scope-admin bypass never counts toward it, so even a covering admin hands off add-before-remove.
- **`revokePermission(ROOT_NODE_ID, sub)`** rejects when `sub` holds the last root `admin` grant, and revoking a grant that does not exist stays a no-op. The check runs after `requirePermission(ROOT_NODE_ID, 'admin')` and just before `transactionSync`, so a non-admin caller gets `PermissionDeniedError` rather than an error that discloses the invariant's state.
- **`setPermission(ROOT_NODE_ID, sub, level)`** rejects demoting the last admin: `sub` holds `admin` on root, `level` is not `'admin'`, and no other root admin exists. It short-circuits on a non-root node or on `level === 'admin'`.
- **A typed error, `LastRootAdminError`,** in `apps/nebula/src/errors.ts`, on `OntologyStaleError`'s template: `name` plus a discriminating own prop, `nodeId`. `isLastRootAdminError` checks both and never uses `instanceof`, which does not survive a mesh hop. The message carries the fix — add another admin before removing this one — and the client detects it where `nebula-client.ts` already consumes `isOntologyStaleError`.
- **The count reads the cached permissions view before `transactionSync`.** That is sound only because the mutators are synchronous and the Star is single-threaded, so no grant change interleaves; ADR-005's non-monotonic concern does not apply, and a concurrency-race test would be vacuous.
- **It counts grants, not live subjects.** A deleted subject's grant still counts, which § *Design note — dead/dangling admin at climb termination* handles at the climb.
- **Tests, one Star each:** a single root admin can neither revoke nor self-demote; re-asserting `admin` passes; with two root admins, demoting one succeeds; add-before-remove succeeds and then refuses the survivor's removal; the error's `name` and own prop survive the Star-to-client hop; a non-root node may go adminless. `deleteNode(ROOT_NODE_ID)` is already refused, so it needs no guard.

## Future enhancement — AI-initiated elevation (further out, on-hold-flavored)

A natural extension once the base flow exists: make the **built product's AI** an initiator of request-access, not just the human. When the in-app assistant determines an answer would be *materially* better with data the asking user can't currently reach, it surfaces that — "I could answer this more completely if you had access to X" — and offers to fire the same governed climb-to-nearest-admin grant request on the user's behalf. Nothing is auto-granted: the grant still goes through a live admin up the org tree; the AI only *initiates* the ask. This is the product embodiment of the strategy's "least-privilege without the quality tax" / "choose 3" claim ([docs/vision/strategy.md](../../docs/vision/strategy.md), and the iron-triangle write-up in `docs/presentation-and-blog-drafts/`). Strictly post-demo; depends on the base notify/approve transport above being designed first.
