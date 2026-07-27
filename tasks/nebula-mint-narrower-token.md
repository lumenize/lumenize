# Mint-narrower-token — rename `/delegated-token`, and make "narrower" true

**Status:** Small auth-side detour, ready to build. Design settled with Larry 2026-07-27; **`/review-task` Stage 1 deliberately skipped** — the framing was settled directly with the decision-maker in that conversation, so a framing panel would re-litigate a closed design. A **Stage-2 conformance pass** (security lens especially) is worth its cost and is the intended review.

**Objective — an endpoint whose name says what it does, and which cannot mint a token wider than the caller's own access.**

Two changes, one story: the **vocabulary** (`delegated` / `actFor` / "act as" are re-derived from scratch by the reviewer every time they come up — this is the 3rd–4th such conversation) and the **invariant** (the endpoint today can mint a token that is not narrower at all, but *sideways*, into a scope the caller has no authority over).

## Context and current state

`POST /auth/{callerScope}/delegated-token`, body `{ actFor, activeScope }`, handled by `handleDelegatedToken` ([worker-token.ts](../packages/nebula-auth/src/worker-token.ts)). Registered in the router's `AUTHENTICATED_SUFFIXES`.

**There is one branch.** A second — the target pre-authorizing an actor via an `AuthorizedActors` table — was cut in the surrogate-`sub` wipe; only two comments record it. Nothing to carry forward.

**Gates today, in order:** caller's token carries no `act` chain (no re-delegation) · `matchAccess(caller.authScopePattern, activeScope)` · `caller.access.admin === true` · `getIdentityScope(actFor)` resolves. ⚠️ **Nothing constrains *which* subject** — `getIdentityScope` resolves by `sub` across the entire registry.

**What it mints:** `sub` ← `actFor` (the target) · `profileId` ← **the target's** · `act.sub` ← the caller · `admin` ← the **caller's** bit · `authScopePattern` ← derived from the **requested** `activeScope`.

**Consumers:** none in production (`apps/nebula/src`, Studio UI). One test helper, `mintDelegatedToken`, which passes `actFor` = **the caller's own `sub`** to narrow a universe admin down to a galaxy scope — the one production path yielding a sub-universe admin, which is why the `access.admin` confinement work used it.

## Design intent, constraints, and future state

**The invariant the name asserts, and every criterion tests: a minted token is ≤ the caller's own access on every plane.**

| Plane | Whose | Narrower today? |
|---|---|---|
| Scope (`aud`, `authScopePattern`) | caller's, bounded by the `matchAccess` gate | ✅ |
| `admin` bit | caller's own | ✅ same |
| DAG grants (`resolvePermission(view, sub, …)` keys off `sub`) | the **target's** | ❌ **only if the caller administers the target's scope** |
| Profile (`profileId` claim) | the **target's** | ❌ **never** — see below |

Two planes violate it, and each has one fix:

- **DAG.** Add the missing gate: `hasAdminOverScope(caller.access, <the sub's own scope>)`. With it, the caller already holds the scope-admin bypass on that host, so the target's grants are a subset. Without it the token reaches *sideways* into a scope the caller has no authority over, and the name is a lie.
- **Profile.** The `profileId` claim is write access to that profile — `#requireOwnerOrAdmin`'s owner branch is `claims.profileId === <this profile>`, zero reads. After [identity-mint](nebula-auth-identity-mint.md) §4 a scope admin **cannot** write a member's profile; stamping the target's `profileId` hands it straight back, bounded by the new gate but still **wider than the caller's own access**. Stamp the **caller's** `profileId` instead — honest, since `act.sub` is already them.

**Why the capability is kept rather than deleted** (it has no consumer today, so YAGNI would otherwise apply): a real future use — **an admin debugging why a user cannot do something, using that user's narrower token** (`sub` = user, `act` = admin). The new gate is exactly that use case's boundary: an admin debugging a user in a scope they administer passes; reaching into another universe does not.

**Naming principle:** the request parameters are the **token fields the caller is asking for**. `sub` is the minted token's `sub`; `activeScope` is its `activeScope`/`aud` and the source of its derived pattern. `act.sub` is always the caller, taken from the Bearer token, so it is never a parameter and there is nothing to misname. ⚠️ Do **not** reintroduce `actFor`, "delegated", or "act as" in prose, symbols, or comments.

⚠️ **Design consideration — the attribution stamp, not a blocker.** Today `#buildChangedBy` drops `payload.profileId`, so the claim is read only by the Profile owner check and the caller's-`profileId` stamp is inert for attribution. When the collapse's Phase 2 lands the `{sub→profileId}` attribution map, a write made under a narrower token would pair the **target's** `sub` with the **caller's** `profileId`. Whoever builds that map should key it per-`sub` over the act chain (which is already its design) rather than assuming one claim describes the principal. Nothing to build here.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| Endpoint `/mint-narrower-token`, handler **`mintNarrowerToken`** | Keeping `/delegated-token` / `handleDelegatedToken`. The rename's mechanical cost is a one-time sweep; the confusing name costs reviewer re-derivation **every session it comes up**, which has now happened 3–4 times. Sibling handlers are `handleX`, but this one sits beside `mintAccessToken` in the same file and "handle" adds nothing — drop the prefix. |
| Body `{ sub, activeScope }` | `{ actFor, activeScope }` — `actFor` *is* the minted token's `sub` (`mintAccessToken({ sub: body.actFor, … })`), so naming it anything else forces the reader to hold a mapping. Parameters name the token fields they set. |
| **Add gate 5** — `hasAdminOverScope(caller.access, <the sub's own scope>)` | Leaving `actFor`/`sub` unbounded: any admin can mint for any identity in any universe. Also rejected: restricting `sub` to the caller's own (self-narrowing only) — it is simpler and matches today's *only* consumer, but forecloses the admin-debug use case above, which is the reason the capability exists. |
| `profileId` ← the **caller's** | The **target's** — a §4 bypass (see Design intent), and the one plane where the token would still be wider than the caller's own access. Also rejected: **omitting** `profileId` — it leaves writes under this token with no display stamp at all, a worse outcome than an honest one. |
| Keep the capability; do not delete the endpoint | Deleting it — the confinement tests need *some* production path to a sub-universe admin token, and the admin-debug use case is real if future. |

## Phases

1. **Rename + `sub` parameter (no behaviour change).** `/delegated-token` → `/mint-narrower-token`; `handleDelegatedToken` → `mintNarrowerToken`; body `actFor` → `sub`; test helper `mintDelegatedToken` → `mintNarrowerToken`. Sweep prose/comments for "delegated" and "act for" in this endpoint's sense.
   - **Call sites:** `router.ts`'s `AUTHENTICATED_SUFFIXES` · `worker-token.ts` (handler + its JSDoc + the file's route-map comment) · `access-claims.ts` comments · `nebula-do.ts`'s comment · `apps/nebula/test/test-helpers.ts` · `packages/nebula-auth/test/nebula-auth-delegation.test.ts` (filename too) · `.claude/rules/security.md` delegation rule 2. ⚠️ **Do NOT touch** `tasks/archive/nebula-confine-admin-bypass.md` (frozen) or `packages/auth` (separate package, own consumers).
   - **Success:** `grep -rn "delegated-token\|actFor\|handleDelegatedToken\|mintDelegatedToken" packages/nebula-auth apps/nebula .claude` returns only intentional history. ⚠️ A string grep is the right inventory *here* because the change **is** a rename — but it cannot see the concept expressed another way, so pair it with a read of `worker-token.ts`'s route-map comment and `security.md`'s delegation section.
   - **Success:** suites green with no behaviour change — this phase is pure rename.
2. **Gate 5 — the caller must administer the target's scope.** Add `hasAdminOverScope(caller.access, principal.universeGalaxyStarId)` after the identity resolves; 403 `forbidden` on failure.
   - **Success (capable of failing):** an admin of `{u}.{g}` minting for a `sub` in a **sibling** galaxy `{u}.{h}` → **403**. **Mutation:** delete the gate → the mint succeeds → reds.
   - **Success — the positive cases still work:** an admin minting for a `sub` in a scope they *do* administer → 200; a caller minting for **their own** `sub` → 200 (today's only consumer — it must not break).
   - **Success — regression:** the minted `authScopePattern` is still derived from the requested `activeScope` and still bounded by the caller's reach (the existing upper-bound gate is unchanged).
3. **`profileId` ← the caller's.** Replace `profileId: principal.profileId` with the caller's claim.
   - **Success (capable of failing):** mint for another `sub`; the returned token's `profileId` claim is the **caller's**, not the target's. **Mutation:** revert to `principal.profileId` → reds.
   - **Success — the §4 bypass is closed, asserted as an EFFECT:** holding a narrower token minted for a member, an admin **cannot** write that member's profile or read their `privateNotes`. ⚠️ This works independently of whether identity-mint §4 has landed — the token simply no longer carries the member's `profileId` — so it needs no cross-task gating.
   - ⚠️ `packages/nebula-auth/test/profile-id-claim.test.ts` asserts *"a delegated (act-for) token carries the TARGET identity profileId"* **as intended**. It encodes the behaviour being removed: rewrite it, don't work around it (`calibration.md` §3 — a green test can encode a bug as intended).
   - Note `profileId` is optional on the mint (`profileId?: string`), so a caller whose own token lacks the claim mints one without it. Acceptable; do not add a fallback to the target's.

## Non-goals

- **Deleting the endpoint** — see Decisions.
- **Building the admin-debug UI or flow.** This makes the capability safe; nothing consumes it yet.
- **`packages/auth`** — a separate package with its own consumers and its own `AuthorizedActors` branch. Removing that branch is its own backlog item.
- **Reviving the `AuthorizedActor` branch** — cut, staying cut.

## Relationships

- **Supersedes** [backlog.md](backlog.md) § Nebula Auth's `/delegated-token` row (D7's implementation home under the model file's D11). **Delete that row** when this lands — do not leave it as a duplicate.
- **Implements** [nebula-identity-data-model.md](nebula-identity-data-model.md) **D7**; repoint D7 at this file rather than at the backlog row.
- **Interacts with** [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md) §4: dropping the Profile's scoped-admin branch is what makes the target-`profileId` stamp a bypass. Independent to build, in either order.
- **Interacts with** [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) Phase 2's attribution stamp — see the ⚠️ design consideration. Nothing to build here.
- **`.claude/rules/security.md` delegation rule 2** is worded around "a delegated / act-for token mint" — its *invariant* is unchanged (never copy the target's `isAdmin` or pattern) but its vocabulary needs the rename, and gate 5 is a strengthening worth stating there.
- **Release gate inherited from the superseded backlog row:** must land **before F&F invites resume** — that is when a real admin population first exists, and until then the population is the founder plus the coach.
