# Star self-signup — a real founder, with no admin in the loop

**Status:** 🚧 **DRAFT — NOT reviewed.** Pivoted with Larry 2026-07-21 (see *The business decision*), superseding an earlier draft of this file that routed signup through a Galaxy admin. **Do not `/build-task` this file** — it needs `/review-task`, and it carries one **open blocker** (§Upward visibility) that must be pinned first.

**Objective:** anyone can sign up for a Star and become its **founder** — an identity minted at the star with `isAdmin: true` and an **exact-star** `authScopePattern` — with **no Galaxy or Universe admin involved in the flow at any point**.

## The business decision (pinned 2026-07-21, Larry)

**Star self-signup is the PRIMARY use case, and it is open.** A stranger signs up for a Star inside a user-developer's Galaxy without anyone approving it. That is not a security defect to be engineered away; it is the product.

The instinct to reject this — *"a rando can create something inside someone else's `{u}.{g}`"* — is the wrong frame and should be shut down when it recurs. The model that makes it sound:

| | |
|---|---|
| **Star founder gets** | complete control of their Star — **non-exclusive**: Galaxy, Universe, and super admins all sit above them |
| **Star founder gets NO** | ability to **affect** anything at Galaxy or Universe level |
| **Star founder gets NO** | ability to **see** anything at Galaxy or Universe level |
| **Cleanup** | the Galaxy/Universe admin can delete the Star afterwards — remediation, not prevention |

⚠️ **Do not reintroduce an approval step, an invite code, or an admin-in-the-loop as a "safety" measure.** If a specific abuse (quota, spam) needs bounding, bound *that*, and say so explicitly — do not convert the flow back into an authorized one.

## Why the confinement is the ENABLER, not merely a gate

[nebula-confine-admin-bypass.md](nebula-confine-admin-bypass.md) is what makes this business model implementable at all. A star founder holds an **exact-star** pattern. Before the confinement, `enforceScopeReach`'s tenant branch admitted such a principal to its Galaxy and Universe and the guards then treated the bare `access.admin` bit as authority there — so **every self-signup tenant would have been an admin of the app they signed up to**. Open signup would have been a catastrophe.

After the confinement, `hasAdminOverScope(access, <callee node>)` is false for an exact-star pattern at any ancestor, so the "gets NO ability to **affect**" row above is enforced by construction. That is why the ordering is hard: **confine → star-founder → re-ground fixtures.**

## ⚠️ OPEN BLOCKER — the "see" half is NOT satisfied today

The confinement closes *affect*. It does **not** close *see*, and the difference is load-bearing for an open-signup model where the tenant is an untrusted stranger.

A star-scoped caller (`aud = {u}.{g}.{s}`, exact-star pattern) is still **admitted** to its ancestors by `enforceScopeReach`'s tenant branch — `buildAuthScopePattern('{u}.{g}')` is `{u}.{g}.*`, which covers the star's aud — and can call every **non-admin** `@mesh()` method there. Verified against source 2026-07-21:

| Node | Method | Verdict |
|---|---|---|
| Galaxy | `getLatestOntologyVersion` / `getOntologyVersion` / `listOntologyVersions` | **legitimate** — the Star needs its app's schema; the Star already fetches the Galaxy-cached ontology row |
| Galaxy | `getGalaxyConfig` | **leak?** — the app developer's config, readable by every tenant |
| Universe | `getUniverseConfig` | **leak?** — the universe owner's config, readable by every tenant |

**So the fix is NOT "close the tenant branch"** — that would break the ontology path the Star depends on. The decision to pin is *which* upward reads are part of the contract and which are not. Candidate shapes (for review):
- Split the Galaxy surface: an explicit **tenant-facing** read set (ontology) vs. an **owner-facing** set (config), gated separately — the honest fix, and it generalizes.
- Or: keep the tenant branch for descendants but require an explicit per-method opt-in (`@mesh({ tenantReadable: true })`), making the surface allow-list-shaped rather than deny-list-shaped.

⚠️ **This revisits a warning in the gating task.** [nebula-confine-admin-bypass.md](nebula-confine-admin-bypass.md) says *"Do NOT fix this by tightening `enforceScopeReach`'s tenant branch — narrowing it would change non-admin reach as a side effect."* That warning was written when upward non-admin reach was assumed benign. **Open self-signup changes that assumption** — the descendant is now an untrusted stranger. The warning still holds for *this* task's scope (don't fix an authority bug by breaking admission), but the underlying question is genuinely reopened, and reopening it is in scope **here**.

## Why there is no `claimStar`-shaped hole to worry about

The registry's existing deferral note ([nebula-auth-registry.ts:336-341](../packages/nebula-auth/src/nebula-auth-registry.ts)) rejects an open star claim as *"a stranger-claims-a-child escalation."* **That reasoning was correct at the time and is now obsolete** — the escalation it names is precisely the one the confinement removed. Update or delete that note as part of this task; leaving it is an unlearning tax on every future reader.

What made it an escalation was never "a stranger created a row." It was that the minted founder became an admin of the *parent*. With the confinement, an exact-star founder is inert above its own Star, so the create is just a create.

## Two layers, two different problems
| | Layer | Nature | Fix |
|---|---|---|---|
| Who may create a Star | auth | **open by decision** — no authorization component, deliberately | mint the founder in an open signup path |
| Who becomes root admin of a new Star | DAG | **timing** (first-caller-wins) | pre-stamp from the signup flow |

The second is live today: `Star.onBeforeCall` seeds the DAG root admin for *"the first `access.admin` caller who touches this Star"* ([star.ts](../apps/nebula/src/star.ts)), with a race test (`first-run-create-race.test.ts`). This task closes the `TODO(self-signup)` that [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) has carried since 2026-06-14 — and **supersedes** that file's Part 1 lift rather than merely relocating the seed.

## Design sketch (to be pinned in review)
1. **An open signup endpoint** that mints the founder: `#mintIdentity(email, starId, isAdmin: true)`. Pattern is `buildAuthScopePattern(starId)` = **the exact star id** ([parse-id.ts:117](../packages/nebula-auth/src/parse-id.ts)) — *not* `{u}.*`. That property is the whole point.
   ⚠️ **The founder is the SIGNING-UP USER**, never a Galaxy admin acting on their behalf. The `email` above is the stranger's.
2. **Single-use claim token** — reuse `InviteTokens` verbatim (opaque, hashed, single-use, emailed link). Larry's "pre-stamp with a temporary token only used until claimed" **is** this mechanism; it already exists, so this is composition, not new machinery. It proves email ownership; it is **not** an authorization step.
3. **Pre-stamp the DAG root admin** from the signup flow instead of first-touch, retiring the `__nebula_rootAdminSeeded` latch.
4. **Resolve §Upward visibility** — the open blocker.

## Decisions
| Decision | Rejected alternative — why |
|---|---|
| **Open self-signup, no admin in the loop** | Routing through `createStar` under the Galaxy admin's authority (this file's own previous draft) — it contradicts the business model. Self-signup is the product; an approval step is not a "safer version" of it, it is a different product. |
| The founder's pattern is the **exact star id** | A `{u}.*` pattern — a universe admin wearing a star's name, and exactly what the gating task exists to prevent. This is also what makes open signup safe. |
| The founder is the **signing-up user** | The Galaxy admin as founder — then it is not self-signup, and the new tenant cannot administer their own Star. |
| Abuse is bounded by **remediation**, not prevention | An approval gate — see the business decision. If quota/spam needs bounding, bound *that* explicitly (rate limit, per-Galaxy cap) and keep the flow open. |
| Reuse `InviteTokens` for the claim token | A bespoke star-claim token — same shape, ADR-010-conformant, already built and tested. |
| Pre-stamp the DAG root admin | Keeping first-touch — a documented race with its own test, and the signup flow *knows* the founder, so first-touch is strictly worse information. |

## Open questions for `/review-task`
1. **§Upward visibility** — which Galaxy/Universe reads are tenant-facing? (blocker)
2. **Does the Galaxy get a say at all?** The business decision says no *approval*, but an app developer plausibly wants signup **disabled** for a private app. Is that a Galaxy config flag (still no per-signup admin action), or is signup unconditionally open? These are different products; pin one.
3. **Abuse bounding** — is anything needed at pre-alpha beyond "the admin can delete it"?
4. **What creates the `Scopes` row?** `createStar` is admin-gated in-method ([:383](../packages/nebula-auth/src/nebula-auth-registry.ts), verified) and is therefore **not** the path — the open signup flow needs its own registry entry point that mints scope + founder together. Confirm no caller depends on `createStar` remaining the only star-creating path.

## Relationships
- 🚧 **GATED BY [nebula-confine-admin-bypass.md](nebula-confine-admin-bypass.md) — all phases.** Not merely sequencing: the confinement is what makes open self-signup safe (§Why the confinement is the ENABLER). Landing this first would make every self-signup tenant an admin of the app they joined.
- **Supersedes [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) Part 1** — its `TODO(self-signup)` is this task's step 3. Part 2 (last-admin protection) is unaffected.
- **Overlaps [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md)** — that task mints star-tier admins by *invite* (admin-authorized). Same principal shape, different provenance. Neither blocks the other.
- **Releases the fixture re-grounding.** The gating task's Phase 0 left ~30 baseline fixtures asking for "an admin at this star" and receiving a **universe** admin — the only thing mintable today. ⚠️ Do the **intent-split** (`adminClientAt(scope)` vs `universeAdminClient(universe, activeScope)`) in the gating task *before* this lands, so re-grounding is one helper body rather than ~30 call sites. `scope-binding.test.ts` is a second consumer of that split.
