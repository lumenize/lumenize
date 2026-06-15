# Nebula request-access workflow

**Status**: not started; referenced across the docs as the access-acquisition flow but unspecced. Stub created 2026-06-15 to home the "dead/dangling admin at climb termination" design note, split out of [nebula-star-root-admin.md](nebula-star-root-admin.md) Part 2 (last-admin protection).

## What it is (from the docs)

Every user except the founder starts with **zero** grants and acquires access via **request-access**: from a node they can't reach, climb the orgTree to the nearest ancestor carrying an `admin` grant and ask that admin to grant them. The whole tree — structure **and** the full permissions table (`sub → tier` per node) — is **universally visible** ([resources.md](../website/docs/nebula/resources.md)), specifically so the client can resolve *who to ask* locally with no server round-trip. The flow is driven by `'permission-denied'` transaction outcomes: a per-op `'permission-denied'` in `outcome.resources` tells the client to climb to the nearest admin and request access ([api-reference.md](../website/docs/nebula/api-reference.md), [nebula-frontend.md](nebula-frontend.md) § conflict-outcome). The grant itself is `dagTree.setPermission(node, requesterSub, tier)`, performed by an admin who holds `admin` at or above that node.

The **notify/request transport** — how the ask actually reaches the admin (in-app inbox, email, …) and how the admin approves/denies — is the unspecced part. To be designed.

## Design note — dead/dangling admin at climb termination

This is the right home for the last-admin **liveness** check (the in-DO grant-count invariant in nebula-star-root-admin Part 2 deliberately does *not* check liveness — see "Why not in the mutator" below).

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

**Relation to the consistency sweep.** A future cross-DO data-consistency sweep ([backlog.md](backlog.md) § Other Nebula backlog) is the broad janitor — reconcile *all* grants against live subjects, strip orphans, flag adminless Stars. This request-access filter is the targeted, user-facing handling at the one point the problem is observed. Either can land without the other; the filter is cheaper and higher-value first.
