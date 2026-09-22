# The Profile composes the Resources plane, with an authorizer that is not a grant

**Status:** Pass 1 — design intent only, phases NOT written. **Split out of
[nebula-data-plane-owns-its-guards.md](../nebula-data-plane-owns-its-guards.md) on 2026-09-22**
(Larry), which had absorbed it on 2026-09-08. That file establishes the guard model; this one is a
CONSEQUENCE of it — the first host whose guard is not a DAG grant — and consequences belong after
the thing they follow from. Same relationship [nebula-upgrade-universe-with-a-data-plane.md](../nebula-upgrade-universe-with-a-data-plane.md)
already has: compose the finished plane onto another host.

**Follows the guard-model task and inherits its finished contract** — the two accessors
(`@mesh() resources()` and the decorator-less `resourcesResults()`), the narrow facades each
returns, and the allocation of every plane method to a surface. Do not re-derive any of it here.

⚠️ **The injected authorizer is THIS file's, not the parent's.** The plane takes a DAG-backed
authorizer for the Galaxy and the Star and behaves as it does today; only this host needs a second
kind, so the constructor argument that introduces it lands here. That keeps the parent's plane at
six constructor arguments, which is what the Universe sibling states it inherits.

**Today, on disk:** `packages/nebula-auth/src/profile.ts` — `class Profile extends
ComposedMeshDO(DurableObject, 'Profile')`, storing a bespoke `ProfileFields (field, value)` k-v
table, composing no plane and holding no `DagTree`. The access-control half already shipped
(`tasks/archive/nebula-profile-access-control.md`); what remains is the storage.

⚠️ **The one claim inherited from the absorbed text that did NOT survive review — do not restore
it.** That text said this work *"**Closes** the pluggable access-control model row … which named the
Profile as its first site."* [backlog.md](../backlog.md) § *Future bigger things* says otherwise: the
row is headed **OPEN QUESTION**, is deliberately undecided with no adoption trigger recorded on
purpose, names two live sites, and never calls the Profile a first site. Whatever this task closes,
it owes an edit to that row rather than a claim here (`workflow.md` § *Referring to things across files*).

## Design intent, constraints, and future state

**Moved here 2026-09-08** from [nebula-profile-access-control.md](../archive/nebula-profile-access-control.md), whose Stage 1 found that composing the plane onto the Profile is a change to the plane's guard model, which is this file's subject. That file kept the mint refusal and the owner branch and **shipped the same day**; this one takes the Profile's storage. So the guard it composes onto is already the end shape — the owner branch is a plain `profileId` equality, and an impersonation token reaches it.

**Why the Profile cannot use a grant.** Its authorization is owner-or-admin: the owner is whoever's `profileId` is on the token, and an admin is anyone holding dominion over a scope where the person has an accepted membership, resolved live through the Registry ([ADR-012](../../docs/adr/012-global-profile-visibility.md)). A DAG grant keys on `sub`, and one profile spans every `sub` its person holds, a set that grows with each accepted membership. A per-`sub` grant inside the Profile would therefore be a stored authorization scope-set, which [ADR-013](../../docs/adr/013-identity-profileid-resolution.md) calls a security bug. So the plane's guards cannot be the DAG here, and this is where the contract above gains its missing clause.

**The clause: the plane asks an injected authorizer, and every guard site asks the same one.** Today `Resources.read`, `Resources.transaction`, the fan-out filter in `#broadcast` and `invite` each reach `DagTree` directly; `Subscriptions.subscribe` and `ensureResource` inherit their check from `Resources.read` / `Resources.transaction` and hold none of their own — `ensureResource`'s JSDoc states that absence as the method's point, and it is what keeps the reserved profile's self-seed safe under the injected authorizer without a site of its own. After this task the plane takes an authorizer at construction: Galaxy and Star pass the DAG-backed one and behave as today; the Profile passes owner-or-admin and constructs no `DagTree` at all, which keeps `auth.md` § *Profiles*' *no orgTree inside a Profile* true. No per-call flag exists to forget. The earlier draft's shape — four host-side `@mesh` wrappers and a write-side flag — reached none of read, subscribe or the fan-out, and would have delivered profile pushes to platform admins alone.

**Facts settled for the move, so nobody re-derives them:**

- **Two types, `Profile` and `ProfilePrivate`.** The public read is an allow-list by type. `ProfilePrivate` is never subscribable: a private field never rides a pushed snapshot (ADR-012).
- **Two fixed-id singleton resources per Profile DO**, created by `ensureResource` on first touch. The reserved Nebula profile's self-seed takes the same shape, with `agent:nebula` as the server-composed actor, as the Galaxy's agent-message commit already does — the surviving `ensureResource` caller now that `ensureChat` is gone.
- **The accept-time display-name write becomes a plane write.** `handleAcceptMembership` calls `setDisplayNames` over raw RPC with no mesh call context; under the plane it supplies the accepting person as the server-composed actor.
- **The client keeps its dedicated profile channel.** `subscribeProfile`, `unsubscribeProfile`, `handleProfileUpdate` and `store.lmz.profiles` stay, because `store.resources.<type>` routes on the user-developer's own type name and `Profile` is a legal one ([nebula-subscriber-lists.md](../archive/nebula-subscriber-lists.md) § *Decisions*). They re-target the plane's methods through the gate; `updateMyProfile` becomes a `transaction` on the two known ids.
- **Fan-out is a direct per-target `lmz.call` from the Profile DO**, because the Gateway lets a push cross scopes only when `metadata.caller.bindingName` is `PROFILE` and a tier hop restamps the caller. That is what makes the direct call correct; the flat-loop pin in `NebulaDO.broadcast` is labelled `TEMP` and is not the reason.
- **Ontology supply is a second generated, precompiled seed row** from `scripts/gen-validator-seeds.ts`, platform-constant, never compiled at runtime.
- **A profile write is not an ADR-016 event.** It destroys nothing, moves no authority and establishes no session, so the plane's per-snapshot `actingToken` is the whole record owed and no separate projection is.
- **The plane moves up to the Profile, never down into a package.** By the layer map the Profile is platform business logic rather than registry infrastructure, so relocating `Profile` is the smaller change; `mesh.md`'s dependency direction forbids the other one.
- **To decide here:** the base class — `LumenizeDO`, which brings `onStart` and conforms to the layer map, or the raw composer it is today; `NebulaDO` is not a candidate, because its `onBeforeCall` requires passage and a Profile is reached laterally by design, so the guard would refuse the callers ADR-012 exists to admit. Also where the plane is constructed, and where the scoped-admin branch's raw Registry RPC goes once `Profile` lives in `apps/nebula` — `mesh.md` routes that hop through `NebulaAuthFacade`.
- ⚠️ **Design consideration:** `ProfilePrivate` is one resource per person here, and ADR-012's deferred structural answer — private fields keyed by scope — stays neither taken nor foreclosed. Keep the type able to become one resource per scope.
- **Tests:** `profile-do.test.ts` inserts into `ProfileFields` and is rewritten against the plane; `profile-subscribe.test.ts` asserts on `Subscribers` and `#fanout` and is rewritten too; `profile-channel-collision.test.ts` is client-side and carries over. The rewrite retires rung 3 in these Profile files only; the rest of that lane, its decided mixed target and its two prerequisites stay with the row in [backlog.md](../backlog.md) § *Immediate work backlog*.
