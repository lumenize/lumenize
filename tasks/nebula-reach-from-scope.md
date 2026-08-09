# Reach derives from the scope, not a pattern

**Status:** Active child, **next in the queue** — ahead of [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md), whose design intent is written entirely in the vocabulary this replaces. Decided with Larry 2026-08-05. Not built, except the `isAdmin` → `scopeAdmin` rename, which landed 2026-08-07 (§ *The target*).

> 📐 **`/write-task` Pass 1 — design intent is below, phases are NOT written.** From here: `/review-task` **Stage 1** on this phase-less file → resolve and edit → write phases → **Stage 2**. § *Acceptance criteria* is Pass-2 input.

> ✅ **NOT wipe-gated, and that is verified rather than assumed.** `authScopePattern` appears nowhere in `schemas.ts`; the KV refresh record stores `universeGalaxyStarId`; the pattern is re-derived on every token issuance and persisted nowhere. **No stored data changes shape**, so this does not have to race the pre-alpha wipe. It is sequenced early for unlearning cost, not for a window.

**Objective — a token carries the member's scope, and reach is computed from it.** One string, the same one that is in the URL and the `Memberships` row. No second derived string, no wildcard grammar.

## Context and current state

**Built already** — verified against disk 2026-08-05:

- **A derived second string.** `buildAuthScopePattern(instanceName)` turns a member's scope into a pattern at **token** issuance — login and every refresh — and the result goes in the JWT as `access.authScopePattern`. Star tier passes through unchanged; universe and galaxy get `.*` appended; the reserved `nebula-platform` becomes `*`.
- **A glob matcher.** `matchAccess(pattern, target)` has three branches: `*` matches everything, `prefix.*` matches the prefix itself and anything beneath, otherwise exact string equality.
- **The authority predicate.** `hasAdminOverScope(access, scope)` = `access.scopeAdmin && matchAccess(access.authScopePattern, scope)`, delegated to by `requireAdmin`, `requirePermission`'s bypass, and `enforceScopeReach`.
- **A SECOND enforcement surface, on the registry's HTTP routes.** `router.ts:359` gates every scoped registry route with a bare `matchAccess(payload.access.authScopePattern, instanceName)` and **no `scopeAdmin` conjunction** — so a non-admin at `{u}` passes it for `{u}.{g}.{s}` today. That is `Missing` item 3 again, on the surface this file had not named. ⚠️ **Both the obvious translation and the obvious fix are wrong here:** swapping in a hierarchy predicate keeps the hole (`{u}` is still at-or-above `{u}.{g}.{s}`), and adding a bare `scopeAdmin &&` would refuse a non-admin at their **own** scope. The site needs the same *two ways in* the mesh boundary uses.
- **Two directions, expressed identically.** `enforceScopeReach` admits on either (a) *higher-admin reach* — `admin` plus the caller's pattern covers this node — or (c/e) *the tenant boundary* — a pattern built from **this node's own name** covers the caller's `aud`. The second is a child reaching its parent, and it confers no authority (ADR-015 clause 3).

**Missing:**

1. **One fact is carried by two strings.** The scope lives in the URL and in `Memberships.universeGalaxyStarId`; the JWT carries something derived from it that exists nowhere else. A reader must hold the derivation in their head to reconcile the three.
2. **The two directions look like one mechanism.** Both are glob matches against `buildAuthScopePattern` output. Nothing in the shape of the code says one grants authority and the other deliberately does not.
3. **Non-admin downward reach exists and has no consumer.** ✅ **No separate work — it falls out of the upward-branch substitution.** Only that branch reads `aud`; comparing against the member's scope instead refuses `{u}.{g}.{s}` for a non-admin at `{u}` by construction. Keep the behaviour criterion; do not decompose this into its own phase. A non-admin at `{u}` is admitted to every Star in the Universe and authorized at none — pure disclosure surface (ADR-008 makes the org tree and presence visible to Star-reachable callers) with no use case behind it.

## Design intent, constraints, and future state

### The target

**Two ways in, and the direction is the meaning** — the same statement `docs/vision/auth.md` § *Coarse-grained access control* makes, which is `accepted` and therefore the wording to conform to:

- **The node is your own scope, or an ancestor of it.** Free; no `scopeAdmin` needed. This is **admission**, and it confers nothing (ADR-015 clause 3).
- **The node is a descendant of your scope, and `scopeAdmin` is set.** The only way to reach *downward*, and the only one that carries **authority**.

In one line: your scope and the node called must be on the same vertical line, upward is free, and downward needs `scopeAdmin`.

One predicate expresses it, and **no site re-derives it** (ADR-007):

```
authority(access, node) = access.scopeAdmin ∧ ( isPlatformInstance(access.authScope)
                                              ∨ isAtOrAbove(access.authScope, node) )

admitted(access, node)  = isAtOrAbove(node, access.authScope) ∨ authority(access, node)
```

⚠️ **`admitted` is the UNION, not the upward arm alone.** An admin at `{u}` calling `{u}.{g}.{s}` is admitted *because* they hold authority there — writing admission as upward-only refuses the whole downward rule, and contradicts every downward criterion below.

`buildAuthScopePattern` is deleted. `matchAccess`'s glob grammar becomes a hierarchy predicate. The claim becomes **`access.authScope`**, holding the member's scope verbatim.

#### Platform, and the claims-shape blast radius

**A super-admin is an ordinary membership at the reserved scope `nebula-platform`** ([nebula-auth-registry.ts:717](../packages/nebula-auth/src/nebula-auth-registry.ts) mints it only for a configured bootstrap email at that exact scope). So `authScope` carries **`nebula-platform` verbatim** — the `'*'` sentinel was the *derived* value and disappears with the derivation. Not a wildcard, and emphatically not an empty string, which would be falsy and would grant everything on a mis-default.

The predicate therefore needs an explicitly named branch, because `isAtOrAbove('nebula-platform', 'acme.crm')` is **false** under any honest hierarchy comparison:

```
authority(access, node) = access.scopeAdmin ∧ ( isPlatformInstance(access.authScope) ∨ isAtOrAbove(access.authScope, node) )
```

`isPlatformInstance` already exists ([parse-id.ts:85](../packages/nebula-auth/src/parse-id.ts)), so the four `'*'` fixtures rename to `authScope: 'nebula-platform'` — **a value production can actually mint**, which is what stops them going green over broken authorization.

⚠️ **This is the change's largest silent-failure surface, and a superuser is the case that breaks.** Today `matchAccess('*', …)` is true, so every site that touches the pattern treats a superuser as reaching everywhere *without knowing it*. Afterwards, any site that does not carry the platform branch stops recognizing them. **The invariant to hold: a superuser is authorized at every scope, may point `aud` at any scope, passes every registry route, and enumerates every scope** — a Universe admin of every Universe, plus the platform-named surfaces.

Enumerate with `grep -rn 'hasAdminOverScope\|matchAccess\|=== .\*.' packages/*/src apps/*/src` and give **every hit a verdict by class**, not by site list:

1. **Routes through the authority predicate** — safe by construction once the branch is in the shared predicate, and the largest class. `requireAdmin` / `enforceScopeReach`'s admin arm, the Data-plane bypass, both subscribe-time confinement points, the mint's eligibility check, and the registry's admin helpers all land here.
2. **Calls the containment check DIRECTLY, outside the conjunction** — each needs its own verdict, and this is where the regressions live. ⚠️ **[`verify.ts:48`](../packages/nebula-auth/src/verify.ts) is the one to fix first: it is token *verification*, so leaving it unconverted does not degrade a superuser's authority — it makes a superuser token fail to verify at all.** Same shape at the mint-time `aud` check, the refresh-path `activeScope` check, both `/mint-narrower-token` bounds, and the registry route gate.
3. **Literal `'*'` comparisons** — the accept-all branch inside `matchAccess`, the Profile super-admin zero-read short-circuit, and `myScopeTree`'s select-every-scope arm. Each becomes `isPlatformInstance(...)`.

⚠️ **The mesh boundary keeps its platform-name reject, re-justified.** [nebula-do.ts:113](../apps/nebula/src/nebula-do.ts) refuses every caller at a node *named* `nebula-platform`, and its comment justifies that entirely by the `'*'` collapse this file deletes — but the guard's real reason survives independently: **no node may be reachable by masquerading at the reserved name.** Rewrite the comment; do not remove the branch.

⚠️ **`isAtOrAbove` compares WHOLE dot-separated segments — this is part of the contract, not an implementation detail.** The obvious `b === a || b.startsWith(a)` type-checks, passes every behavioural criterion below, and silently makes `u.g.s1` cover `u.g.s10` and `acme` cover `acme-2` — both legal slugs. Today the boundary is closed explicitly in two independent places (`parse-id.ts:148` `startsWith(prefix + '.')`, `nebula-auth-registry.ts:688` `LIKE prefix + '.%'`); the replacement owes the same guarantee. Lateral containment is what `docs/vision/auth.md` calls "the case this whole layer is built around.

⚠️ **The rename drops `Pattern` and nothing else, deliberately.** What changed is that the value stopped being a pattern; it did not stop being an auth scope. `authScopePattern → scope` would overstate the change and collide with `aud`, which is also a scope — and it would force every reader of `docs/vision/auth.md`, which calls it `authScope` throughout, to hold a translation.

✅ **DONE 2026-08-07, ahead of the rest of this file: `isAdmin` → `scopeAdmin`, at rest and in flight.** Type-check green; 66 files. ⚠️ `packages/auth` and `packages/mesh` keep their own `isAdmin` — a *different* bit (auth's `Subjects` column, and a flat top-level claim mesh mints for auth's gate), and a repo-wide replace would have broken both, the mesh one silently. The rationale, for the record: the bit used to be spelled `Memberships.isAdmin` and `RefreshTokenKV.isAdmin` in storage but `access.admin` on the token, so every reader held a second translation on top of the first. There is now one spelling everywhere, and whether a sentence means the stored column or the claim has stopped mattering.

⚠️ **`scopeAdmin`, not `admin` — the qualifier is the whole point (decided with Larry 2026-08-07).** The word `admin` is doing two unrelated jobs: this bit, which is authority over a **scope** (Universe/Galaxy/Star), and the Data-plane's `admin` **grant on an orgTree node**. They live on different trees and mixing them has already produced a coding mistake. As of 2026-08-06 `docs/vision/auth.md` was paying for the collision repeatedly: a blockquote whose only job was to say the two `admin`s are different, plus prose forced to qualify the word at each mention. That blockquote is gone from the rewritten doc, which is the rename working rather than evidence going missing. Per `calibration.md` § *Name for the reader*, needing to explain a name once **is** the evidence to rename it, and a glossary entry is the tell.

⚠️ **Rename THIS side, never the Data-plane's.** That permission is one of a symmetric triple (`CHECK(permission IN ('admin', 'write', 'read'))`), so renaming it drags `resourceWrite` and `resourceRead` along for no gain. This bit is a lone field.

✅ **`scope` is a qualifier, not a prefix, so the prefix-free precedent stands.** `isAdmin` was the outlier because `is` is a type marker carrying no meaning, unlike `Emails.emailVerified` / `Memberships.acceptedAt`; `scope` names which tree the authority is over, which is the disambiguation being bought. The convergence argument is untouched — `scopeAdmin` is still one spelling at rest and in flight, alongside `profileId` and `authScope`. ⚠️ **`registryAdmin` was considered and rejected**: it names where the bit is *stored* rather than what it is authority *over*, and it is actively wrong, since this bit reaches into the Data-plane through the bypass.

✅ **Free now, expensive later, for the same reason as everything else in this file** — nothing about the bit's *value* changes, only its spelling, and the wipe clears both the table and every KV refresh record. Nothing needs migrating. The target changed before the sweep ran, so this costs one string, not a second pass.

### The conjunction survives — state this or the change becomes a vulnerability

⚠️ **This is NOT "`scopeAdmin` is the reach-relevant bit."** That paraphrase is one careless step from *the bare bit is authority*, which has **already shipped twice** (the `access.admin` upward leak, and `#computeDeletionPlan`'s downward veto). Authority stays a conjunction; only its second operand gets simpler. **The scope is still the bound** — it is what stops a `{u}.{g}` admin reaching `{u2}` — and it is as trustworthy as the pattern was, because the pattern was only ever derived from it.

`security.md`'s delegation rules and ADR-015 both say *"the bare `admin` bit is never authority by itself."* That sentence becomes **more** load-bearing here, not less, because the bit becomes the only distinguishing claim. The amendment must say so at the site.

### What this buys

- **Three places, one string.** URL, `Memberships` row, JWT. Nothing to reconcile.
- **The two directions become legible.** Same predicate, opposite arguments; ADR-015's clauses stop needing to be memorized.
- **`discover` becomes complete.** It returns the scopes a person holds memberships in, read from the registry, and it cannot see DAG grants (those live in each Star's DagTree, which the registry cannot reach). Today a teammate with one high-tier non-admin membership shows up as one entry while the truth about where they can work is scattered across N DagTrees with no index. Afterwards, membership *is* the answer, and a scope picker can show it.
- **A residual we were about to accept disappears.** [nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md) used to reason that the minimum-privilege collaborator must over-reach into tenant Stars, and filed it as a disclosure question to decide. Under this model there is no downward reach without `scopeAdmin`, so the question stops existing rather than getting answered — that file has already been rewritten on this basis (its § *Two memberships, two sessions*, 2026-08-05), which is why it now depends on this one landing.

### Cost, accepted

**A person who works in N scopes needs N memberships and N sessions**, where a high-tier non-admin membership would have covered them with one. Grants are unaffected — DAG grants are per-node under both models, so this costs sessions, not permissions.

Accepted for three reasons: the surfaces are usually already separate (Studio on the Galaxy, preview on the `.dev` Star); each membership carries its own acceptance, which is a real per-scope consent moment and reads well to an enterprise buyer; and it is what makes `discover` honest. ⚠️ **The one friction is N invite emails** — `Memberships.acceptedAt` is set only by consuming a link delivered to the mailbox, and per-membership acceptance is load-bearing (it is ADR-012's manufacture defense), so it cannot be waived because the address is verified elsewhere. **If that ever bites, the fix is a multi-invite-in-one-email flow, and Larry's read is that it is years away** (2026-08-05).

### Constraints

- **[ADR-015](../docs/adr/015-scope-authority-flows-downward.md)** — this **amends** it. The commitment is unchanged (downward total, upward nil, admission ≠ authority); what changes is **every normative sentence that names a pattern** — Context, clause 1, clause 2's parenthetical, the Mechanism paragraph, the Consequences self-signup sentence, **and the rejected-alternative row**. `Proposed` status makes amending from build work the intended path, so no ratification gate applies.
  - ⚠️ **The rejected-alternative row forbids this exact change, and retiring it needs saying out loud.** ADR-015 rejects *"close the upward leak by tightening `enforceScopeReach`'s tenant branch"* on the grounds that *"narrowing it breaks legitimate non-admin upward reads."* That harm cannot occur under the new rule: `docs/vision/auth.md` § *Coarse-grained access control* — **`accepted`**, where ADR-015 is only `Proposed` — preserves that read as its own table row (a non-admin at `{u}.{g}` reaching `{u}`, whose consumer is the guidance hierarchy) while refusing the descendant case this file deletes. Cite those rows rather than re-arguing it; per `docs/adr/README.md` a conflict while `Proposed` is case (a), *change the decision*, which is the intended path rather than an override.
  - ⚠️ **`calibration.md` §4 is NOT amended, and MUST NOT be.** It cites the same prohibition from `tasks/archive/nebula-confine-admin-bypass.md` (frozen, so uneditable) to make a different point: *do not delete the branch because the comment defending it was wrong*. The branch survives here — its purpose, a child reaching its parent, is the upward rule — and only its **input** changes, from the client-chosen `aud` to the server-trusted `authScope`. Read the two prohibitions as one and the likely "fix" is deleting a branch that lesson correctly defends.
- **`security.md`** — the four mint-side invariants for `/mint-narrower-token` are written in pattern terms and must be restated in scope terms. ⚠️ **The binding rule, stated once because the faithful-looking translation is the dangerous one: the mint's bounds are the AUTHORITY predicate — `scopeAdmin` ∧ scope-at-or-above — never the admission one.** Minting confers authority, and authority is downward-only (ADR-015 clause 1); admission may run upward and grants nothing there (clause 3), so it can never widen a mint. Restated in scope terms the four are:
  - **(a)** `activeScope` is at-or-below the **caller's** scope, and the caller holds `scopeAdmin`.
  - **(b)** `activeScope` is *also* at-or-below the **subject's** scope, so the token mirrors that person rather than merely something inside the caller's authority.
  - **(c)** the minted bit is `caller.scopeAdmin && subject.scopeAdmin` — an **intersection**, never either side's copy.
  - **(d)** the subject is a *different* `sub`, and the caller holds authority over the **subject's** scope.
  ⚠️ **Read (a) or (b) as "within X's *reach*" and a `{u}.{g}` admin impersonating a `{u}.{g}.{s}` subject can mint `activeScope = {u}` — a universe-admin token.** Today only (b) blocks that, and (b) is written entirely over `buildAuthScopePattern`, which this task deletes. `docs/vision/auth.md` § *Impersonation*: impersonation "is never an escalation."
- ⚠️ **Vocabulary: this file MUST NOT say "reach" for both directions.** Say **admission** for the upward, authority-free direction and **authority** for the downward one. The two are separated in § *The target*'s predicate block and nowhere else, which is what makes the mint mistranslation available. This is the same defect the file already fixed for `admin` → `scopeAdmin`: one word doing two unrelated jobs has already produced a coding mistake here.
- **[`docs/vision/auth.md`](../docs/vision/auth.md) — `status: accepted`.** Its § *Coarse-grained access control* already states this file's target model in present tense. Per `docs/vision/_review-lens.md` § *Status convention*, contradicting an accepted doc is a **blocker**, so that section is the statement to conform to rather than a reference to consult. The deliverable here is deleting its `> **Today's code differs.**` blockquote, not rewriting its prose.
- **[ADR-008](../docs/adr/008-full-org-tree-visibility.md)** — unchanged, but its blast radius shrinks: fewer callers are Star-reachable.
- ⚠️ **`aud` stays on the token and on the wire — this phase touches the reach decision ONLY.** `NebulaClientGateway.onBeforeCallToClient` compares the originating call's `aud` to the receiving connection's and refuses a mismatch, so a call out to a client reaches only connections in that scope. `authScope` cannot replace it: two tabs of one Galaxy admin on sibling Stars share `authScope` and `scopeAdmin`, so comparing those would deliver one tenant's subscription updates to the other. Removing or stripping `aud` is out of scope and would be a cross-tenant disclosure bug.
- **`verify.ts`'s internal-consistency check is KEPT, and re-worded.** `matchAccess(authScopePattern, aud)` stops guarding reach — reach no longer reads `aud` — and starts guarding only the token-internal invariant the Gateway's outbound fence assumes. Its comment currently claims a reach purpose and must not survive that way.
- **Pre-alpha** — no users, and not wipe-gated, so the claim rename is free now and a compatibility problem later.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **Reach is computed from the member's scope plus `scopeAdmin`** | The derived wildcard pattern — two strings for one fact, the second existing only inside a token, which is what makes the model hard to hold. It cost a full morning of review time on 2026-08-05 to reconstruct. |
| **Authority stays a conjunction** — `scopeAdmin` ∧ scope-at-or-above | *"`scopeAdmin` is the only reach-relevant bit"* — true as a summary, fatal as an implementation. It is the ADR-015 violation that has shipped twice. |
| **Non-admin downward reach is dropped** | Keeping it — it has no consumer, and it is exactly the tenant-Star admission the collaborator design was about to accept as a residual. |
| **Platform is a named special case** | A wildcard that covers it incidentally — the reserved name is not a hierarchical scope, and saying so once is clearer than a grammar that hides it. |
| **The claim is renamed off `authScopePattern`** | Keeping the name — it asserts a pattern that no longer exists, and a name that has to be explained is the rename signal (calibration §5). |
| **`isAdmin` → `scopeAdmin` in the same pass**, so the bit has one spelling at rest and in flight | Keeping `isAdmin` in storage while the token says `admin` — one concept, two spellings, and a translation every reader carries. Also rejected: renaming the token's `access.admin` to `isAdmin` instead, which would fight the repo's own prefix-free precedent (`emailVerified`, `acceptedAt`) and break the convergence `profileId` and `authScope` already have. |
| **A derived token carries the SUBJECT's membership scope**, so it is what that person would have minted, modulo `act` | Deriving it from `activeScope` (today's behaviour) — least-privilege that protects nothing, since the admin already holds total downward authority as themselves, while costing simulation fidelity: `myScopeTree` would show the impersonator a different scope picker than the subject sees. |
| **The upward rule reads `authScope`; `activeScope` leaves the security model entirely** | Deciding reach on `activeScope` — it is not independent (the refresh mint already confines it inside `authScope`), so a security decision on it is a decision on a derived value, and it puts load-bearing authorization inside a token endpoint where no authz reviewer would look. Verified against all rows of `auth.md`'s table: every verdict reproduces, and the two rows differing only in `activeScope` collapse. |
| **Land it before identity-mint's review** | After the collapse — every week adds surface describing the old model, and the collapse adds more. Five files already describe it. |

## Acceptance criteria — input to Pass 2, not yet decomposed into phases

- **A non-admin reaches its own scope and nothing beneath it.** A non-admin at `{u}` is admitted at `{u}` and refused at `{u}.{g}` and `{u}.{g}.{s}`. *Reds against retaining downward reach for non-admins.*
- **An admin reaches downward, totally.** An admin at `{u}` is admitted with authority at `{u}`, `{u}.{g}`, and `{u}.{g}.{s}`, including scopes created after the token was minted. *Reds against dropping the downward rule.*
- **Upward is nil for authority.** An admin at `{u}.{g}` is refused **as admin** at `{u}`. *Reds against a symmetric predicate.*
- 🔒 **The scope is still the bound.** An admin at `{u1}` is refused everywhere in `{u2}`. *Reds against a predicate that reads `scopeAdmin` without the scope — the "bare bit is authority" bug, and the one this change makes easiest to write.*
- **The tenant direction survives, without authority.** A Star member whose `authScope` is that Star is admitted to its parent Galaxy DO, and is then denied at the point of action. *Reds against collapsing both directions into one rule.*
- **`aud` survives on the token and on the wire.** A call out to a client is still refused when the originating call's `aud` differs from the receiving connection's. *Reds against "reach no longer reads `aud`" being over-applied into removing the claim — which would cross-deliver one tenant's updates to another.*
- **Platform means everywhere.** A `nebula-platform` admin reaches every scope including the platform instance itself. *Reds against a hierarchy predicate that has no case for a non-hierarchical name.*
- 🔒 **Segment boundaries hold under colliding names.** A member or admin at `{u}.{g}.{s}1` is refused at `{u}.{g}.{s}10`; an admin at `{u}` is refused everywhere in `{u}-2`. *Reds against a prefix-match `isAtOrAbove` — the defect every other criterion here is blind to, because none of their scope names collide on a prefix.*
- 🔒 **The mint cannot widen.** A `{u}.{g}` admin impersonating a `{u}.{g}.{s}` subject is refused when requesting `activeScope = {u}`; the minted `scopeAdmin` is the intersection of caller and subject, never either side's copy; and no caller can mint outside the **subject's** scope. *Reds against restating mint invariant (a) or (b) in the admission sense — the privilege escalation this change makes easiest to write. No criterion exercised `/mint-narrower-token` before this one.*
- 🔒 **A superuser is unchanged everywhere.** A `nebula-platform` admin's token **verifies**; they are authorized at every scope; they may refresh to any `activeScope`; they pass every instance-scoped registry route; `myScopeTree` returns every scope; and they pass the Profile owner/admin gate with **zero registry reads**. *Reds against any consumer of `access` that lost the platform branch when `'*'` stopped being the value — and note the verification limb fails CLOSED and TOTAL, so a miss there is a superuser who cannot log in, not one who quietly loses admin.*
- **A mesh call to a node NAMED `nebula-platform` is still refused**, for that same superuser. *Reds against removing the platform-name reject once its `'*'`-collapse justification is re-derived away — the guard's reason is masquerade prevention, which survives the grammar.*
- **The registry's HTTP routes enforce the same two rules.** A non-admin at `{u}` gets `insufficient_scope` on an instance-scoped registry route for `{u}.{g}.{s}`, while still reaching its own scope's routes; an admin at `{u}` reaches both. *Reds against translating `router.ts`'s gate mechanically, which preserves exactly the reach this file exists to delete — on the one surface no other criterion covers.*
- 🔒 **A derived token is indistinguishable from a self-minted one.** An admin impersonating a subject whose membership sits **above** the chosen `activeScope` gets a token whose `authScope` is the **subject's membership**, whose `aud` is the chosen scope, and whose `myScopeTree` returns exactly what the subject's own token returns. *Reds against deriving `authScope` from `activeScope` — today's behaviour, and the one this decision changes.*
- **Enumeration is unchanged for an admin.** `myScopeTree` returns the same set before and after, for the same identity. *Reds against a bound that narrows the query.*
- 🌐 **The same, driven as a `/live` scenario.** Real logins at two tiers, real sockets: a universe admin acts in a Star beneath, and a star-scoped member is refused at the Galaxy. ⚠️ **Fidelity, not capability** — pool-workers can assert the predicate, but only a real login proves the claim the *server actually minted* carries what the predicate expects, which is the half a hand-built token cannot check.
- **No `authScopePattern` survives.** `grep -rn 'authScopePattern' packages apps` returns nothing outside archived task files. Eyeball the remainder.
- ✅ **No `isAdmin` survives — already satisfied (2026-08-07).** `grep -rn 'isAdmin' packages/nebula-auth/src apps/nebula/src` returns **0**; the column, the KV record field, every parameter and every return shape now spell it `scopeAdmin`. Kept as a regression check rather than work. ⚠️ **Eyeball any future hit:** the same grep also finds the data-plane's `'admin'` permission tier, a different concept that keeps its name, and `packages/auth`/`packages/mesh` keep their own unrelated `isAdmin`. A hit is only wrong if it is the Registry bit.
- **No standing-guidance statement forbids narrowing `enforceScopeReach`'s tenant branch**, and ADR-015's amended text carries clause 2 restated over `scopeAdmin` ∧ scope-at-or-above plus the impersonation answer. ⚠️ `calibration.md` §4 is untouched and still correct — confirm its lesson still reads as "the branch was right", because the branch survives with a different input. *Reds against amending only ADR-015's Mechanism paragraph, which names the one function that survives.*
- **No standing-guidance statement describes the pattern model.** ⚠️ State it structurally — *no rule or ADR describes reach as a derived pattern* — not as a list of files, which goes stale as the diff grows. ADR-015's mechanism, **ADR-016's normative record contents**, `security.md`'s mint-side invariants and `workflow.md`'s ADR-015 one-liner are the known sites. ⚠️ **"Standing guidance" is the CLAUDE.md list, not just `.claude/rules/` + `docs/adr/`** — it also includes **`.claude/skills/*/SKILL.md`** and **agent memory**, and the 2026-08-09 `scopeAdmin` sweep found a stale claim in each (`live/SKILL.md`'s `superadmin-reach` line; `MEMORY.md`'s entry for *this file*, which described the rename with the wrong target name). Neither surface is reachable by any grep over `.claude/rules docs/adr tasks`, and **memory is the worst of them** — it loads every session unprompted and nothing type-checks it. Sweep both explicitly.
- **`docs/vision/auth.md`'s gaps are closed.** Both of its `> **Today's code differs.**` blockquotes about this model — in § *Coarse-grained access control* and § *The Registry* — are deleted, and `grep -n '^> \*\*Today' docs/vision/auth.md` returns no entry for either. Its prose needs no edit; it already describes the target on both surfaces.
- **`nebula-pre-alpha.md`'s Super-admin building block states the new claims shape.** Its row still describes `authScopePattern:'*'` and *"`matchAccess('*', …)` always true"* as the mechanism; both go. ⚠️ That file is the **living master**, so it is read every session — leaving it describing the deleted model is the highest-traffic version of the unlearning cost this task exists to stop paying. (Its `scopeAdmin` spellings were swept 2026-08-09; only the `authScopePattern` mentions remain, at four sites.)
- **No active task file states authority as pattern-coverage.** `grep -rn 'authScopePattern\|pattern-covers' tasks/*.md tasks/on-hold/*.md tasks/icebox/*.md` returns nothing (frozen `tasks/archive/` is exempt). ⚠️ **The glob must cover `on-hold/` and `icebox/`, and that is load-bearing rather than tidy:** `nebula-collaborator-tiers.md` carries the deleted vocabulary in at least three places and **moved to `on-hold/` on 2026-08-09**, so a bare `tasks/*.md` now passes this criterion *because the file left the glob* — green while the prose it was written to catch sits untouched. Leaving those places re-anchors the next panel on the model this file deletes, which is the whole reason this lands before identity-mint's review.

## Non-goals

- **Changing anything stored.** `Memberships`, the KV refresh record, and the URL are already scope-shaped and stay exactly as they are.
- **Narrowing the export surface.** The replacement predicate is exported from both `index.ts` and `testing.ts`, as `hasAdminOverScope` is today — the Node harness re-exports it precisely so a test never re-inlines the `scopeAdmin ∧ scope-at-or-above` conjunction by hand. `buildAuthScopePattern` leaves both.
- **The invite mechanism** → [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md). This changes what a token derives from a membership, not how memberships are made.
- **The collaborator grant bundle** → [nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md).
- **A multi-invite-in-one-email flow** — the answer to the N-emails friction if it ever bites; years away.

## Relationships

- **Amends [ADR-015](../docs/adr/015-scope-authority-flows-downward.md)** — commitment intact, mechanism replaced. Stated as an amendment, per `/write-task` § *Relationships*.
- **Soft-blocks** [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md) — nothing in the invite mechanism depends on this, but that file's design intent and its tier-coverage criterion are written in pattern vocabulary, so reviewing it first would anchor a panel on a model this deletes.
- **Already relied upon by** [nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md) — its open question 1 was closed on this file's basis (2026-08-05) and its over-reach section rewritten to depend on this landing. The debt runs the other way, so shipping a different model would reopen that file — but it still carries the deleted vocabulary in at least three places (its ADR-015 constraint bullet, its first acceptance criterion, and § *Two memberships*), covered by the active-task-file criterion above.
- **Touches** [nebula-profile-accepted-membership-gate.md](nebula-profile-accepted-membership-gate.md) at **two** sites in `#requireOwnerOrAdmin`, not one: `profile.ts:309`'s `scopes.some(s => matchAccess(pattern, s))` becomes the new predicate, and `profile.ts:274`'s `authScopePattern === '*'` super-admin short-circuit loses the literal it tests. The accepted-membership contract is unaffected, but that file's own criterion is written over the deleted literal ("Super-admin (`pattern === '*'`) still short-circuits before any registry read") and must be re-worded over **behaviour** — *a platform admin passes with zero registry reads*.
- **Not related to the wipe.** Listed in [nebula-pre-alpha.md](nebula-pre-alpha.md) for sequencing only.
