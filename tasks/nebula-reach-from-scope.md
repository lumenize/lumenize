# Reach derives from the scope, not a pattern

**Status:** Active child, **next in the queue** — ahead of [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md), whose design intent is written entirely in the vocabulary this replaces. Decided with Larry 2026-08-05. Not yet built.

> 📐 **`/write-task` Pass 1 — design intent is below, phases are NOT written.** From here: `/review-task` **Stage 1** on this phase-less file → resolve and edit → write phases → **Stage 2**. § *Acceptance criteria* is Pass-2 input.

> ✅ **NOT wipe-gated, and that is verified rather than assumed.** `authScopePattern` appears nowhere in `schemas.ts`; the KV refresh record stores `universeGalaxyStarId`; the pattern is re-derived on every token issuance and persisted nowhere. **No stored data changes shape**, so this does not have to race the pre-alpha wipe. It is sequenced early for unlearning cost, not for a window.

**Objective — a token carries the member's scope, and reach is computed from it.** One string, the same one that is in the URL and the `Memberships` row. No second derived string, no wildcard grammar.

## Context and current state

**Built already** — verified against disk 2026-08-05:

- **A derived second string.** `buildAuthScopePattern(instanceName)` turns a member's scope into a pattern at **token** issuance — login and every refresh — and the result goes in the JWT as `access.authScopePattern`. Star tier passes through unchanged; universe and galaxy get `.*` appended; the reserved `nebula-platform` becomes `*`.
- **A glob matcher.** `matchAccess(pattern, target)` has three branches: `*` matches everything, `prefix.*` matches the prefix itself and anything beneath, otherwise exact string equality.
- **The authority predicate.** `hasAdminOverScope(access, scope)` = `access.admin && matchAccess(access.authScopePattern, scope)`, delegated to by `requireAdmin`, `requirePermission`'s bypass, and `enforceScopeReach`.
- **Two directions, expressed identically.** `enforceScopeReach` admits on either (a) *higher-admin reach* — `admin` plus the caller's pattern covers this node — or (c/e) *the tenant boundary* — a pattern built from **this node's own name** covers the caller's `aud`. The second is a child reaching its parent, and it confers no authority (ADR-015 clause 3).

**Missing:**

1. **One fact is carried by two strings.** The scope lives in the URL and in `Memberships.universeGalaxyStarId`; the JWT carries something derived from it that exists nowhere else. A reader must hold the derivation in their head to reconcile the three.
2. **The two directions look like one mechanism.** Both are glob matches against `buildAuthScopePattern` output. Nothing in the shape of the code says one grants authority and the other deliberately does not.
3. **Non-admin downward reach exists and has no consumer.** A non-admin at `{u}` is admitted to every Star in the Universe and authorized at none — pure disclosure surface (ADR-008 makes the org tree and presence visible to Star-reachable callers) with no use case behind it.

## Design intent, constraints, and future state

### The target

Two rules, one predicate, and the **direction is the meaning**:

```
authority at this node  =  admin  ∧  isAtOrAbove(my scope, this node)   — downward
admission at this node  =            isAtOrAbove(this node, my scope)   — upward, no authority
```

`buildAuthScopePattern` is deleted. `matchAccess`'s glob grammar becomes a hierarchy predicate. The claim becomes **`access.authScope`**, holding the member's scope verbatim.

⚠️ **The rename drops `Pattern` and nothing else, deliberately.** What changed is that the value stopped being a pattern; it did not stop being an auth scope. `authScopePattern → scope` would overstate the change and collide with `aud`, which is also a scope — and it would force every reader of `docs/vision/auth.md`, which calls it `authScope` throughout, to hold a translation.

**The sibling field is renamed in the same pass: `isAdmin` → `admin`, at rest and in flight.** Today the same bit is spelled `Memberships.isAdmin` and `RefreshTokenKV.isAdmin` in storage but `access.admin` on the token, so every reader holds a second translation on top of the first. Afterwards there is one spelling everywhere, and whether a sentence means the stored column or the claim stops mattering.

⚠️ **`admin` is the right name, not merely the shorter one.** The repo's own precedent in this very table set is prefix-free — `Emails.emailVerified`, `Memberships.acceptedAt` — so `isAdmin` was already the outlier. And this completes a convergence rather than starting one: `profileId` is already a single name at rest and on the wire, `authScope` becomes one above, and `admin` makes three for three.

✅ **Free now, expensive later, for the same reason as everything else in this file** — nothing about the bit's *value* changes, only its spelling, and the wipe clears both the table and every KV refresh record. Nothing needs migrating.

### The conjunction survives — state this or the change becomes a vulnerability

⚠️ **This is NOT "`isAdmin` is the reach-relevant bit."** That paraphrase is one careless step from *the bare bit is authority*, which has **already shipped twice** (the `access.admin` upward leak, and `#computeDeletionPlan`'s downward veto). Authority stays a conjunction; only its second operand gets simpler. **The scope is still the bound** — it is what stops a `{u}.{g}` admin reaching `{u2}` — and it is as trustworthy as the pattern was, because the pattern was only ever derived from it.

`security.md`'s delegation rules and ADR-015 both say *"the bare `admin` bit is never authority by itself."* That sentence becomes **more** load-bearing here, not less, because the bit becomes the only distinguishing claim. The amendment must say so at the site.

### What this buys

- **Three places, one string.** URL, `Memberships` row, JWT. Nothing to reconcile.
- **The two directions become legible.** Same predicate, opposite arguments; ADR-015's clauses stop needing to be memorized.
- **`discover` becomes complete.** It returns the scopes a person holds memberships in, read from the registry, and it cannot see DAG grants (those live in each Star's DagTree, which the registry cannot reach). Today a teammate with one high-tier non-admin membership shows up as one entry while the truth about where they can work is scattered across N DagTrees with no index. Afterwards, membership *is* the answer, and a scope picker can show it.
- **A residual we were about to accept disappears.** [nebula-collaborator-tiers.md](nebula-collaborator-tiers.md) currently reasons that the minimum-privilege collaborator must over-reach into tenant Stars, and files it as a disclosure question to decide. Under this model there is no downward reach without `admin`, so the question is answered by construction.

### Cost, accepted

**A person who works in N scopes needs N memberships and N sessions**, where a high-tier non-admin membership would have covered them with one. Grants are unaffected — DAG grants are per-node under both models, so this costs sessions, not permissions.

Accepted for three reasons: the surfaces are usually already separate (Studio on the Galaxy, preview on the `.dev` Star); each membership carries its own acceptance, which is a real per-scope consent moment and reads well to an enterprise buyer; and it is what makes `discover` honest. ⚠️ **The one friction is N invite emails** — `Memberships.acceptedAt` is set only by consuming a link delivered to the mailbox, and per-membership acceptance is load-bearing (it is ADR-012's manufacture defense), so it cannot be waived because the address is verified elsewhere. **If that ever bites, the fix is a multi-invite-in-one-email flow, and Larry's read is that it is years away** (2026-08-05).

### Constraints

- **[ADR-015](../docs/adr/015-scope-authority-flows-downward.md)** — this **amends** it. The commitment is unchanged (downward total, upward nil, admission ≠ authority); the mechanism it names changes. `Proposed` status makes amending from build work the intended path, so no ratification gate applies.
- **`security.md`** — the mint-side invariants for `/mint-narrower-token` are written in pattern terms and must be restated in scope terms without weakening any of the four.
- **[ADR-008](../docs/adr/008-full-org-tree-visibility.md)** — unchanged, but its blast radius shrinks: fewer callers are Star-reachable.
- **Pre-alpha** — no users, and not wipe-gated, so the claim rename is free now and a compatibility problem later.

### Future state

- ⚠️ **Design consideration:** `nebula-platform` sits outside the hierarchy, so it needs an explicitly named case — *admin at the platform scope means everywhere* — rather than a glob. One named exception is the target; a wildcard that happens to also mean this is not.
- The narrower-token mint keeps all four invariants; only how they are expressed changes.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **Reach is computed from the member's scope plus `isAdmin`** | The derived wildcard pattern — two strings for one fact, the second existing only inside a token, which is what makes the model hard to hold. It cost a full morning of review time on 2026-08-05 to reconstruct. |
| **Authority stays a conjunction** — `isAdmin` ∧ scope-at-or-above | *"`isAdmin` is the only reach-relevant bit"* — true as a summary, fatal as an implementation. It is the ADR-015 violation that has shipped twice. |
| **Non-admin downward reach is dropped** | Keeping it — it has no consumer, and it is exactly the tenant-Star admission the collaborator design was about to accept as a residual. |
| **Platform is a named special case** | A wildcard that covers it incidentally — the reserved name is not a hierarchical scope, and saying so once is clearer than a grammar that hides it. |
| **The claim is renamed off `authScopePattern`** | Keeping the name — it asserts a pattern that no longer exists, and a name that has to be explained is the rename signal (calibration §5). |
| **`isAdmin` → `admin` in the same pass**, so the bit has one spelling at rest and in flight | Keeping `isAdmin` in storage while the token says `admin` — one concept, two spellings, and a translation every reader carries. Also rejected: renaming the token's `access.admin` to `isAdmin` instead, which would fight the repo's own prefix-free precedent (`emailVerified`, `acceptedAt`) and break the convergence `profileId` and `authScope` already have. |
| **Land it before identity-mint's review** | After the collapse — every week adds surface describing the old model, and the collapse adds more. Five files already describe it. |

## Acceptance criteria — input to Pass 2, not yet decomposed into phases

- **A non-admin reaches its own scope and nothing beneath it.** A non-admin at `{u}` is admitted at `{u}` and refused at `{u}.{g}` and `{u}.{g}.{s}`. *Reds against retaining downward reach for non-admins.*
- **An admin reaches downward, totally.** An admin at `{u}` is admitted with authority at `{u}`, `{u}.{g}`, and `{u}.{g}.{s}`, including scopes created after the token was minted. *Reds against dropping the downward rule.*
- **Upward is nil for authority.** An admin at `{u}.{g}` is refused **as admin** at `{u}`. *Reds against a symmetric predicate.*
- 🔒 **The scope is still the bound.** An admin at `{u1}` is refused everywhere in `{u2}`. *Reds against a predicate that reads `isAdmin` without the scope — the "bare bit is authority" bug, and the one this change makes easiest to write.*
- **The tenant direction survives, without authority.** A Star member's `aud` is admitted to its parent Galaxy DO, and is then denied at the point of action. *Reds against collapsing both directions into one rule.*
- **Platform means everywhere.** A `nebula-platform` admin reaches every scope including the platform instance itself. *Reds against a hierarchy predicate that has no case for a non-hierarchical name.*
- **Enumeration is unchanged for an admin.** `myScopeTree` returns the same set before and after, for the same identity. *Reds against a bound that narrows the query.*
- 🌐 **The same, driven as a `/live` scenario.** Real logins at two tiers, real sockets: a universe admin acts in a Star beneath, and a star-scoped member is refused at the Galaxy. ⚠️ **Fidelity, not capability** — pool-workers can assert the predicate, but only a real login proves the claim the *server actually minted* carries what the predicate expects, which is the half a hand-built token cannot check.
- **No `authScopePattern` survives.** `grep -rn 'authScopePattern' packages apps` returns nothing outside archived task files. Eyeball the remainder.
- **No `isAdmin` survives either.** `grep -rn 'isAdmin' packages apps` returns nothing outside archived task files — the column, the KV record field, every parameter and every return shape now spell it `admin`. ⚠️ **Eyeball this one carefully:** the same grep also finds the data-plane's `'admin'` permission tier, which is a different concept that keeps its name. A hit is only wrong if it is the Registry bit.
- **No standing-guidance statement describes the pattern model.** ADR-015's mechanism, `security.md`'s mint-side invariants, `workflow.md`'s ADR-015 one-liner, and `docs/vision/auth.md` § *Reach*. ⚠️ State it structurally: *no rule or ADR describes reach as a derived pattern*, not a list of files, which goes stale as the diff grows.

## Non-goals

- **Changing anything stored.** `Memberships`, the KV refresh record, and the URL are already scope-shaped and stay exactly as they are.
- **The invite mechanism** → [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md). This changes what a token derives from a membership, not how memberships are made.
- **The collaborator grant bundle** → [nebula-collaborator-tiers.md](nebula-collaborator-tiers.md).
- **A multi-invite-in-one-email flow** — the answer to the N-emails friction if it ever bites; years away.

## Open questions

1. **Under impersonation, is `access.authScope` the SUBJECT's membership scope, or the `activeScope` the token was minted for?** *Gates the mint, and every guard that reads `access` on a derived token.*

   The two differ whenever the subject's membership sits **above** where the admin chose to act — a subject who is a member of `{u}`, acted as at `{u}.{g}`. Today's mint derives it from the activeScope (`authScopePattern: buildAuthScopePattern(body.activeScope)`), while this file's framing — *the claim carries the member's scope* — implies the membership. The phrasing was written without the derived-token case in mind, so it is under-specified rather than decided.

   ⚠️ **It is not cosmetic: it decides how far a derived token reaches.** Deriving from `activeScope` confines the token to the one place the admin pointed it. Deriving from the membership hands it the subject's whole subtree, which is *more faithful to the person* and *more than the admin asked for* — and those pull in opposite directions, which is exactly why it needs deciding rather than inferring.

   ✅ **Today's behaviour is defensible and should not be assumed a bug.** The mint already runs a faithfulness check bounding `activeScope` inside the subject's own reach, then derives the pattern from that — so the token is deliberately *narrower* than the person, which is the least-privilege reading. Whichever way this lands, say so in the ADR-015 amendment; the answer is not derivable from "the claim carries the member's scope" alone.

2. ✅ **DECIDED 2026-08-07 (Larry) — the upward rule reads `authScope`, and `activeScope` leaves the security model entirely.** `docs/vision/auth.md` § *Coarse-grained access control* now describes this, so the two arms below are settled; what remains open is the verification in the final bullet, which MUST run before the phases are written.

   The rule becomes: **the node is your own scope or an ancestor of it** (free), or **the node is a descendant of your scope and `admin` is set** (the only way down). `activeScope` is not consulted. The reasoning that produced it:

   `activeScope` is not independent: the refresh mint validates it against the session's server-trusted scope (`worker-token.ts` — `matchAccess(buildAuthScopePattern(record.universeGalaxyStarId), body.activeScope)`), so its legal range is fully determined by `authScope`. A security decision made on it is therefore a decision made on an **intermediate value** derived from `authScope`.

   Restating the upward rule as *"`authScope` at or below the node"* was checked against all eight rows of the `docs/vision/auth.md` table and reproduces every verdict — and it **collapses the two Downward rows into one**, which is correct, since they differ only in `activeScope` and have identical capability.

   ⚠️ **The argument is not elegance, it is where the control lives.** If reach reads `activeScope`, then the mint's `matchAccess` check *is* load-bearing authorization sitting in a token endpoint — a bug there becomes a reach bug, and nobody reviewing an authz change would think to look at it. If reach reads `authScope`, that check degrades to a UX nicety and `activeScope` becomes what it is meant to be: a view hint.

   ✅ **The codebase already agrees on the substantive point.** `/mint-narrower-token` performs real narrowing by narrowing the **pattern** (`authScopePattern: buildAuthScopePattern(body.activeScope)`), not by setting a narrower `aud` alone — so the mechanism that genuinely bounds a token already treats `authScope` as the bound and `activeScope` as the view.

   ✅ **Verified against the code 2026-08-07, and the decision stands.**

   - **Blast radius: nothing is lost.** `enforceScopeReach`'s admin branch (`hasAdminOverScope`) never reads `aud` at all, so a leaked *admin* token already reaches its whole `authScope` subtree today. For a non-admin, a node below your scope is refused under both models. There is no containment to forfeit.
   - **The substitution IS the fix for `Missing` item 3, not an extra change.** Only the upward branch reads `aud`. A non-admin at `{u}` may mint `aud={u}.{g}.{s}` (the mint accepts it — `{u}.*` covers it), and the node-derived exact pattern then matches that `aud`, which is precisely how the unconsumed downward reach arises. Comparing against the member's scope instead refuses it, because `{u}.{g}.{s}` is not at-or-above `{u}`. **This phase is smaller than written.**
   - ⚠️ **`aud` IS load-bearing elsewhere, and MUST NOT be removed from the token or stripped from the wire.** `NebulaClientGateway.onBeforeCallToClient` compares the originating call's `aud` to the connection's and rejects a mismatch, so a push produced in one scope reaches only connections in that same scope. `authScope` cannot replace it: two tabs of one Galaxy admin on sibling Stars share `authScope` and `admin`, so an `authScope` comparison would deliver one tenant's subscription updates to the other. **Scope this phase to the reach decision only.**
   - `verify.ts`'s internal-consistency check (`matchAccess(authScopePattern, aud)`) stops guarding reach and starts guarding only that invariant, which the Gateway's push routing assumes. Keep it; re-word its comment, which currently claims a reach purpose.

## Relationships

- **Amends [ADR-015](../docs/adr/015-scope-authority-flows-downward.md)** — commitment intact, mechanism replaced. Stated as an amendment, per § *Relationships* conventions.
- **Soft-blocks** [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md) — nothing in the invite mechanism depends on this, but that file's design intent and its tier-coverage criterion are written in pattern vocabulary, so reviewing it first would anchor a panel on a model this deletes.
- **Resolves** [nebula-collaborator-tiers.md](nebula-collaborator-tiers.md)'s open question 1, and deletes its § *The constraint that shapes everything*.
- **Touches** [nebula-profile-accepted-membership-gate.md](nebula-profile-accepted-membership-gate.md) at one site — `#requireOwnerOrAdmin`'s `scopes.some(s => matchAccess(pattern, s))` becomes the new predicate. The acceptance contract is unaffected.
- **Not related to the wipe.** Listed in [nebula-pre-alpha.md](nebula-pre-alpha.md) for sequencing only.
