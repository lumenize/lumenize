# Star founder provisioning — self-signup without an open claim

**Status:** 🚧 **DRAFT — NOT reviewed.** Captures a pivot decided with Larry 2026-07-21 during `/build-task` on [nebula-confine-admin-bypass.md](nebula-confine-admin-bypass.md). **Do not `/build-task` this file** — it needs `/review-task` first, and it rests on one unverified premise (below). Written now so the decision isn't lost in a transcript.

**Objective:** a Star gets a real **founder** — an identity minted at the star with `isAdmin: true` and an **exact-star** `authScopePattern` — as part of tenant signup, **without** introducing an open, stranger-reachable star claim.

## Why not an open `claimStar`

The registry records the deferral ([nebula-auth-registry.ts:336-341](../packages/nebula-auth/src/nebula-auth-registry.ts)):

> *"there is deliberately NO open, founder-minting `claimStar` … An open Turnstile-only star claim that minted an `isAdmin=true` founder **inside another user-developer's Universe** was a stranger-claims-a-child escalation"*

⚠️ **This is an authorization hole, not a timing hole** — the distinction matters because timing fixes don't address it. `claim-universe` can be open because a universe slug is the **root of a fresh tree**; claiming `acme` touches nobody. A star id `{u}.{g}.{s}` sits **inside** `{u}.{g}`, which already belongs to someone.

**And the slug is sufficient to exploit it** — universe/galaxy slugs are not secret (they appear in URLs; the claim path's own comment notes "slug is not secret"). So an open claim keyed on a public slug has *no* authorization component whatsoever. Any design that fixes this must add a capability the stranger cannot guess.

## The reframe — the authorization already exists

Nebula's own model never had a stranger POSTing to an open endpoint. From [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md):

> *"a new tenant self-signs-up **via the Galaxy** (create account → pick Star name + slug → **Galaxy provisions the Star**), and the founder must come out of that flow holding `admin` on root"*

The **app** — the Galaxy, which already owns `{u}.{g}` — provisions `{u}.{g}.{s}`. That path exists and is already admin-gated: **`createStar`**, in-session. The deferral NOTE says so itself: *"which is exactly `createStar` (admin, in-session, no founder)."*

**So the gap is three words: `no founder`.** `createStar` creates the `Scopes` row and stops. Authorization is *inherited from the Galaxy's existing authority* — which is the correct place for it. "May anyone sign up for a Star in my app?" becomes a policy the **app developer** owns, not a platform security gap.

## ✅ Premise VERIFIED from source (2026-07-21)
The design rests on `createStar` being admin-gated in-method. **Confirmed by reading the body**, not a summary — [nebula-auth-registry.ts:375-395](../packages/nebula-auth/src/nebula-auth-registry.ts):

```ts
const parentGalaxy = `${parsed.universe}.${parsed.galaxy}`;
if (!this.#hasAdminOverGalaxy(callerAccess, parentGalaxy)) {
  throw new RegistryError(403, 'forbidden', `Caller is not an admin of the parent galaxy "${parentGalaxy}"`);
}
```

Gated **over the parent galaxy**, in-method, before any write; it also validates tier, parent existence, and slug availability, and returns `{ instanceName }` for a signup flow to build on. Its own JSDoc states the gap in the same words this task does: *"`Scopes` row only, **NO founder** + NO email."* (`#hasAdminOverGalaxy` now delegates to the shared `hasAdminOverScope` exported by [nebula-confine-admin-bypass.md](nebula-confine-admin-bypass.md) Phase 1.)

⇒ **Phase 1 below shrinks from "verify + harden" to "confirm the gate is unchanged and move on."** The authorization genuinely already exists; the whole task is minting the founder and pre-stamping the DAG grant.

## Two layers, two different problems
Conflating them is how the "is it a timing hole?" confusion arose. Both are real:

| | Layer | Nature | Fix |
|---|---|---|---|
| Who may create a Star under someone's Galaxy | auth | **authorization** | inherit the Galaxy's authority (`createStar`) + a single-use claim token |
| Who becomes root admin of a newly provisioned Star | DAG | **timing** (first-caller-wins) | pre-stamp from the signup flow |

The second is live today: `Star.onBeforeCall` seeds the DAG root admin for *"the first `access.admin` caller who touches this Star"* ([star.ts](../apps/nebula/src/star.ts)), with a race test (`first-run-create-race.test.ts`). The on-hold dataplane task already carries the intended fix as `TODO(self-signup)`: *"the founder's identity should come from the signup flow, not 'first scope-admin to connect'"*. **This task closes that TODO.**

## Design sketch (to be pinned in review)
1. **Mint a founder in the star-provisioning path** — `#mintIdentity(email, starId, isAdmin: true)`. Pattern is `buildAuthScopePattern(starId)` = **the exact star id** ([parse-id.ts:117](../packages/nebula-auth/src/parse-id.ts)), so a star founder is *not* a universe admin. That property is the point.
2. **Single-use claim token** — reuse `InviteTokens` verbatim (hashed, single-use, emailed link). Larry's "pre-stamp with a temporary token only used until claimed" **is** this mechanism; it already exists, so this should be composition, not new machinery.
3. **Pre-stamp the DAG root admin** from the provisioning flow instead of first-touch, retiring `Star.onBeforeCall`'s seed latch.

## Decisions
| Decision | Rejected alternative — why |
|---|---|
| Extend the **existing admin-gated** star-provisioning path | An open `claimStar` with the hole "captured and lived with" — the hole has no authorization component at all (public slug), so it is not a bounded risk; and inheriting the Galaxy's authority is *less* work, not more. |
| The founder's pattern is the **exact star id** | A `{u}.*` pattern — that is a universe admin wearing a star's name, and is exactly what this whole line of work exists to prevent. |
| Reuse `InviteTokens` for the claim token | A bespoke star-claim token — same shape (opaque, hashed, single-use, redeem-once), ADR-010-conformant, already built and tested. |
| Pre-stamp the DAG root admin | Keeping first-touch — it is a documented race with its own test, and the signup flow *knows* the founder, so first-touch is strictly worse information. |

## Phases
*(sketch only — `/review-task` must pin these with capable-of-failing criteria)*
1. ✅ **Gate already verified** (see above) — confirm it is unchanged, add no new authorization.
2. Mint the founder identity + issue the claim token in the provisioning path.
3. Pre-stamp the DAG root admin from that flow; retire the first-touch seed and its latch.
4. Re-ground the ~30 baseline fixtures onto real star founders (see Relationships).

## Relationships
- 🚧 **GATED BY [nebula-confine-admin-bypass.md](nebula-confine-admin-bypass.md) — all phases.** A star founder holds an exact-star pattern; before that task's confinement, such a principal is admitted to its **Galaxy and Universe** by `enforceScopeReach`'s tenant branch and then treated as admin there (§A). **Landing star founders first would ship that escalation to every self-signup tenant.** This is a hard ordering, not a preference.
- **Supersedes part of [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) Part 1** — its `TODO(self-signup)` is this task's Phase 3. Its Part 2 (last-admin protection) is unaffected.
- **Overlaps [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md)** — that task mints star-tier admins by *invite* (admin-authorized). Same principal shape, different provenance. Neither blocks the other; if identity-mint lands first, the fixture re-grounding can start there.
- **Releases the fixture re-grounding.** [nebula-confine-admin-bypass.md](nebula-confine-admin-bypass.md) Phase 0 left ~30 baseline fixtures asking for "an admin at this star" and receiving a **universe admin** — the only thing mintable today. That is the interim this task retires. ⚠️ Do the **intent-split** (`adminClientAt(scope)` vs `universeAdminClient(universe, activeScope)`) in the confine task *before* this lands, so re-grounding is one helper body rather than ~30 call sites.
